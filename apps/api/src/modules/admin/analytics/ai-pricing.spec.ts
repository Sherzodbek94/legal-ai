import {
  MODEL_PRICING,
  computeCostMicroUsd,
  formatMicroUsd,
  resolvePricing,
} from './ai-pricing';

describe('resolvePricing', () => {
  it('matches a known model exactly', () => {
    const { pricing, matched } = resolvePricing('claude-sonnet-5');
    expect(matched).toBe(true);
    expect(pricing).toBe(MODEL_PRICING['claude-sonnet-5']);
  });

  it('is case-insensitive', () => {
    expect(resolvePricing('CLAUDE-SONNET-5').matched).toBe(true);
  });

  it('tolerates the dated suffixes vendors append', () => {
    // Otherwise every real call falls through to the unknown-model path.
    const { pricing, matched } = resolvePricing('claude-sonnet-5-20260101');
    expect(matched).toBe(true);
    expect(pricing).toBe(MODEL_PRICING['claude-sonnet-5']);
  });

  it('prefers the longest matching prefix', () => {
    const { pricing } = resolvePricing('claude-haiku-4-5-20251001');
    expect(pricing).toBe(MODEL_PRICING['claude-haiku-4-5']);
  });

  it('falls back to the most expensive entry for an unknown model', () => {
    // Overstating an unknown cost prompts someone to update the table;
    // reporting zero means nobody notices for a quarter.
    const { pricing, matched } = resolvePricing('some-new-frontier-model');
    expect(matched).toBe(false);

    const highestOutputRate = Math.max(
      ...Object.values(MODEL_PRICING).map((p) => p.outputPerMillion),
    );
    expect(pricing.outputPerMillion).toBe(highestOutputRate);
  });
});

describe('computeCostMicroUsd', () => {
  it('prices input and output tokens at their separate rates', () => {
    // Sonnet: $3/M in, $15/M out. 1M in + 1M out = $18 = 18,000,000 micro-USD.
    const { costMicroUsd } = computeCostMicroUsd('claude-sonnet-5', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(costMicroUsd).toBe(18_000_000);
  });

  it('prices a realistic single call in whole micro-dollars', () => {
    // 8k in, 2k out on Sonnet: 8000*3 + 2000*15 = 54,000 micro-USD ≈ $0.054.
    const { costMicroUsd } = computeCostMicroUsd('claude-sonnet-5', {
      inputTokens: 8000,
      outputTokens: 2000,
    });
    expect(costMicroUsd).toBe(54_000);
  });

  it('discounts cached input tokens', () => {
    const uncached = computeCostMicroUsd('claude-sonnet-5', {
      inputTokens: 100_000,
      outputTokens: 0,
    });
    const cached = computeCostMicroUsd('claude-sonnet-5', {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 100_000,
    });

    expect(cached.costMicroUsd).toBeLessThan(uncached.costMicroUsd);
  });

  it('does not round a small call down to nothing', () => {
    // The reason costs are stored in micro-USD rather than cents: this call
    // costs a fraction of one cent and must not record as zero.
    const { costMicroUsd } = computeCostMicroUsd('gpt-4o-mini', {
      inputTokens: 500,
      outputTokens: 100,
    });
    expect(costMicroUsd).toBeGreaterThan(0);
    expect(costMicroUsd).toBeLessThan(10_000); // under one cent
  });

  it('reports a zero-token call as free', () => {
    expect(
      computeCostMicroUsd('claude-sonnet-5', { inputTokens: 0, outputTokens: 0 })
        .costMicroUsd,
    ).toBe(0);
  });

  it('clamps negative token counts rather than crediting them', () => {
    const { costMicroUsd } = computeCostMicroUsd('claude-sonnet-5', {
      inputTokens: -1000,
      outputTokens: 1000,
    });
    expect(costMicroUsd).toBe(15_000);
  });

  it('flags an unpriced model so the caller can log it', () => {
    const { pricedModel } = computeCostMicroUsd('mystery-model-9', {
      inputTokens: 100,
      outputTokens: 100,
    });
    expect(pricedModel).toBe(false);
  });

  it('returns an integer, since the column is an integer', () => {
    const { costMicroUsd } = computeCostMicroUsd('gpt-4o-mini', {
      inputTokens: 333,
      outputTokens: 777,
    });
    expect(Number.isInteger(costMicroUsd)).toBe(true);
  });
});

describe('formatMicroUsd', () => {
  it('renders micro-USD as dollars', () => {
    expect(formatMicroUsd(1_000_000, 2)).toBe('1.00');
    expect(formatMicroUsd(54_000, 4)).toBe('0.0540');
  });

  it('keeps sub-cent costs visible at four decimal places', () => {
    expect(formatMicroUsd(1200)).toBe('0.0012');
  });
});
