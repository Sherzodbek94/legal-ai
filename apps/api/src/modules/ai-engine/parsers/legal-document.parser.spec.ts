import { parseLegalDocument } from './legal-document.parser';

const validDraft = {
  title: 'Oldi-sotdi shartnomasi',
  documentType: 'sale_contract',
  language: 'uz-Latn',
  sections: [
    { heading: '1. Umumiy qoidalar', body: 'Shartnoma matni...', order: 1 },
    { heading: '2. Tomonlar', body: 'Tomonlar ro‘yxati...', order: 2 },
  ],
  missingFields: ['company_stir'],
  reviewNotes: ['Governing law clause absent'],
};

describe('parseLegalDocument', () => {
  describe('valid input', () => {
    it('parses a well-formed draft', () => {
      const result = parseLegalDocument(JSON.stringify(validDraft));

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.document.title).toBe('Oldi-sotdi shartnomasi');
      expect(result.document.documentType).toBe('sale_contract');
      expect(result.document.sections).toHaveLength(2);
      expect(result.document.missingFields).toEqual(['company_stir']);
      expect(result.repaired).toBe(false);
    });

    it('parses a draft wrapped in a markdown fence', () => {
      const raw = '```json\n' + JSON.stringify(validDraft) + '\n```';
      const result = parseLegalDocument(raw);
      expect(result.ok).toBe(true);
    });

    it('parses a draft preceded by conversational text', () => {
      const raw = `Here is the draft:\n${JSON.stringify(validDraft)}`;
      const result = parseLegalDocument(raw);
      expect(result.ok).toBe(true);
    });

    it('flags a draft that needed repair', () => {
      const raw = '{"title":"T","sections":[{"heading":"H","body":"B"},],}';
      const result = parseLegalDocument(raw);
      expect(result.ok).toBe(true);
      expect(result.ok && result.repaired).toBe(true);
    });

    it('preserves Cyrillic content', () => {
      const raw = JSON.stringify({
        ...validDraft,
        title: 'Договор купли-продажи',
        sections: [{ heading: 'Раздел 1', body: 'Текст...', order: 1 }],
      });
      const result = parseLegalDocument(raw);
      expect(result.ok && result.document.title).toBe('Договор купли-продажи');
    });
  });

  describe('advisory fields are coerced, not fatal', () => {
    it('derives order from array position when omitted', () => {
      const raw = JSON.stringify({
        title: 'T',
        sections: [
          { heading: 'A', body: 'x' },
          { heading: 'B', body: 'y' },
        ],
      });
      const result = parseLegalDocument(raw);
      expect(result.ok && result.document.sections.map((s) => s.order)).toEqual([
        1, 2,
      ]);
    });

    it('replaces a non-integer order with the array position', () => {
      const raw = JSON.stringify({
        title: 'T',
        sections: [{ heading: 'A', body: 'x', order: 'first' }],
      });
      const result = parseLegalDocument(raw);
      expect(result.ok && result.document.sections[0].order).toBe(1);
    });

    it('defaults documentType and language when absent', () => {
      const raw = JSON.stringify({
        title: 'T',
        sections: [{ heading: 'A', body: 'x', order: 1 }],
      });
      const result = parseLegalDocument(raw);
      expect(result.ok && result.document.documentType).toBe('unknown');
      expect(result.ok && result.document.language).toBe('unknown');
    });

    it('drops non-string entries from missingFields', () => {
      const raw = JSON.stringify({
        title: 'T',
        sections: [{ heading: 'A', body: 'x', order: 1 }],
        missingFields: ['company_stir', 42, null, 'company_mfo'],
      });
      const result = parseLegalDocument(raw);
      expect(result.ok && result.document.missingFields).toEqual([
        'company_stir',
        'company_mfo',
      ]);
    });

    it('tolerates a non-array missingFields', () => {
      const raw = JSON.stringify({
        title: 'T',
        sections: [{ heading: 'A', body: 'x', order: 1 }],
        missingFields: 'company_stir',
      });
      const result = parseLegalDocument(raw);
      expect(result.ok && result.document.missingFields).toEqual([]);
    });

    it('accepts an empty section body', () => {
      const raw = JSON.stringify({
        title: 'T',
        sections: [{ heading: 'Reserved', body: '', order: 1 }],
      });
      expect(parseLegalDocument(raw).ok).toBe(true);
    });
  });

  describe('surfacing partial damage', () => {
    it('keeps valid sections and reports the invalid one to the reviewer', () => {
      const raw = JSON.stringify({
        title: 'T',
        sections: [
          { heading: 'Good', body: 'x', order: 1 },
          { heading: '', body: 'y', order: 2 },
          { heading: 'Also good', body: 'z', order: 3 },
        ],
      });

      const result = parseLegalDocument(raw);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.document.sections).toHaveLength(2);
      // The dropped section must not vanish silently — an attorney reviewing
      // this draft needs to know something was discarded.
      expect(result.document.reviewNotes).toEqual(
        expect.arrayContaining([expect.stringContaining('sections[1].heading')]),
      );
    });

    it('preserves model-supplied review notes alongside parse issues', () => {
      const raw = JSON.stringify({
        title: 'T',
        reviewNotes: ['Check indemnity clause'],
        sections: [
          { heading: 'Good', body: 'x', order: 1 },
          { heading: 'Bad', body: 123, order: 2 },
        ],
      });

      const result = parseLegalDocument(raw);
      expect(result.ok && result.document.reviewNotes).toEqual(
        expect.arrayContaining([
          'Check indemnity clause',
          expect.stringContaining('sections[1].body'),
        ]),
      );
    });
  });

  describe('rejection', () => {
    it('rejects a refusal with no JSON', () => {
      const result = parseLegalDocument('I cannot help with that request.');
      expect(result).toMatchObject({ ok: false, error: 'no-json-found' });
    });

    it('rejects empty output', () => {
      expect(parseLegalDocument('')).toMatchObject({
        ok: false,
        error: 'empty-input',
      });
    });

    it('rejects a truncated response', () => {
      const result = parseLegalDocument('{"title":"T","sections":[{"head');
      expect(result).toMatchObject({ ok: false, error: 'no-json-found' });
    });

    it('rejects a JSON array at the root', () => {
      const result = parseLegalDocument('[{"title":"T"}]');
      expect(result).toMatchObject({ ok: false, error: 'invalid-shape' });
    });

    it('rejects a draft with no title', () => {
      const raw = JSON.stringify({
        sections: [{ heading: 'A', body: 'x', order: 1 }],
      });
      const result = parseLegalDocument(raw);
      expect(result).toMatchObject({ ok: false, error: 'schema-validation-failed' });
      expect(!result.ok && result.issues).toEqual(
        expect.arrayContaining([expect.stringContaining('title')]),
      );
    });

    it('rejects a whitespace-only title', () => {
      const raw = JSON.stringify({
        title: '   ',
        sections: [{ heading: 'A', body: 'x', order: 1 }],
      });
      expect(parseLegalDocument(raw)).toMatchObject({
        ok: false,
        error: 'schema-validation-failed',
      });
    });

    it('rejects a draft with no sections', () => {
      const raw = JSON.stringify({ title: 'T', sections: [] });
      const result = parseLegalDocument(raw);
      expect(result).toMatchObject({ ok: false, error: 'schema-validation-failed' });
    });

    it('rejects a draft where every section is malformed', () => {
      const raw = JSON.stringify({
        title: 'T',
        sections: [{ heading: 'A' }, { body: 'x' }],
      });
      expect(parseLegalDocument(raw)).toMatchObject({
        ok: false,
        error: 'schema-validation-failed',
      });
    });

    it('rejects a non-array sections field', () => {
      const raw = JSON.stringify({ title: 'T', sections: 'none' });
      const result = parseLegalDocument(raw);
      expect(result).toMatchObject({ ok: false, error: 'schema-validation-failed' });
      expect(!result.ok && result.issues).toEqual(
        expect.arrayContaining([expect.stringContaining('expected an array')]),
      );
    });
  });
});
