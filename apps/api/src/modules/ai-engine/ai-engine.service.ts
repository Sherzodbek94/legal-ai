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
import { redactPii, restorePii } from '../../common/pii/pii-redactor';
import { buildLegalSystemPrompt } from './prompts/legal-system-prompt';
import { LEGAL_DOCUMENT_JSON_SCHEMA } from './schemas/legal-document.schema';
import {
  LEGAL_TEMPLATE_JSON_SCHEMA,
  type LegalTemplateDraft,
} from './schemas/legal-template.schema';
import { buildTemplateSystemPrompt } from './prompts/legal-template-prompt';
import {
  templateDraftToContent,
  templateDraftToSchema,
  validateTemplateDraft,
  type TemplateDraftIssues,
} from './parsers/template-draft.validator';
import { parseLegalDocument } from './parsers/legal-document.parser';
import { extractJson } from './parsers/json-extraction';
import { sanitizePromptValue } from '../../common/prompt/sanitize-prompt-value';
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

export interface DraftTemplateInput {
  locale: LegalLocale;
  /** What kind of document, e.g. "tovar yetkazib berish shartnomasi". */
  documentType: string;
  /** BCP 47 for the text itself: `uz-Latn`, `uz-Cyrl`, `ru`. */
  language: string;
  /** Free-text requirements from the person requesting the template. */
  description?: string;
  /** Clauses the requester insists on. */
  mustInclude?: string[];
  companyId?: string;
  userId?: string;
}

export interface DraftTemplateOutput {
  draft: LegalTemplateDraft;
  /** Editor JSON, ready for a template version. */
  content: unknown;
  variableSchema: unknown;
  /** Disagreements between the text and the declared variables. */
  issues: TemplateDraftIssues;
  provider: LlmProviderName;
  model: string;
  usage?: GenerationResult['usage'];
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

  /**
   * Whether identifiers are stripped before a prompt leaves this process.
   *
   * On unless explicitly disabled. A deployment that genuinely needs the model
   * to see raw identifiers has to say so, rather than a deployment that wants
   * them protected having to remember to ask.
   */
  private get redactionEnabled(): boolean {
    return this.config.get<string>('AI_REDACT_PII', 'true') !== 'false';
  }

  async generateLegalDocument(
    input: GenerateDocumentInput,
  ): Promise<GenerateDocumentOutput> {
    const userPrompt = this.buildUserPrompt(input);

    /*
     * Identifiers are replaced with placeholders before the prompt leaves this
     * process, and put back into the answer when it returns.
     *
     * The prompt carries whatever the template variables held — routinely a
     * counterparty's settlement account, a director's passport number, a
     * client's phone. None of it changes how the model drafts a clause: the
     * wording is the same whether the account number is real or
     * `[BANK_ACCOUNT_1]`. Sending it is a disclosure to a third-party processor
     * that buys nothing.
     *
     * Placeholders rather than deletion, because the model still has to write
     * the value back where it belongs. `legal-system-prompt.ts` already forbids
     * inventing registry numbers in words; this makes it structurally
     * unnecessary for the model to try.
     */
    const { text: redactedPrompt, redactions } = this.redactionEnabled
      ? redactPii(userPrompt)
      : { text: userPrompt, redactions: [] };

    if (redactions.length > 0) {
      // Masked forms only — this line goes to the log.
      this.logger.log(
        `Redacted ${redactions.length} identifier(s) before generation: ` +
          redactions.map((r) => `${r.kind} ${r.masked}`).join(', '),
      );
    }

    const request: GenerationRequest = {
      systemPrompt: buildLegalSystemPrompt(input.locale),
      userPrompt: redactedPrompt,
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

    // Restored before parsing, not after: the answer is JSON, and putting the
    // values back into the raw text means every string field downstream —
    // clauses, party blocks, the title — carries the real identifier without
    // anything having to walk the parsed object looking for placeholders.
    //
    // Safe against the JSON: every identifier this detects is digits, letters,
    // `@`, `+`, or spaces, none of which can terminate a JSON string.
    const restored =
      redactions.length > 0 ? restorePii(result.text, userPrompt) : result.text;

    const parsed = parseLegalDocument(restored);

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
   * Drafts a reusable template.
   *
   * Distinct from `generateLegalDocument`, which produces finished text. This
   * produces text with `{{placeholders}}` in it *and* the variable declarations
   * that fill them — both halves in one answer, because asking for a document
   * and hunting for the variable-shaped parts afterwards does not work: the
   * model invents a party name and nothing downstream can tell it was meant to
   * be a placeholder.
   *
   * No PII redaction here, unlike document generation: the input is a
   * description of a document type, not a party's details, and a template that
   * carried real identifiers would be the bug rather than the leak.
   */
  async draftTemplate(input: DraftTemplateInput): Promise<DraftTemplateOutput> {
    const request: GenerationRequest = {
      systemPrompt: buildTemplateSystemPrompt(input.locale),
      userPrompt: this.buildTemplateUserPrompt(input),
      jsonSchema: LEGAL_TEMPLATE_JSON_SCHEMA,
      temperature: this.temperature,
      maxTokens: this.config.get<number>('AI_MAX_TOKENS', 8192),
    };

    const result = await this.runWithFallback(request);

    await this.aiCosts.record({
      provider: result.provider,
      model: result.model,
      operation: 'template_drafting',
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
      companyId: input.companyId,
      userId: input.userId,
    });

    // The same extractor the document parser uses: it strips code fences,
    // finds the first balanced JSON value, and repairs trailing commas — all of
    // which models still emit despite strict schema mode.
    const extracted = extractJson<LegalTemplateDraft>(result.text);

    if (!extracted.ok) {
      this.logger.error(
        `Failed to parse ${result.provider} template draft: ${extracted.error} — ${extracted.detail}`,
      );
      throw new UnprocessableEntityException(
        'The model returned an unusable template draft',
      );
    }

    const draft = extracted.value;

    if (!Array.isArray(draft?.sections) || !Array.isArray(draft?.variables)) {
      throw new UnprocessableEntityException(
        'The model returned an unusable template draft',
      );
    }

    const issues = validateTemplateDraft(draft);

    if (issues.undeclared.length > 0) {
      // Logged, not thrown. The draft is a proposal for a human to review, and
      // an undeclared placeholder is visible in the builder — losing an
      // otherwise good draft over one would be the worse outcome.
      this.logger.warn(
        `Template draft used undeclared variables: ${issues.undeclared.join(', ')}`,
      );
    }

    return {
      draft,
      content: templateDraftToContent(draft),
      variableSchema: templateDraftToSchema(draft.variables),
      issues,
      provider: result.provider,
      model: result.model,
      usage: result.usage,
    };
  }

  private buildTemplateUserPrompt(input: DraftTemplateInput): string {
    const lines = [
      `Hujjat turi: ${sanitizePromptValue(input.documentType, 200)}`,
      `Til: ${input.language}`,
    ];

    if (input.description) {
      lines.push(
        `Qo'shimcha talablar: ${sanitizePromptValue(input.description, 2000)}`,
      );
    }

    if (input.mustInclude?.length) {
      lines.push(
        `Albatta bo'lishi kerak: ${input.mustInclude
          .map((item) => sanitizePromptValue(item, 200))
          .join('; ')}`,
      );
    }

    return lines.join('\n');
  }


  /**
   * A free-text answer, for the legal chat.
   *
   * No JSON schema and no parser, unlike the other two entry points: a chat
   * answer is prose with `[S1]` markers in it, and forcing it through a schema
   * would buy nothing while costing the model the room to explain itself.
   *
   * The caller does the grounding — building the sources block, redacting, and
   * checking the citations — because those are chat concerns. This method's job
   * is the provider chain, the fallback, and the cost record.
   */
  async answerLegalQuestion(input: {
    systemPrompt: string;
    userPrompt: string;
    companyId?: string;
    userId?: string;
  }): Promise<{ text: string; provider: LlmProviderName; model: string }> {
    const result = await this.runWithFallback({
      systemPrompt: input.systemPrompt,
      userPrompt: input.userPrompt,
      temperature: this.temperature,
      // Shorter than a document draft. An answer that runs past this is not
      // being thorough, it is repeating the sources back.
      maxTokens: this.config.get<number>('AI_CHAT_MAX_TOKENS', 2048),
    });

    await this.aiCosts.record({
      provider: result.provider,
      model: result.model,
      operation: 'legal_chat',
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
      companyId: input.companyId,
      userId: input.userId,
    });

    return { text: result.text, provider: result.provider, model: result.model };
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
          // The vendor's own text is logged above and deliberately NOT sent on.
          // It carries their request id, their account state, and which vendor
          // this deployment uses — none of which the caller can act on, and the
          // authentication case ("invalid x-api-key") reads to a user as though
          // *they* did something wrong. A 401 from the vendor is a deployment
          // fault; a 400 is a prompt fault. Neither is the user's.
          throw new UnprocessableEntityException(
            isCredentialFailure(failure.message)
              ? 'AI drafting is unavailable on this deployment. Contact your administrator.'
              : 'The AI provider rejected this request.',
          );
        }
      }
    }

    // Same reasoning: the joined failure list is vendor text.
    throw new ServiceUnavailableException(
      'No AI provider could be reached. Try again shortly.',
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

/**
 * Whether a provider rejection is about *our* credentials.
 *
 * Separated because the two cases need different words. A bad key is a
 * deployment fault the user can only report; a rejected prompt is a fault in
 * the request. Telling a lawyer "invalid x-api-key" invites them to go looking
 * for something they did wrong.
 */
function isCredentialFailure(message: string): boolean {
  return /401|403|api[-_ ]?key|authentication|unauthorized|credential/i.test(
    message,
  );
}
