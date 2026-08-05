import { AiEngineService } from './ai-engine.service';

/**
 * The identifiers in a prompt must not reach a third-party model.
 *
 * Asserted against what the provider was actually handed, not against
 * `redactPii` in isolation — the unit tests already cover the redactor, and the
 * thing that can regress here is the wiring: someone passing `userPrompt`
 * instead of `redactedPrompt` reintroduces the leak with the redactor still
 * fully tested and fully green.
 */

const DRAFT = JSON.stringify({
  title: 'Shartnoma',
  documentType: 'CONTRACT',
  language: 'uz-Latn',
  sections: [
    {
      heading: 'Rekvizitlar',
      // The model writes the placeholders back where they belong.
      body: 'Buyurtmachi STIR [STIR_1], h/r [BANK_ACCOUNT_1], tel [PHONE_1].',
      order: 1,
    },
  ],
  missingFields: [],
  reviewNotes: [],
});

function build(config: Record<string, string> = {}) {
  const generate = jest.fn(
    async (request: { systemPrompt: string; userPrompt: string }) => ({
      _received: request,
      text: DRAFT,
      provider: 'anthropic' as const,
      model: 'claude-sonnet-5',
      usage: { inputTokens: 10, outputTokens: 20 },
    }),
  );

  const provider = {
    name: 'anthropic' as const,
    isConfigured: () => true,
    supportsTemperature: false,
    generate,
  };

  const service = new AiEngineService(
    provider as never,
    { name: 'openai', isConfigured: () => false } as never,
    {
      get: (key: string, fallback?: unknown) => config[key] ?? fallback,
    } as never,
    { record: jest.fn(async () => undefined) } as never,
  );

  return { service, generate };
}

const INPUT = {
  locale: 'uz-Latn' as const,
  documentType: 'CONTRACT',
  variables: {
    counterparty_legal_name: 'SIFAT QURILISH MChJ',
    counterparty_stir: 'STIR: 305123456',
    company_bank_account: 'h/r: 20208000900001234567',
    company_phone: '+998901234567',
  },
};

describe('AiEngineService — PII redaction', () => {
  it('sends no raw identifier to the provider', async () => {
    const { service, generate } = build();

    await service.generateLegalDocument(INPUT);

    const sent = generate.mock.calls[0][0];

    expect(sent.userPrompt).not.toContain('305123456');
    expect(sent.userPrompt).not.toContain('20208000900001234567');
    expect(sent.userPrompt).not.toContain('901234567');
  });

  it('sends placeholders the model can write back', async () => {
    const { service, generate } = build();

    await service.generateLegalDocument(INPUT);

    const sent = generate.mock.calls[0][0];

    expect(sent.userPrompt).toContain('[STIR_1]');
    expect(sent.userPrompt).toContain('[BANK_ACCOUNT_1]');
    expect(sent.userPrompt).toContain('[PHONE_1]');
  });

  it('restores the real values into the returned draft', async () => {
    const { service } = build();

    const output = await service.generateLegalDocument(INPUT);

    const body = JSON.stringify(output.document);

    expect(body).toContain('305123456');
    expect(body).toContain('20208000900001234567');
    expect(body).toContain('+998901234567');
    expect(body).not.toContain('[STIR_1]');
  });

  it('leaves a prompt with nothing to redact untouched', async () => {
    const { service, generate } = build();

    await service.generateLegalDocument({
      ...INPUT,
      variables: { counterparty_legal_name: 'SIFAT QURILISH MChJ' },
    });

    const sent = generate.mock.calls[0][0];

    expect(sent.userPrompt).toContain('SIFAT QURILISH MChJ');
  });

  it('tells the model to copy the placeholders through verbatim', async () => {
    // Without this instruction the model does not recognise [STIR_1] as a
    // value: it substitutes its own "[TO'LDIRILISHI KERAK]" marker, restore
    // finds nothing to put back, and the user is asked to retype details they
    // already supplied. Verified against a live model — the failure is real,
    // not hypothetical, so the instruction is asserted rather than trusted.
    const { service, generate } = build();

    await service.generateLegalDocument(INPUT);

    const sent = generate.mock.calls[0][0];

    expect(sent.systemPrompt).toContain('[STIR_1]');
    expect(sent.systemPrompt).toContain('[BANK_ACCOUNT_1]');
  });

  describe('when redaction is switched off', () => {
    it('sends the raw values', async () => {
      // A deployment can opt out, but has to say so — the default protects.
      const { service, generate } = build({ AI_REDACT_PII: 'false' });

      await service.generateLegalDocument(INPUT);

      const sent = generate.mock.calls[0][0];

      expect(sent.userPrompt).toContain('305123456');
    });
  });
});
