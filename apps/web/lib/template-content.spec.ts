/**
 * Plain text <-> TipTap conversion.
 *
 * Two properties matter. A stored version must survive a re-edit — text that
 * changes shape every time an author opens it loses their formatting one save
 * at a time. And placeholders must be collected exactly as the API collects
 * them, because the API rejects a publish referencing anything the schema does
 * not declare; a mismatch here means the editor lets an author publish
 * something the server will refuse.
 */
import { collectPlaceholders, textToTipTap, tipTapToText } from './template-content';

describe('textToTipTap', () => {
  it('makes a paragraph out of a plain block', () => {
    expect(textToTipTap('Shartnoma matni')).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Shartnoma matni' }] }],
    });
  });

  it('separates blocks on a blank line', () => {
    expect(textToTipTap('birinchi\n\nikkinchi').content).toHaveLength(2);
  });

  it('reads # as a heading, at the level of the hashes', () => {
    const [heading] = textToTipTap('## Shartlar').content!;

    expect(heading.type).toBe('heading');
    expect(heading.attrs).toEqual({ level: 2 });
    expect(heading.content).toEqual([{ type: 'text', text: 'Shartlar' }]);
  });

  it('does not treat a fourth hash as a heading', () => {
    // Only three levels exist; `#### x` is body text that happens to start
    // with hashes.
    expect(textToTipTap('#### x').content![0].type).toBe('paragraph');
  });

  it('turns single newlines into hard breaks', () => {
    // Numbered clauses are written one per line. Without this they run
    // together into a single sentence.
    const [paragraph] = textToTipTap('1. Birinchi\n2. Ikkinchi').content!;

    expect(paragraph.content!.map((node) => node.type)).toEqual([
      'text',
      'hardBreak',
      'text',
    ]);
  });

  it('never produces an empty document', () => {
    // TipTap refuses to mount on a doc with no content, which would break the
    // editor rather than show it empty.
    for (const source of ['', '   ', '\n\n\n']) {
      expect(textToTipTap(source).content).toEqual([{ type: 'paragraph' }]);
    }
  });
});

describe('tipTapToText', () => {
  it('reverses a heading', () => {
    expect(tipTapToText(textToTipTap('# Sarlavha'))).toBe('# Sarlavha');
  });

  it.each([
    ['a single paragraph', 'Oddiy matn'],
    ['two blocks', 'birinchi\n\nikkinchi'],
    ['a heading and a body', '# Sarlavha\n\nmatn'],
    ['hard breaks', '1. Birinchi\n2. Ikkinchi'],
    ['a placeholder', 'Tomon: {{party_name}}'],
  ])('round-trips %s unchanged', (_case, source) => {
    // The real requirement: opening a stored version and saving it again must
    // not rewrite the author's text.
    expect(tipTapToText(textToTipTap(source))).toBe(source);
  });

  it('clamps an out-of-range heading level rather than emitting nonsense', () => {
    expect(tipTapToText({ type: 'doc', content: [{ type: 'heading', attrs: { level: 9 }, content: [{ type: 'text', text: 'x' }] }] })).toBe('### x');
    expect(tipTapToText({ type: 'doc', content: [{ type: 'heading', attrs: { level: 0 }, content: [{ type: 'text', text: 'x' }] }] })).toBe('# x');
  });

  it.each([null, undefined, {}, 'a string'])('returns empty text for %p', (node) => {
    expect(tipTapToText(node)).toBe('');
  });
});

describe('collectPlaceholders', () => {
  it('finds placeholders in first-appearance order', () => {
    expect(collectPlaceholders('{{buyer}} va {{seller}}')).toEqual(['buyer', 'seller']);
  });

  it('reports a repeated placeholder once', () => {
    expect(collectPlaceholders('{{party}} ... {{party}}')).toEqual(['party']);
  });

  it('tolerates the spacing authors actually type', () => {
    expect(collectPlaceholders('{{ party }}')).toEqual(['party']);
  });

  it('ignores markers that are not valid keys', () => {
    // The API's regex is the authority and accepts only [a-zA-Z0-9_]. Anything
    // else is literal text, and treating it as a key here would let an author
    // publish a body the server rejects.
    expect(collectPlaceholders('{{a-b}} {{ }} {{}} {{a.b}}')).toEqual([]);
  });

  it('finds nothing in a body with no placeholders', () => {
    expect(collectPlaceholders('oddiy matn')).toEqual([]);
  });

  it('accepts digits and underscores in a key', () => {
    expect(collectPlaceholders('{{contract_no_2}}')).toEqual(['contract_no_2']);
  });
});
