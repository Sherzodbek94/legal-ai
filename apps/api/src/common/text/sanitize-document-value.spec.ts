import { sanitizeDocumentValue } from './sanitize-document-value';

/**
 * Built with fromCharCode rather than written literally: control and invisible
 * characters are unreadable in source and get silently mangled by editors and
 * diff tools.
 */
const ch = (code: number) => String.fromCharCode(code);

describe('sanitizeDocumentValue', () => {
  it('keeps punctuation the prompt sanitiser strips', () => {
    // The prompt sanitiser removes {}[]<> because they escape a delimited data
    // block. In a contract they are ordinary punctuation, and removing them
    // corrupts the party's legal name.
    expect(sanitizeDocumentValue('Alpha [Holding] <LLC> {UZ}')).toBe(
      'Alpha [Holding] <LLC> {UZ}',
    );
  });

  it('preserves internal whitespace exactly', () => {
    expect(sanitizeDocumentValue('Line one\nLine two')).toBe(
      'Line one\nLine two',
    );
  });

  it('strips control characters that would corrupt a .docx', () => {
    // A .docx is a zip of XML; a raw control character makes the file
    // unopenable in Word.
    expect(sanitizeDocumentValue(`Alpha${ch(0x07)}LLC`)).toBe('AlphaLLC');
    expect(sanitizeDocumentValue(`Alpha${ch(0x00)}LLC`)).toBe('AlphaLLC');
  });

  it('keeps tab and newline, which carry meaning', () => {
    expect(sanitizeDocumentValue('a\tb\nc')).toBe('a\tb\nc');
  });

  it('strips zero-width and bidirectional characters', () => {
    // Invisible to a reviewer but able to reorder how a clause visually reads.
    expect(sanitizeDocumentValue(`Alpha${ch(0x200b)}LLC${ch(0x202e)}`)).toBe(
      'AlphaLLC',
    );
  });

  it('trims surrounding whitespace', () => {
    expect(sanitizeDocumentValue('  Alpha LLC  ')).toBe('Alpha LLC');
  });

  it('bounds length', () => {
    expect(sanitizeDocumentValue('x'.repeat(5000))).toHaveLength(2000);
  });

  it('honours an explicit maximum', () => {
    expect(sanitizeDocumentValue('abcdef', 3)).toBe('abc');
  });
});
