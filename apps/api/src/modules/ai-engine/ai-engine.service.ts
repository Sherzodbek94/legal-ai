import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AnthropicProvider } from './providers/anthropic.provider';
import { OpenAiProvider } from './providers/openai.provider';
import {
  ProviderFailureError,
  type GenerationRequest,
  type GenerationResult,
  type LegalLocale,
  type LlmProvider,
  type LlmProviderName,
} from './providers/llm-provider.interface';
import { AiCostService } from '../admin/analytics/ai-cost.service';
import { buildLegalSystemPrompt } from './prompts/legal-system-prompt';
import { LEGAL_DOCUMENT_JSON_SCHEMA } from './schemas/legal-document.schema';
import { parseLegalDocument } from './parsers/legal-document.parser';
import type { LegalDocumentDraft } from './schemas/legal-document.schema';

export interface GenerateDocumentInput {
  locale: LegalLocale;
  documentType: string;
  /** Prompt variables (e.g. from mapCompanyToVariables). */
  variables: Record<string, string>;
  instructions?: string;
  /** Attribution for cost tracking; absent for internal calls. */
  companyId?: string;
  userId?: string;
}

export interface GenerateDocumentOutput {
  document: LegalDocumentDraft;
  provider: LlmProviderName;
  model: string;
  viaFallback: boolean;
  /** True when the raw output needed repair before it parsed. */
  repaired: boolean;
  usage?: GenerationResult['usage'];
}

/**
 * Default sampling temperature.
 *
 * Low but non-zero: legal drafting wants near-deterministic output, and 0
 * offers no real determinism guarantee anyway. Only providers that accept
 * sampling parameters receive it — see `LlmProvider.supportsTemperature`.
 */
const DEFAULT_TEMPERATURE = 0.2;

@Injectable()
export class AiEngineService {
  private readonly logger = new Logger(AiEngineService.name);

  constructor(
    private readonly anthropic: AnthropicProvider,
    private readonly openai: OpenAiProvider,
    private readonly config: ConfigService,
    private readonly aiCosts: AiCostService,
  ) {}

  private get temperature(): number {
    return this.config.get<number>('AI_TEMPERATURE', DEFAULT_TEMPERATURE);
  }

  /**
   * Providers in attempt order. The primary is configurable so a deployment
   * can switch vendors without a code change.
   */
  private get providerChain(): LlmProvider[] {
    const primary = this.config.get<LlmProviderName>(
      'AI_PRIMARY_PROVIDER',
      'anthropic',
    );

    const ordered: LlmProvider[] =
      primary === 'openai'
        ? [this.openai, this.anthropic]
        : [this.anthropic, this.openai];

    return ordered.filter((provider) => {
      if (provider.isConfigured()) return true;
      this.logger.warn(`Provider ${provider.name} skipped: no API key configured`);
      return false;
    });
  }

  async generateLegalDocument(
    input: GenerateDocumentInput,
  ): Promise<GenerateDocumentOutput> {
    const request: GenerationRequest = {
      systemPrompt: buildLegalSystemPrompt(input.locale),
      userPrompt: this.buildUserPrompt(input),
      jsonSchema: LEGAL_DOCUMENT_JSON_SCHEMA,
      temperature: this.temperature,
      maxTokens: this.config.get<number>('AI_MAX_TOKENS', 8192),
    };

    const result = await this.runWithFallback(request);

    // Recorded before parsing. The vendor charged for the tokens whether or not
    // the answer turned out to be usable, so a parse failure that skipped this
    // would understate the bill by exactly the calls that went wrong.
    await this.aiCosts.record({
      provider: result.provider,
      model: result.model,
      operation: 'document_generation',
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
      companyId: input.companyId,
      userId: input.userId,
    });

    const parsed = parseLegalDocument(result.text);

    if (!parsed.ok) {
      this.logger.error(
        `Failed to parse ${result.provider} output: ${parsed.error} — ${parsed.issues.join('; ')}`,
      );
      // 422 rather than 500: the request was valid, the model's answer was not.
      throw new UnprocessableEntityException(
        'The model returned an unusable document draft',
      );
    }

    return {
      document: parsed.document,
      provider: result.provider,
      model: result.model,
      viaFallback: result.viaFallback ?? false,
      repaired: parsed.repaired,
      usage: result.usage,
    };
  }

  /**
   * Tries each configured provider in turn.
   *
   * Only *retryable* failures advance to the next provider. A 400 means the
   * request itself is malformed, and re-sending it to another vendor would
   * burn a second call to reach the same conclusion.
   */
  private async runWithFallback(
    request: GenerationRequest,
  ): Promise<GenerationResult> {
    const chain = this.providerChain;

    if (chain.length === 0) {
      throw new ServiceUnavailableException(
        'No AI provider is configured',
      );
    }

    const failures: string[] = [];

    for (const [index, provider] of chain.entries()) {
      const isFallback = index > 0;

      try {
        const result = await provider.generate({
          ...request,
          // Drop the parameter entirely for providers that reject it.
          temperature: provider.supportsTemperature
            ? request.temperature
            : undefined,
        });

        if (isFallback) {
          this.logger.warn(
            `Primary provider failed; served by fallback ${provider.name}`,
          );
        }

        return { ...result, viaFallback: isFallback };
      } catch (error) {
        const failure =
          error instanceof ProviderFailureError
            ? error
            : new ProviderFailureError(
                provider.name,
                (error as Error)?.message ?? 'unknown error',
                false,
                error,
              );

        failures.push(`${provider.name}: ${failure.message}`);
        this.logger.error(`Provider ${provider.name} failed: ${failure.message}`);

        if (!failure.retryable) {
          throw new UnprocessableEntityException(
            `AI request rejected: ${failure.message}`,
          );
        }
      }
    }

    throw new ServiceUnavailableException(
      `All AI providers failed. ${failures.join(' | ')}`,
    );
  }

  /**
   * Wraps caller-supplied values in explicit data blocks.
   *
   * The delimiters are what the system prompt's injection guard refers to:
   * variables come from company profiles that users control, so the prompt
   * must mark clearly where untrusted data begins and ends. Values are already
   * sanitized upstream by `mapCompanyToVariables`; this is the second layer.
   */
  private buildUserPrompt(input: GenerateDocumentInput): string {
    const variableLines = Object.entries(input.variables)
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n');

    return [
      `Document type: ${input.documentType}`,
      '',
      '<company_data>',
      variableLines,
      '</company_data>',
      '',
      '<request_data>',
      input.instructions ?? '(no additional instructions)',
      '</request_data>',
    ].join('\n');
  }
}
