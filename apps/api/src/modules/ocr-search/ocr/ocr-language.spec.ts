import {
  CONFIDENCE_FLOOR,
  TESSERACT_LANGUAGES,
  analyzeScript,
  isConfidenceAcceptable,
  languagesForScript,
  normalizeUzbekApostrophes,
  toTesseractParam,
} from './ocr-language';

const { UZBEK_LATIN, UZBEK_CYRILLIC, RUSSIAN, ENGLISH } = TESSERACT_LANGUAGES;

describe('analyzeScript', () => {
  it('identifies Cyrillic text', () => {
    const analysis = analyzeScript('Договор поставки товара');
    expect(analysis.script).toBe('cyrillic');
    expect(analysis.cyrillicRatio).toBeGreaterThan(0.9);
  });

  it('identifies Latin text', () => {
    const analysis = analyzeScript('Tovar yetkazib berish shartnomasi');
    expect(analysis.script).toBe('latin');
  });

  it('flags Uzbek-specific Cyrillic letters', () => {
    // ў, қ, ғ, ҳ distinguish Uzbek Cyrillic from Russian, which are otherwise
    // near-identical by character set.
    expect(analyzeScript('Ўзбекистон Республикаси').hasUzbekCyrillic).toBe(true);
    expect(analyzeScript('Российская Федерация').hasUzbekCyrillic).toBe(false);
  });

  it('flags Uzbek Latin apostrophe conventions', () => {
    expect(analyzeScript("O'zbekiston Respublikasi").hasUzbekLatin).toBe(true);
    expect(analyzeScript('Oʻzbekiston').hasUzbekLatin).toBe(true);
    expect(analyzeScript('Uzbekistan Republic').hasUzbekLatin).toBe(false);
  });

  it('detects mixed script at a low threshold', () => {
    // A page of Uzbek Latin with one Russian bank block is mixed; treating it as
    // pure Latin loses that block entirely.
    const analysis = analyzeScript(
      'Shartnoma tovar yetkazib berish uchun tuzildi. Hisob raqami: Ипотека банк Тошкент филиали',
    );
    expect(analysis.script).toBe('mixed');
  });

  it('counts only letters, ignoring the digits legal documents are full of', () => {
    const analysis = analyzeScript('Договор 12345678901234567890 №42/2026');
    expect(analysis.script).toBe('cyrillic');
  });

  it('reports unknown for text with no letters', () => {
    const analysis = analyzeScript('12345 --- 67.89');
    expect(analysis.script).toBe('unknown');
    expect(analysis.cyrillicRatio).toBe(0);
  });

  it('reports unknown for empty input', () => {
    expect(analyzeScript('').script).toBe('unknown');
  });
});

describe('languagesForScript', () => {
  it('pairs Uzbek Cyrillic with Russian', () => {
    // The two share almost the whole alphabet and documents mix them freely.
    const languages = languagesForScript(analyzeScript('Ўзбекистон Республикаси'));
    expect(languages).toContain(UZBEK_CYRILLIC);
    expect(languages).toContain(RUSSIAN);
  });

  it('leads with Russian for Cyrillic without Uzbek markers', () => {
    const languages = languagesForScript(analyzeScript('Российская Федерация договор'));
    expect(languages[0]).toBe(RUSSIAN);
  });

  it('leads with Uzbek Cyrillic when its markers are present', () => {
    const languages = languagesForScript(analyzeScript('Ўзбекистон қонуни ғарбий'));
    expect(languages[0]).toBe(UZBEK_CYRILLIC);
  });

  it('pairs Uzbek Latin with English', () => {
    const languages = languagesForScript(analyzeScript('Tovar shartnomasi'));
    expect(languages).toEqual([UZBEK_LATIN, ENGLISH]);
  });

  it('loads everything for mixed script', () => {
    const languages = languagesForScript({
      script: 'mixed',
      cyrillicRatio: 0.5,
      latinRatio: 0.5,
      hasUzbekCyrillic: true,
      hasUzbekLatin: true,
    });
    expect(languages).toHaveLength(4);
  });

  it('loads everything when the script is unknown', () => {
    // A pure scan has no text layer to sample. Loading too many models costs
    // memory; loading too few loses the text with no way to tell it happened.
    const languages = languagesForScript(analyzeScript(''));
    expect(languages).toContain(UZBEK_LATIN);
    expect(languages).toContain(UZBEK_CYRILLIC);
    expect(languages).toContain(RUSSIAN);
  });

  it('never returns an empty language set', () => {
    for (const sample of ['', '123', 'abc', 'абв', 'Ўзбек abc']) {
      expect(languagesForScript(analyzeScript(sample)).length).toBeGreaterThan(0);
    }
  });
});

describe('toTesseractParam', () => {
  it('joins with plus, as Tesseract expects', () => {
    expect(toTesseractParam([UZBEK_CYRILLIC, RUSSIAN])).toBe('uzb_cyrl+rus');
  });
});

describe('isConfidenceAcceptable', () => {
  it('accepts confidence at or above the floor', () => {
    expect(isConfidenceAcceptable(CONFIDENCE_FLOOR)).toBe(true);
    expect(isConfidenceAcceptable(95)).toBe(true);
  });

  it('rejects confidence below the floor', () => {
    expect(isConfidenceAcceptable(CONFIDENCE_FLOOR - 1)).toBe(false);
    expect(isConfidenceAcceptable(0)).toBe(false);
  });

  it('accepts null, which means nothing was guessed', () => {
    // Text-layer extraction is exact and has no confidence to report; treating
    // null as zero would flag every perfectly extracted PDF as suspect.
    expect(isConfidenceAcceptable(null)).toBe(true);
  });

  it('keeps the floor low enough for a real archive', () => {
    // These are photocopied, stamped, and faxed documents. Holding out for 80
    // would reject most of a genuine corpus.
    expect(CONFIDENCE_FLOOR).toBeLessThanOrEqual(70);
    expect(CONFIDENCE_FLOOR).toBeGreaterThan(0);
  });
});

describe('normalizeUzbekApostrophes', () => {
  it('collapses every apostrophe variant to one', () => {
    expect(normalizeUzbekApostrophes('oʻzbek')).toBe("o'zbek");
    expect(normalizeUzbekApostrophes('oʼzbek')).toBe("o'zbek");
    expect(normalizeUzbekApostrophes('o‘zbek')).toBe("o'zbek");
    expect(normalizeUzbekApostrophes('o’zbek')).toBe("o'zbek");
    expect(normalizeUzbekApostrophes('o`zbek')).toBe("o'zbek");
  });

  it('leaves a plain apostrophe alone', () => {
    expect(normalizeUzbekApostrophes("o'zbek")).toBe("o'zbek");
  });

  it('makes the variants indistinguishable, which is the point', () => {
    const forms = ['oʻzbek', "o'zbek", 'o`zbek', 'o‘zbek'];
    const normalized = new Set(forms.map(normalizeUzbekApostrophes));
    expect(normalized.size).toBe(1);
  });
});
