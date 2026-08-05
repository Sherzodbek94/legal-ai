import { draftToContent, draftToSummary } from './draft-to-content';
import type { LegalDocumentDraft } from '../../ai-engine/schemas/legal-document.schema';

const draft = (
  overrides: Partial<LegalDocumentDraft> = {},
): LegalDocumentDraft => ({
  title: 'Supply Agreement',
  documentType: 'contract',
  language: 'uz-Latn',
  sections: [{ heading: 'Parties', body: 'Alpha and Beta.', order: 1 }],
  missingFields: [],
  reviewNotes: [],
  ...overrides,
});

describe('draftToContent', () => {
  it('opens with the title as a level-1 heading', () => {
    const content = draftToContent(draft());

    expect(content.type).toBe('doc');
    expect(content.content?.[0]).toEqual({
      type: 'heading',
      attrs: { level: 1 },
      content: [{ type: 'text', text: 'Supply Agreement' }],
    });
  });

  it('orders sections by their declared order, not array position', () => {
    const content = draftToContent(
      draft({
        sections: [
          { heading: 'Second', body: 'b', order: 2 },
          { heading: 'First', body: 'a', order: 1 },
        ],
      }),
    );

    const headings = (content.content ?? [])
      .filter((node) => node.type === 'heading' && node.attrs?.level === 2)
      .map((node) => node.content?.[0].text);

    // Clause order is meaningful in a contract, and models do occasionally emit
    // sections out of sequence — which is why the field exists.
    expect(headings).toEqual(['First', 'Second']);
  });

  it('splits a body into paragraphs on blank lines', () => {
    const content = draftToContent(
      draft({
        sections: [
          { heading: 'Terms', body: 'First para.\n\nSecond para.', order: 1 },
        ],
      }),
    );

    const paragraphs = (content.content ?? []).filter(
      (node) => node.type === 'paragraph',
    );
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0].content?.[0].text).toBe('First para.');
    expect(paragraphs[1].content?.[0].text).toBe('Second para.');
  });

  it('keeps single newlines as hard breaks within a paragraph', () => {
    const content = draftToContent(
      draft({
        sections: [{ heading: 'List', body: '1. One\n2. Two', order: 1 }],
      }),
    );

    const paragraph = (content.content ?? []).find(
      (node) => node.type === 'paragraph',
    );

    // Enumerated clauses must not run together into one line.
    expect(paragraph?.content).toEqual([
      { type: 'text', text: '1. One' },
      { type: 'hardBreak' },
      { type: 'text', text: '2. Two' },
    ]);
  });

  it('omits an empty section heading rather than emitting a blank one', () => {
    const content = draftToContent(
      draft({ sections: [{ heading: '   ', body: 'Body only.', order: 1 }] }),
    );

    const level2 = (content.content ?? []).filter(
      (node) => node.type === 'heading' && node.attrs?.level === 2,
    );
    expect(level2).toHaveLength(0);
  });

  it('drops blank blocks left by trailing whitespace', () => {
    const content = draftToContent(
      draft({ sections: [{ heading: 'H', body: 'Text.\n\n\n\n', order: 1 }] }),
    );

    expect(
      (content.content ?? []).filter((node) => node.type === 'paragraph'),
    ).toHaveLength(1);
  });
});

describe('draftToSummary', () => {
  it('is undefined when the model raised nothing', () => {
    expect(draftToSummary(draft())).toBeUndefined();
  });

  it('carries missing fields and review notes', () => {
    const summary = draftToSummary(
      draft({
        missingFields: ['counterparty address'],
        reviewNotes: ['Verify the governing law clause'],
      }),
    );

    // These are the parts a reviewing attorney must see; a draft with an
    // acknowledged gap should not read as finished.
    expect(summary).toContain('counterparty address');
    expect(summary).toContain('Verify the governing law clause');
  });

  it('bounds its length', () => {
    const summary = draftToSummary(
      draft({ reviewNotes: [' x'.repeat(4000)] }),
    );

    expect(summary!.length).toBeLessThanOrEqual(2000);
  });
});
