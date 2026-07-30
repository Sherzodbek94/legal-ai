/**
 * Model pricing, for turning token counts into money.
 *
 * Vendor list prices change, and a stale table silently understates the bill —
 * so `resolvePricing` falls back to the most expensive entry for an unknown
 * model rather than to zero. Overstating an unknown cost prompts someone to
 * update this file; reporting zero means nobody notices for a quarter.
 *
 * Rates are micro-USD (millionths of a dollar) per million tokens, which is how
 * both vendors quote them, so the numbers below can be read straight off a
 * pricing page without conversion.
 */

export interface ModelPricing {
  /** Micro-USD per 1M input tokens. */
  inputPerMillion: number;
  /** Micro-USD per 1M output tokens. */
  outputPerMillion: number;
  /** Micro-USD per 1M cached input tokens, where the vendor discounts them. */
  cachedInputPerMillion: number;
}

const USD = 1_000_000;

/**
 * Prices as of this file's last review.
 *
 * NOTE: verify against the vendors' current pricing pages before relying on
 * these for invoicing or margin analysis. They are list prices and ignore any
 * negotiated discount.
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  // --- Anthropic ------------------------------------------------------------
  'claude-opus-5': {
    inputPerMillion: 15 * USD,
    outputPerMillion: 75 * USD,
    cachedInputPerMillion: 1.5 * USD,
  },
  'claude-sonnet-5': {
    inputPerMillion: 3 * USD,
    outputPerMillion: 15 * USD,
    cachedInputPerMillion: 0.3 * USD,
  },
  'claude-haiku-4-5': {
    inputPerMillion: 1 * USD,
    outputPerMillion: 5 * USD,
    cachedInputPerMillion: 0.1 * USD,
  },

  // --- OpenAI ---------------------------------------------------------------
  'gpt-4o': {
    inputPerMillion: 2.5 * USD,
    outputPerMillion: 10 * USD,
    cachedInputPerMillion: 1.25 * USD,
  },
  'gpt-4o-mini': {
    inputPerMillion: 0.15 * USD,
    outputPerMillion: 0.6 * USD,
    cachedInputPerMillion: 0.075 * USD,
  },
  'text-embedding-3-small': {
    inputPerMillion: 0.02 * USD,
    outputPerMillion: 0,
    cachedInputPerMillion: 0.02 * USD,
  },
};

/**
 * Pricing for a model id, tolerating the version suffixes vendors append.
 *
 * `claude-sonnet-5-20260101` should resolve to the `claude-sonnet-5` entry
 * rather than falling through to the unknown-model path on every call.
 */
export function resolvePricing(model: string): {
  pricing: ModelPricing;
  matched: boolean;
} {
  const normalized = model.trim().toLowerCase();

  const exact = MODEL_PRICING[normalized];
  if (exact) return { pricing: exact, matched: true };

  // Longest prefix wins, so `claude-haiku-4-5` is not shadowed by a shorter
  // `claude-haiku` entry if one is ever added.
  let best: { key: string; pricing: ModelPricing } | null = null;
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (normalized.startsWith(key) && (!best || key.length > best.key.length)) {
      best = { key, pricing };
    }
  }
  if (best) return { pricing: best.pricing, matched: true };

  return { pricing: mostExpensivePricing(), matched: false };
}

/** The conservative fallback: assume the worst until the table is updated. */
function mostExpensivePricing(): ModelPricing {
  return Object.values(MODEL_PRICING).reduce((worst, candidate) =>
    candidate.outputPerMillion > worst.outputPerMillion ? candidate : worst,
  );
}

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

/**
 * Cost of one call, in micro-USD.
 *
 * Rounded once at the end rather than per component: rounding each of three
 * terms and summing them drifts by up to a micro-dollar per call, which over
 * millions of calls is a real discrepancy against the vendor invoice.
 */
export function computeCostMicroUsd(
  model: string,
  tokens: TokenCounts,
): { costMicroUsd: number; pricedModel: boolean } {
  const { pricing, matched } = resolvePricing(model);

  const input = Math.max(0, tokens.inputTokens);
  const output = Math.max(0, tokens.outputTokens);
  const cached = Math.max(0, tokens.cachedInputTokens ?? 0);

  const cost =
    (input * pricing.inputPerMillion) / 1_000_000 +
    (output * pricing.outputPerMillion) / 1_000_000 +
    (cached * pricing.cachedInputPerMillion) / 1_000_000;

  return { costMicroUsd: Math.round(cost), pricedModel: matched };
}

/** Micro-USD as a dollar string, for display. */
export function formatMicroUsd(microUsd: number, decimals = 4): string {
  return (microUsd / 1_000_000).toFixed(decimals);
}
