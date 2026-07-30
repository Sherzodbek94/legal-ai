/** Languages the engine generates legal documents in. */
export type LegalLocale = 'uz-Latn' | 'uz-Cyrl' | 'ru';

export type LlmProviderName = 'anthropic' | 'openai';

export interface JsonSchemaSpec {
  name: string;
  /** JSON Schema draft subset both providers accept for strict decoding. */
  schema: Record<string, unknown>;
}

export interface GenerationRequest {
  systemPrompt: string;
  userPrompt: string;
  /**
   * When set, the provider constrains decoding to this schema natively
   * (OpenAI `response_format`, Anthropic `output_config.format`).
   */
  jsonSchema?: JsonSchemaSpec;
  maxTokens?: number;
  /**
   * Sampling temperature. See `LlmProvider.supportsTemperature` — providers
   * that reject the parameter ignore this value rather than failing.
   */
  temperature?: number;
}

export interface GenerationResult {
  /** Raw assistant text; still parsed defensively even under strict decoding. */
  text: string;
  provider: LlmProviderName;
  model: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
  /** True when this result came from a fallback rather than the primary. */
  viaFallback?: boolean;
}

export interface LlmProvider {
  readonly name: LlmProviderName;
  readonly model: string;

  /**
   * Whether the provider's current model accepts a `temperature` value.
   *
   * This is not cosmetic: current Claude models **reject** a non-default
   * `temperature` with HTTP 400, so the value must be dropped rather than
   * forwarded. Callers set temperature once; each provider decides.
   */
  readonly supportsTemperature: boolean;

  /** False when the provider is missing credentials and must be skipped. */
  isConfigured(): boolean;

  generate(request: GenerationRequest): Promise<GenerationResult>;
}

/** Raised when a provider fails in a way worth trying another provider for. */
export class ProviderFailureError extends Error {
  constructor(
    readonly provider: LlmProviderName,
    message: string,
    readonly retryable: boolean,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ProviderFailureError';
  }
}
