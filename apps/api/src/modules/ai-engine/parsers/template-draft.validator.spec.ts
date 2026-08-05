import {
  templateDraftToContent,
  templateDraftToSchema,
  validateTemplateDraft,
} from './template-draft.validator';
import type { LegalTemplateDraft } from '../schemas/legal-template.schema';

const draft = (overrides: Partial<LegalTemplateDraft> = {}): LegalTemplateDraft => ({
  title: 'Tovar yetkazib berish shartnomasi',
  documentType: 'CONTRACT',
  language: 'uz-Latn',
  purpose: 'Tovar yetkazib berish munosabatlarini tartibga solish',
  sections: [
    {
      heading: '1. Shartnoma predmeti',
      body: 'Yetkazib beruvchi {{company_legal_name}} Xaridor {{counterparty_legal_name}}ga tovarni topshirish majburiyatini oladi. Tovar nomi va miqdori spetsifikatsiyada belgilanadi.',
      order: 1,
    },
    {
      heading: '2. Shartnoma summasi',
      body: 'Shartnoma summasi {{contract_amount}} so‘mni tashkil etadi. To‘lov {{payment_days}} bank kuni ichida amalga oshiriladi. To‘lov o‘tkazma yo‘li bilan bajariladi.',
      order: 2,
    },
  ],
  variables: [
    { key: 'company_legal_name', label: 'Yetkazib beruvchi', type: 'string', required: true },
    { key: 'counterparty_legal_name', label: 'Xaridor', type: 'string', required: true },
    { key: 'contract_amount', label: 'Summa', type: 'money', required: true, currency: 'UZS' },
    { key: 'payment_days', label: "To'lov muddati", type: 'integer', required: true },
  ],
  reviewNotes: [],
  ...overrides,
});

describe('validateTemplateDraft', () => {
  it('reports nothing for a draft whose text and variables agree', () => {
    const issues = validateTemplateDraft(draft());

    expect(issues.undeclared).toEqual([]);
    expect(issues.unused).toEqual([]);
    expect(issues.invalidKeys).toEqual([]);
  });

  it('catches a placeholder no variable declares', () => {
    // The failure this exists for: the model writes {{delivery_days}} and
    // declares `delivery_deadline`. Nothing downstream can tell — the
    // placeholder survives into a generated contract and prints literally on a
    // page somebody signs.
    const issues = validateTemplateDraft(
      draft({
        sections: [
          {
            heading: '1. Muddat',
            body: 'Yetkazib berish {{delivery_days}} kun ichida amalga oshiriladi va bu muddat tomonlarning kelishuvi bilan uzaytirilishi mumkin.',
            order: 1,
          },
        ],
      }),
    );

    expect(issues.undeclared).toEqual(['delivery_days']);
  });

  it('catches a variable the text never uses', () => {
    const issues = validateTemplateDraft(
      draft({
        variables: [
          ...draft().variables,
          { key: 'unused_field', label: 'Ishlatilmagan', type: 'string', required: false },
        ],
      }),
    );

    expect(issues.unused).toEqual(['unused_field']);
  });

  it('catches a key the rest of the system cannot address', () => {
    const issues = validateTemplateDraft(
      draft({
        variables: [
          { key: 'Contract-Number', label: 'Raqam', type: 'string', required: true },
        ],
      }),
    );

    expect(issues.invalidKeys).toEqual(['Contract-Number']);
  });

  it('flags a clause that is a heading with a sentence under it', () => {
    // Exactly the complaint about the shipped templates: sections with no
    // substance, producing a contract that is a letterhead.
    const issues = validateTemplateDraft(
      draft({
        sections: [
          { heading: '1. Javobgarlik', body: 'Tomonlar javobgar.', order: 1 },
        ],
      }),
    );

    expect(issues.thinSections).toEqual(['1. Javobgarlik']);
  });

  it('does not flag a substantial clause', () => {
    expect(validateTemplateDraft(draft()).thinSections).toEqual([]);
  });

  it('finds a placeholder in a heading too', () => {
    const issues = validateTemplateDraft(
      draft({
        sections: [
          {
            heading: '{{heading_var}} bo‘yicha',
            body: 'Yetarlicha uzun matn bo‘lishi uchun bu jumla ataylab cho‘zilgan va yana bir necha so‘z qo‘shilgan.',
            order: 1,
          },
        ],
      }),
    );

    expect(issues.undeclared).toContain('heading_var');
  });
});

describe('templateDraftToContent', () => {
  it('renumbers headings from order, not from the model', () => {
    // Models number inconsistently across a long answer, and clauses running
    // 1, 2, 2, 4 read as the firm's mistake rather than the software's.
    const content = templateDraftToContent(
      draft({
        sections: [
          { heading: '2. Ikkinchi', body: 'Matn.', order: 2 },
          { heading: '2. Birinchi', body: 'Matn.', order: 1 },
        ],
      }),
    ) as { content: { type: string; content?: { text: string }[] }[] };

    const headings = content.content
      .filter((node) => node.type === 'heading')
      .map((node) => node.content?.[0].text);

    expect(headings).toEqual([
      'Tovar yetkazib berish shartnomasi',
      '1. Birinchi',
      '2. Ikkinchi',
    ]);
  });

  it('splits a multi-line body into paragraphs', () => {
    // A single paragraph carrying embedded newlines renders as one run-on wall
    // in both the editor and the PDF.
    const content = templateDraftToContent(
      draft({
        sections: [
          { heading: '1. Band', body: 'Birinchi jumla.\n\nIkkinchi jumla.', order: 1 },
        ],
      }),
    ) as { content: { type: string }[] };

    expect(content.content.filter((node) => node.type === 'paragraph')).toHaveLength(2);
  });

  it('produces a body the placeholder collector can read', () => {
    const content = templateDraftToContent(draft());

    expect(JSON.stringify(content)).toContain('{{contract_amount}}');
  });
});

describe('templateDraftToSchema', () => {
  it('carries type, requiredness, and currency through', () => {
    const schema = templateDraftToSchema(draft().variables);

    expect(schema.version).toBe(1);
    expect(schema.variables).toContainEqual(
      expect.objectContaining({
        key: 'contract_amount',
        type: 'money',
        required: true,
        currency: 'UZS',
      }),
    );
  });

  it('drops the empty strings a strict-mode model returns', () => {
    // Stored as-is they show blank hint text under every input.
    const schema = templateDraftToSchema([
      { key: 'x', label: 'X', type: 'string', required: true, description: '', currency: '' },
    ]);

    expect(schema.variables[0]).not.toHaveProperty('description');
    expect(schema.variables[0]).not.toHaveProperty('currency');
  });
});
