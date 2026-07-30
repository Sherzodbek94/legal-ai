import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import {
  ProviderFailureError,
  type GenerationRequest,
  type GenerationResult,
  type LlmProvider,
} from './llm-provider.interface';

/**
 * OpenAI GPT-4o provider.
 *
 * Unlike the Anthropic provider, GPT-4o accepts `temperature`, so the
 * configured value (0.2 by default) is forwarded as-is.
 */
@Injectable()
export class OpenAiProvider implements LlmProvider {
  readonly name = 'openai' as const;
  readonly supportsTemperature = true;

  private readonly logger = new Logger(OpenAiProvider.name);
  private client?: OpenAI;

  constructor(private readonly config: ConfigService) {}

  get model(): string {
    return this.config.get<string>('OPENAI_MODEL', 'gpt-4o');
  }

  isConfigured(): boolean {
    return Boolean(this.config.get<string>('OPENAI_API_KEY'));
  }

  private getClient(): OpenAI {
    if (!this.client) {
      this.client = new OpenAI({
        apiKey: this.config.getOrThrow<string>('OPENAI_API_KEY'),
      });
    }
    return this.client;
  }

  async generate(request: GenerationRequest): Promise<GenerationResult> {
    try {
      const response = await this.getClient().chat.completions.create({
        model: this.model,
        max_tokens: request.maxTokens ?? 4096,
        temperature: request.temperature,
        messages: [
          { role: 'system', content: request.systemPrompt },
          { role: 'user', content: request.userPrompt },
        ],
        ...(request.jsonSchema
          ? {
              response_format: {
                type: 'json_schema' as const,
                json_schema: {
                  name: request.jsonSchema.name,
                  schema: request.jsonSchema.schema,
                  strict: true,
                },
              },
            }
          : {}),
      });

      const choice = response.choices[0];

      if (choice?.finish_reason === 'content_filter') {
        throw new ProviderFailureError(
          this.name,
          'Request was declined by the content filter',
          true,
        );
      }

      const text = choice?.message?.content ?? '';
      if (!text) {
        throw new ProviderFailureError(
          this.name,
          `Empty response (finish_reason: ${choice?.finish_reason})`,
          true,
        );
      }

      return {
        text,
        provider: this.name,
        model: response.model,
        usage: {
          inputTokens: response.usage?.prompt_tokens,
          outputTokens: response.usage?.completion_tokens,
        },
      };
    } catch (error) {
      if (error instanceof ProviderFailureError) throw error;
      throw this.translateError(error);
    }
  }

  private translateError(error: unknown): ProviderFailureError {
    const status = (error as { status?: number })?.status;
    const retryable = status === undefined || status === 429 || status >= 500;

    return new ProviderFailureError(
      this.name,
      `OpenAI request failed${status ? ` (HTTP ${status})` : ''}: ${
        (error as Error)?.message ?? 'unknown error'
      }`,
      retryable,
      error,
    );
  }
}
