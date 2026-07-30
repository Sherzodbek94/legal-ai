import { escapeHtml, tiptapToHtml } from './tiptap-to-html';

const doc = (...content: unknown[]) => ({ type: 'doc', content });
const paragraph = (...content: unknown[]) => ({ type: 'paragraph', content });
const text = (value: string, marks?: { type: string; attrs?: unknown }[]) => ({
  type: 'text',
  text: value,
  ...(marks ? { marks } : {}),
});

describe('escapeHtml', () => {
  it('escapes every character with meaning in markup', () => {
    expect(escapeHtml(`<&>"'`)).toBe('&lt;&amp;&gt;&quot;&#39;');
  });

  it('escapes the ampersand before the entities it introduces', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });
});

describe('tiptapToHtml', () => {
  describe('injection hardening', () => {
    it('escapes a script tag in document text', () => {
      const html = tiptapToHtml(
        doc(paragraph(text('<script>fetch("http://evil.test")</script>'))),
      );
      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;script&gt;');
    });

    it('escapes markup smuggled through a party name', () => {
      const html = tiptapToHtml(
        doc(paragraph(text('Acme" onload="alert(1)'))),
      );
      expect(html).not.toContain('onload="alert(1)"');
      expect(html).toContain('&quot;');
    });

    it('drops a javascript: link target', () => {
      const html = tiptapToHtml(
        doc(
          paragraph(
            text('click', [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }]),
          ),
        ),
      );
      expect(html).not.toContain('javascript:');
      expect(html).not.toContain('<a ');
      expect(html).toContain('click');
    });

    it('drops a data: link target', () => {
      const html = tiptapToHtml(
        doc(
          paragraph(
            text('x', [
              { type: 'link', attrs: { href: 'data:text/html,<script>1</script>' } },
            ]),
          ),
        ),
      );
      expect(html).not.toContain('<a ');
    });

    it('keeps an ordinary https link', () => {
      const html = tiptapToHtml(
        doc(
          paragraph(
            text('terms', [
              { type: 'link', attrs: { href: 'https://example.com/terms' } },
            ]),
          ),
        ),
      );
      expect(html).toContain('href="https://example.com/terms"');
      expect(html).toContain('rel="noopener noreferrer"');
    });

    it('escapes a quote inside an otherwise valid href', () => {
      const html = tiptapToHtml(
        doc(
          paragraph(
            text('x', [
              { type: 'link', attrs: { href: 'https://e.test/"><script>' } },
            ]),
          ),
        ),
      );
      expect(html).not.toContain('"><script>');
      expect(html).toContain('&quot;');
    });
  });

  describe('block nodes', () => {
    it('renders paragraphs', () => {
      expect(tiptapToHtml(doc(paragraph(text('Hello'))))).toBe('<p>Hello</p>');
    });

    it('preserves an empty paragraph as a deliberate blank line', () => {
      expect(tiptapToHtml(doc({ type: 'paragraph' }))).toBe('<p>&nbsp;</p>');
    });

    it('renders headings at their declared level', () => {
      const html = tiptapToHtml(
        doc({ type: 'heading', attrs: { level: 2 }, content: [text('Terms')] }),
      );
      expect(html).toBe('<h2>Terms</h2>');
    });

    it('clamps an out-of-range heading level', () => {
      const html = tiptapToHtml(
        doc({ type: 'heading', attrs: { level: 99 }, content: [text('X')] }),
      );
      expect(html).toBe('<h6>X</h6>');
    });

    it('renders bullet lists', () => {
      const html = tiptapToHtml(
        doc({
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [paragraph(text('one'))] },
            { type: 'listItem', content: [paragraph(text('two'))] },
          ],
        }),
      );
      expect(html).toBe('<ul><li><p>one</p></li><li><p>two</p></li></ul>');
    });

    it('honours an ordered list start offset', () => {
      const html = tiptapToHtml(
        doc({
          type: 'orderedList',
          attrs: { start: 5 },
          content: [{ type: 'listItem', content: [paragraph(text('five'))] }],
        }),
      );
      expect(html).toContain('<ol start="5">');
    });

    it('renders tables with header cells and spans', () => {
      const html = tiptapToHtml(
        doc({
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                { type: 'tableHeader', content: [paragraph(text('Item'))] },
                {
                  type: 'tableCell',
                  attrs: { colspan: 2 },
                  content: [paragraph(text('Value'))],
                },
              ],
            },
          ],
        }),
      );
      expect(html).toContain('<th><p>Item</p></th>');
      expect(html).toContain('<td colspan="2">');
    });

    it('renders a horizontal rule and a hard break', () => {
      expect(tiptapToHtml(doc({ type: 'horizontalRule' }))).toBe('<hr />');
      expect(tiptapToHtml(doc(paragraph({ type: 'hardBreak' })))).toBe(
        '<p><br /></p>',
      );
    });

    it('escapes the contents of a code block', () => {
      const html = tiptapToHtml(
        doc({ type: 'codeBlock', content: [text('<b>not bold</b>')] }),
      );
      expect(html).toBe('<pre><code>&lt;b&gt;not bold&lt;/b&gt;</code></pre>');
    });

    it('applies a supported text alignment', () => {
      const html = tiptapToHtml(
        doc({ type: 'paragraph', attrs: { textAlign: 'center' }, content: [text('X')] }),
      );
      expect(html).toBe('<p style="text-align:center">X</p>');
    });

    it('ignores an unrecognised alignment rather than emitting it', () => {
      const html = tiptapToHtml(
        doc({
          type: 'paragraph',
          attrs: { textAlign: 'expression(alert(1))' },
          content: [text('X')],
        }),
      );
      expect(html).toBe('<p>X</p>');
    });
  });

  describe('marks', () => {
    it('renders bold, italic, underline, and strike', () => {
      const html = tiptapToHtml(
        doc(
          paragraph(
            text('x', [
              { type: 'bold' },
              { type: 'italic' },
              { type: 'underline' },
              { type: 'strike' },
            ]),
          ),
        ),
      );
      expect(html).toContain('<strong>');
      expect(html).toContain('<em>');
      expect(html).toContain('<u>');
      expect(html).toContain('<s>');
    });
  });

  describe('degradation', () => {
    it('keeps the text of a node type it does not recognise', () => {
      const html = tiptapToHtml(
        doc({ type: 'futureCallout', content: [paragraph(text('important clause'))] }),
      );
      expect(html).toContain('important clause');
    });

    it('returns empty output for a non-document value', () => {
      expect(tiptapToHtml(null)).toBe('');
      expect(tiptapToHtml('a string')).toBe('');
      expect(tiptapToHtml([])).toBe('');
    });

    it('survives a document with no content array', () => {
      expect(tiptapToHtml({ type: 'doc' })).toBe('');
    });
  });
});
