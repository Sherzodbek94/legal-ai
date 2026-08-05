import {
  formatCitation,
  splitIntoArticles,
} from './article-splitter';

const CIVIL_CODE = `
O'ZBEKISTON RESPUBLIKASINING FUQAROLIK KODEKSI

Ushbu Kodeks fuqarolik munosabatlarini tartibga soladi.

346-modda. Majburiyatni bajarish

Majburiyat lozim darajada bajarilishi kerak.

347-modda. Qarzni hisobga olish

Bir xil turdagi talablar hisobga olish yo'li bilan tugatilishi mumkin.
Hisobga olish uchun bir tomonning arizasi yetarli.

347-1-modda. Hisobga olishga yo'l qo'yilmaydigan hollar

Ushbu Kodeksning 347-moddasida nazarda tutilgan hisobga olish quyidagi
hollarda qo'llanilmaydi.

348-modda. Majburiyatning tugatilishi
`;

describe('splitIntoArticles', () => {
  describe('Uzbek Latin', () => {
    const chunks = splitIntoArticles(CIVIL_CODE);

    it('produces one chunk per article', () => {
      const labels = chunks.map((chunk) => chunk.articleLabel);

      expect(labels).toEqual([null, '346', '347', '347-1', '348']);
    });

    it('keeps the preamble, which is where commencement is stated', () => {
      expect(chunks[0].articleLabel).toBeNull();
      expect(chunks[0].content).toContain('FUQAROLIK KODEKSI');
    });

    it('keeps the heading inside the passage it names', () => {
      // The embedding should carry the article's own identity, so a semantic
      // query naming it can match on more than the bare number.
      const article347 = chunks.find((chunk) => chunk.articleLabel === '347');

      expect(article347?.content).toContain('347-modda');
      expect(article347?.content).toContain('Qarzni hisobga olish');
    });

    it('does not split on a cross-reference inside a sentence', () => {
      // "...ushbu Kodeksning 347-moddasida nazarda tutilgan..." is a reference,
      // not a heading. Splitting there would cut 347-1 in half.
      const inserted = chunks.find((chunk) => chunk.articleLabel === '347-1');

      expect(inserted?.content).toContain('347-moddasida nazarda tutilgan');
    });

    it('treats an inserted article as its own provision', () => {
      // 347-1 was inserted between 347 and 348 by amendment. Folding it into
      // 347 would cite two different provisions as one.
      const labels = chunks.map((chunk) => chunk.articleLabel);

      expect(labels).toContain('347');
      expect(labels).toContain('347-1');
    });

    it('does not leak one article into the next', () => {
      const article346 = chunks.find((chunk) => chunk.articleLabel === '346');

      expect(article346?.content).not.toContain('347-modda');
    });
  });

  describe('other scripts and languages', () => {
    it('splits Uzbek Cyrillic', () => {
      const chunks = splitIntoArticles(
        '12-модда. Умумий қоидалар\n\nМатн.\n\n13-модда. Бошқа қоидалар\n\nМатн.',
      );

      expect(chunks.map((chunk) => chunk.articleLabel)).toEqual(['12', '13']);
    });

    it('splits Russian', () => {
      const chunks = splitIntoArticles(
        'Статья 5. Общие положения\n\nТекст.\n\nСтатья 6. Иное\n\nТекст.',
      );

      expect(chunks.map((chunk) => chunk.articleLabel)).toEqual(['5', '6']);
    });

    it('splits English translations', () => {
      const chunks = splitIntoArticles(
        'Article 1. Scope\n\nText.\n\nArticle 2. Definitions\n\nText.',
      );

      expect(chunks.map((chunk) => chunk.articleLabel)).toEqual(['1', '2']);
    });
  });

  describe('texts with no article structure', () => {
    it('falls back to length-based chunking', () => {
      // Many resolutions and ministerial instructions are numbered paragraphs
      // rather than articles. Still worth indexing.
      const chunks = splitIntoArticles(
        `1. Vazirlik quyidagilarni ta'minlasin.\n\n${'Matn. '.repeat(400)}`,
      );

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.every((chunk) => chunk.articleLabel === null)).toBe(true);
    });

    it('returns nothing for empty input', () => {
      expect(splitIntoArticles('')).toEqual([]);
      expect(splitIntoArticles('   \n\n  ')).toEqual([]);
    });
  });

  describe('long articles', () => {
    it('splits one over the ceiling into numbered parts', () => {
      const chunks = splitIntoArticles(
        `5-modda. Uzun modda\n\n${'Juda uzun matn. '.repeat(900)}`,
      );

      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.every((chunk) => chunk.articleLabel === '5')).toBe(true);
      // 1-based: "part 1 of 3" reads correctly to a person.
      expect(chunks.map((chunk) => chunk.articlePart)).toEqual(
        chunks.map((_, index) => index + 1),
      );
    });

    it('leaves a short article whole, with no part number', () => {
      const chunks = splitIntoArticles('5-modda. Qisqa\n\nBir jumla.');

      expect(chunks).toHaveLength(1);
      expect(chunks[0].articlePart).toBeNull();
    });
  });

  describe('extraction artefacts', () => {
    it('matches a heading separated by a non-breaking space', () => {
      // Survives PDF extraction and otherwise sits between the number and
      // `-modda`, stopping the heading matching at all.
      const chunks = splitIntoArticles('7-modda. Sarlavha\n\nMatn.');

      expect(chunks[0].articleLabel).toBe('7');
    });

    it('matches a heading carrying a soft hyphen', () => {
      const chunks = splitIntoArticles('8-mod­dda. Sarlavha\n\nMatn.'.replace('dd', 'd'));

      expect(chunks[0].articleLabel).toBe('8');
    });
  });
});

describe('formatCitation', () => {
  const act = { title: "O'zbekiston Respublikasi Fuqarolik kodeksi" };

  it('names the article', () => {
    expect(formatCitation(act, { articleLabel: '347', articlePart: null })).toBe(
      "O'zbekiston Respublikasi Fuqarolik kodeksi, 347-modda",
    );
  });

  it('names the part when an article was split', () => {
    expect(formatCitation(act, { articleLabel: '347', articlePart: 2 })).toBe(
      "O'zbekiston Respublikasi Fuqarolik kodeksi, 347-modda, (2-qism)",
    );
  });

  it('cites the act alone when there is no article', () => {
    expect(formatCitation(act, { articleLabel: null })).toBe(
      "O'zbekiston Respublikasi Fuqarolik kodeksi",
    );
  });
});
