import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import {
  ProviderFailureError,
  type GenerationRequest,
  type GenerationResult,
  type LlmProvider,
} from './llm-provider.interface';

/**
 * Anthropic Claude provider.
 *
 * MODEL CHOICE: `claude-3-5-sonnet` was requested but has been **retired** and
 * now returns 404 — its documented replacement is `claude-sonnet-5`, used here.
 *
 * TEMPERATURE: current Claude models reject `temperature` with HTTP 400, so
 * this provider reports `supportsTemperature = false` and never forwards it.
 * Output determinism comes from the strict JSON schema plus the constraints in
 * the system prompt; `effort` tunes reasoning depth instead.
 */
@Injectable()
export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic' as const;
  readonly supportsTemperature = false;

  private readonly logger = new Logger(AnthropicProvider.name);
  private client?: Anthropic;

  constructor(private readonly config: ConfigService) {}

  get model(): string {
    return this.config.get<string>('ANTHROPIC_MODEL', 'claude-sonnet-5');
  }

  private get effort(): 'low' | 'medium' | 'high' | 'xhigh' | 'max' {
    return this.config.get('ANTHROPIC_EFFORT', 'medium');
  }

  isConfigured(): boolean {
    return Boolean(this.config.get<string>('ANTHROPIC_API_KEY'));
  }

  private getClient(): Anthropic {
    if (!this.client) {
      this.client = new Anthropic({
        apiKey: this.config.getOrThrow<string>('ANTHROPIC_API_KEY'),
      });
    }
    return this.client;
  }

  async generate(request: GenerationRequest): Promise<GenerationResult> {
    if (request.temperature !== undefined) {
      this.logger.debug(
        `Ignoring temperature=${request.temperature}: ${this.model} rejects sampling parameters`,
      );
    }

    try {
      const response = await this.getClient().messages.create({
        model: this.model,
        max_tokens: request.maxTokens ?? 16000,
        system: request.systemPrompt,
        output_config: {
          effort: this.effort,
          ...(request.jsonSchema
            ? {
                format: {
                  type: 'json_schema' as const,
                  schema: request.jsonSchema.schema,
                },
              }
            : {}),
        },
        messages: [{ role: 'user', content: request.userPrompt }],
      });

      // Safety classifiers can decline with HTTP 200 and an empty content
      // array — check before indexing into content.
      if (response.stop_reason === 'refusal') {
        throw new ProviderFailureError(
          this.name,
          'Request was declined by content safety classifiers',
          // Another provider may accept it; a retry on this one will not.
          true,
        );
      }

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');

      if (!text) {
        throw new ProviderFailureError(
          this.name,
          `Empty response (stop_reason: ${response.stop_reason})`,
          true,
        );
      }

      return {
        text,
        provider: this.name,
        model: response.model,
        usage: {
          inputTokens: response.usage?.input_tokens,
          outputTokens: response.usage?.output_tokens,
        },
      };
    } catch (error) {
      if (error instanceof ProviderFailureError) throw error;
      throw this.translateError(error);
    }
  }

  private translateError(error: unknown): ProviderFailureError {
    const status = (error as { status?: number })?.status;
    // 4xx other than 429 means the request itself is wrong — failing over to
    // another provider would just repeat the same mistake.
    const retryable = status === undefined || status === 429 || status >= 500;

    return new ProviderFailureError(
      this.name,
      `Anthropic request failed${status ? ` (HTTP ${status})` : ''}: ${
        (error as Error)?.message ?? 'unknown error'
      }`,
      retryable,
      error,
    );
  }
}
