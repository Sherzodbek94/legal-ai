import { findPii, passesLuhn } from './pii-patterns';
import {
  maskValue,
  redactPii,
  restorePii,
  summarizePii,
} from './pii-redactor';

const kinds = (text: string) => findPii(text).map((match) => match.kind);
const values = (text: string) => findPii(text).map((match) => match.value);

describe('findPii', () => {
  describe('label-anchored identifiers', () => {
    it.each([
      ['STIR: 305123456', 'STIR', '305123456'],
      ['СТИР 305123456', 'STIR', '305123456'],
      ['ИНН: 305123456', 'STIR', '305123456'],
      ['JSHSHIR: 31234567890123', 'PINFL', '31234567890123'],
      ['ПИНФЛ 31234567890123', 'PINFL', '31234567890123'],
      ['h/r: 20208000900001234567', 'BANK_ACCOUNT', '20208000900001234567'],
      ['Hisob raqami — 20208000900001234567', 'BANK_ACCOUNT', '20208000900001234567'],
      ['р/с 20208000900001234567', 'BANK_ACCOUNT', '20208000900001234567'],
    ])('finds %s', (text, kind, value) => {
      expect(findPii(text)).toEqual([
        expect.objectContaining({ kind, value }),
      ]);
    });

    it('reads a number typed in groups', () => {
      // `2020 8000 9000 0123 4567` and the unspaced form are one account.
      expect(values('h/r: 2020 8000 9000 0123 4567')).toEqual([
        '2020 8000 9000 0123 4567',
      ]);
    });
  });

  describe('what it deliberately does not match', () => {
    // The failure this guards: a detector keyed on length alone would redact
    // the amount payable out of every contract it touched.
    it.each([
      ['Shartnoma summasi 305123456 so‘m'],
      ['Shartnoma № 123456789'],
      ['2026 yil 4 avgust'],
      ['347-modda'],
    ])('leaves %s alone', (text) => {
      expect(findPii(text)).toEqual([]);
    });

    it('does not treat a bare nine-digit number as a STIR', () => {
      expect(findPii('305123456')).toEqual([]);
    });
  });

  describe('structurally distinctive identifiers', () => {
    it('finds a passport without needing a label', () => {
      expect(findPii('Pasport AA1234567 raqamli')).toEqual([
        expect.objectContaining({ kind: 'PASSPORT', value: 'AA1234567' }),
      ]);
    });

    it('finds a passport typed in Cyrillic letters', () => {
      // Uzbek passports are printed in Latin and retyped in Cyrillic by anyone
      // working in a Cyrillic layout; the two are visually identical.
      expect(kinds('Паспорт АА1234567')).toContain('PASSPORT');
    });

    it.each([
      ['+998 90 123 45 67'],
      ['+998901234567'],
      ['998 (90) 123-45-67'],
    ])('finds the phone %s', (text) => {
      expect(kinds(text)).toContain('PHONE');
    });

    it('finds an email', () => {
      expect(findPii('aloqa: info@acme-legal.uz')).toEqual([
        expect.objectContaining({ kind: 'EMAIL', value: 'info@acme-legal.uz' }),
      ]);
    });
  });

  describe('payment cards', () => {
    it('finds a Uzcard number that passes Luhn', () => {
      // 8600 prefix, valid check digit.
      expect(kinds('Karta 8600 1234 5678 9012')).toContain('CARD');
    });

    it('ignores a sixteen-digit number that fails Luhn', () => {
      // The checksum is what makes label-free detection safe: a contract number
      // of the same length would otherwise be redacted.
      expect(kinds('Shartnoma raqami 1234567812345678')).not.toContain('CARD');
    });
  });

  describe('overlaps', () => {
    it('prefers a labelled account over the card-shaped run inside it', () => {
      const found = findPii('h/r: 20208000900001234567');

      expect(found).toHaveLength(1);
      expect(found[0].kind).toBe('BANK_ACCOUNT');
    });
  });

  it('finds every identifier in a realistic clause', () => {
    const clause = `
      "SIFAT QURILISH" MChJ, STIR: 305123456,
      h/r: 20208000900001234567, tel: +998 90 123 45 67,
      e-mail: info@sifat.uz, direktor pasporti AA1234567.
      Shartnoma summasi: 12000000 so'm.
    `;

    expect(new Set(kinds(clause))).toEqual(
      new Set(['STIR', 'BANK_ACCOUNT', 'PHONE', 'EMAIL', 'PASSPORT']),
    );
  });

  it('does not resume mid-string on a second call', () => {
    // Module-level `g` regexes carry lastIndex between calls unless reset.
    const text = 'STIR: 305123456';

    expect(findPii(text)).toHaveLength(1);
    expect(findPii(text)).toHaveLength(1);
  });
});

describe('passesLuhn', () => {
  it('accepts a valid number', () => {
    expect(passesLuhn('8600123456789012')).toBe(true);
  });

  it('rejects one digit off', () => {
    expect(passesLuhn('8600123456789013')).toBe(false);
  });

  it('rejects something too short to be a card', () => {
    expect(passesLuhn('12345')).toBe(false);
  });
});

describe('redactPii', () => {
  it('replaces each identifier with a typed placeholder', () => {
    const { text } = redactPii('STIR: 305123456, tel: +998901234567');

    expect(text).toContain('[STIR_1]');
    expect(text).toContain('[PHONE_1]');
    expect(text).not.toContain('305123456');
    expect(text).not.toContain('901234567');
  });

  it('gives one value one placeholder throughout', () => {
    // Two mentions becoming _1 and _2 would have the model reasoning about two
    // different accounts.
    const { text, redactions } = redactPii(
      'h/r: 20208000900001234567 ... yana h/r: 2020 8000 9000 0123 4567',
    );

    expect(text.match(/\[BANK_ACCOUNT_1\]/g)).toHaveLength(2);
    expect(redactions).toHaveLength(1);
  });

  it('numbers distinct values separately', () => {
    const { redactions } = redactPii(
      'tel: +998901111111, tel: +998902222222',
    );

    expect(redactions.map((r) => r.placeholder)).toEqual([
      '[PHONE_1]',
      '[PHONE_2]',
    ]);
  });

  it('never returns a raw value in the redaction report', () => {
    // This report reaches an API response and a log; the raw values must not.
    const { redactions } = redactPii('STIR: 305123456');

    expect(redactions[0].masked).toBe('*****3456');
    expect(JSON.stringify(redactions)).not.toContain('305123456');
  });

  it('leaves clean text untouched', () => {
    const result = redactPii('Tomonlar quyidagilar haqida kelishdilar.');

    expect(result.clean).toBe(true);
    expect(result.text).toBe('Tomonlar quyidagilar haqida kelishdilar.');
  });

  it('keeps the surrounding text intact', () => {
    const { text } = redactPii('Buyurtmachi STIR: 305123456 hisoblanadi.');

    expect(text).toBe('Buyurtmachi STIR: [STIR_1] hisoblanadi.');
  });
});

describe('restorePii', () => {
  it('round-trips through a model response', () => {
    const original = 'STIR: 305123456, tel: +998901234567';
    const { text } = redactPii(original);

    // What the model hands back: the placeholders, moved around.
    const modelOutput = `Tomon (tel: ${'[PHONE_1]'}) — STIR ${'[STIR_1]'}.`;

    expect(restorePii(modelOutput, original)).toBe(
      'Tomon (tel: +998901234567) — STIR 305123456.',
    );
    expect(text).toContain('[STIR_1]');
  });

  it('leaves a placeholder the model invented as-is', () => {
    // A visible defect a reviewer catches, rather than an invisible one where
    // the nearest real value was silently substituted.
    const original = 'STIR: 305123456';

    expect(restorePii('Qiymat: [STIR_9]', original)).toBe('Qiymat: [STIR_9]');
  });

  it('is a no-op when the original held nothing', () => {
    expect(restorePii('Matn [STIR_1]', 'toza matn')).toBe('Matn [STIR_1]');
  });
});

describe('maskValue', () => {
  it('shows the last four digits only', () => {
    expect(maskValue('BANK_ACCOUNT', '20208000900001234567')).toBe(
      '****************4567',
    );
  });

  it('keeps an email recognisable without exposing the address', () => {
    expect(maskValue('EMAIL', 'info@acme-legal.uz')).toBe('i***@acme-legal.uz');
  });
});

describe('summarizePii', () => {
  it('counts distinct identifiers, not mentions', () => {
    const text = 'tel: +998901234567 ... yana +998 90 123 45 67 ... STIR: 305123456';

    expect(summarizePii(findPii(text))).toEqual({ PHONE: 1, STIR: 1 });
  });
});
