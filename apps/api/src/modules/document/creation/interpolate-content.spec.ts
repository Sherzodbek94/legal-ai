import {
  collectPlaceholders,
  interpolateContent,
} from './interpolate-content';
import type { TipTapNode } from '../generator/tiptap-node';

const doc = (...content: TipTapNode[]): TipTapNode => ({ type: 'doc', content });
const para = (text: string): TipTapNode => ({
  type: 'paragraph',
  content: [{ type: 'text', text }],
});

describe('interpolateContent', () => {
  it('substitutes a declared placeholder', () => {
    const result = interpolateContent(doc(para('Between {{party}} and us.')), {
      party: 'Alpha LLC',
    });

    expect(result.content.content?.[0].content?.[0].text).toBe(
      'Between Alpha LLC and us.',
    );
    expect(result.unresolved).toEqual([]);
  });

  it('tolerates whitespace inside the braces', () => {
    const result = interpolateContent(doc(para('{{  party  }}')), {
      party: 'Beta',
    });

    expect(result.content.content?.[0].content?.[0].text).toBe('Beta');
  });

  it('replaces the same placeholder everywhere it appears', () => {
    const result = interpolateContent(
      doc(para('{{party}} agrees. {{party}} pays.')),
      { party: 'Gamma' },
    );

    expect(result.content.content?.[0].content?.[0].text).toBe(
      'Gamma agrees. Gamma pays.',
    );
  });

  it('renders an unsupplied placeholder as a blank and reports it', () => {
    const result = interpolateContent(doc(para('Signed by {{witness}}.')), {});

    // Not left as `{{witness}}`: template syntax must never reach a document a
    // human is asked to sign.
    expect(result.content.content?.[0].content?.[0].text).toBe(
      'Signed by __________.',
    );
    expect(result.unresolved).toEqual(['witness']);
  });

  it('treats an empty string as unsupplied', () => {
    const result = interpolateContent(doc(para('{{witness}}')), {
      witness: '',
    });

    expect(result.unresolved).toEqual(['witness']);
  });

  it('does not mutate the input tree', () => {
    const source = doc(para('{{party}}'));
    const before = JSON.stringify(source);

    interpolateContent(source, { party: 'Delta' });

    // The input is the stored template body, shared by every document generated
    // from that version — mutating it would rewrite the template.
    expect(JSON.stringify(source)).toBe(before);
  });

  it('substitutes into string attributes but leaves other types alone', () => {
    const result = interpolateContent(
      doc({
        type: 'paragraph',
        attrs: { title: 'Clause for {{party}}', level: 2 },
        content: [{ type: 'text', text: 'x' }],
      }),
      { party: 'Epsilon' },
    );

    expect(result.content.content?.[0].attrs).toEqual({
      title: 'Clause for Epsilon',
      level: 2,
    });
  });

  it('recurses through nested structures', () => {
    const result = interpolateContent(
      doc({
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [para('Owner: {{party}}')] },
        ],
      }),
      { party: 'Zeta' },
    );

    const item = result.content.content?.[0].content?.[0];
    expect(item?.content?.[0].content?.[0].text).toBe('Owner: Zeta');
  });

  it('leaves prose braces that are not placeholders untouched', () => {
    const result = interpolateContent(doc(para('Use { } for sets.')), {});

    expect(result.content.content?.[0].content?.[0].text).toBe(
      'Use { } for sets.',
    );
    expect(result.malformed).toBe(false);
  });

  it('flags a placeholder whose braces are split across text nodes', () => {
    // Bolding half a placeholder splits it into two text nodes, and neither
    // half matches — which would otherwise print `{{pa` into the contract.
    const result = interpolateContent(
      doc({
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Between {{pa' },
          { type: 'text', text: 'rty}} and us.', marks: [{ type: 'bold' }] },
        ],
      }),
      { party: 'Eta' },
    );

    expect(result.malformed).toBe(true);
  });

  it('returns an empty doc for a non-object body', () => {
    expect(interpolateContent(null, {}).content).toEqual({
      type: 'doc',
      content: [],
    });
  });
});

describe('collectPlaceholders', () => {
  it('finds every distinct key, sorted', () => {
    const found = collectPlaceholders(
      doc(para('{{b}} and {{a}}'), para('{{a}} again')),
    );

    expect(found).toEqual(['a', 'b']);
  });

  it('finds keys in string attributes', () => {
    expect(
      collectPlaceholders(
        doc({ type: 'paragraph', attrs: { title: '{{heading}}' } }),
      ),
    ).toEqual(['heading']);
  });

  it('returns nothing for a body with no placeholders', () => {
    expect(collectPlaceholders(doc(para('Plain text.')))).toEqual([]);
  });
});
