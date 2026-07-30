/**
 * Renders a TipTap document to HTML for the PDF pipeline.
 *
 * Every string that reaches the output is escaped. The body is AI-generated
 * from user-supplied variables and then loaded into a real Chromium page — an
 * unescaped `<script>` in a contract party's name is code execution inside the
 * renderer, with the filesystem and network of whatever host it runs on.
 * Escaping here is the only thing standing between those two facts.
 */
import {
  headingLevel,
  isTipTapNode,
  safeLinkHref,
  type TipTapNode,
} from './tiptap-node';

const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPE_MAP[char]);
}

/** Wraps `inner` in the tags implied by a text node's marks. */
function applyMarks(node: TipTapNode, inner: string): string {
  let html = inner;

  // Order matters only for readability of the output; nesting is equivalent.
  if (node.marks?.some((mark) => mark.type === 'code')) {
    html = `<code>${html}</code>`;
  }
  if (node.marks?.some((mark) => mark.type === 'bold')) {
    html = `<strong>${html}</strong>`;
  }
  if (node.marks?.some((mark) => mark.type === 'italic')) {
    html = `<em>${html}</em>`;
  }
  if (node.marks?.some((mark) => mark.type === 'underline')) {
    html = `<u>${html}</u>`;
  }
  if (node.marks?.some((mark) => mark.type === 'strike')) {
    html = `<s>${html}</s>`;
  }

  const href = safeLinkHref(node);
  if (href) {
    // `rel` is belt and braces: the page is rendered headless and never
    // navigated, but a printed PDF can still carry a live annotation.
    html = `<a href="${escapeHtml(href)}" rel="noopener noreferrer">${html}</a>`;
  }

  return html;
}

function renderChildren(node: TipTapNode): string {
  return (node.content ?? [])
    .filter(isTipTapNode)
    .map((child) => renderNode(child))
    .join('');
}

function renderNode(node: TipTapNode): string {
  switch (node.type) {
    case 'text':
      return applyMarks(node, escapeHtml(node.text ?? ''));

    case 'paragraph': {
      const inner = renderChildren(node);
      const align = node.attrs?.textAlign;
      const style =
        typeof align === 'string' && ['left', 'center', 'right', 'justify'].includes(align)
          ? ` style="text-align:${align}"`
          : '';
      // An empty paragraph is a deliberate blank line in a contract, not noise.
      return `<p${style}>${inner || '&nbsp;'}</p>`;
    }

    case 'heading': {
      const level = headingLevel(node);
      return `<h${level}>${renderChildren(node)}</h${level}>`;
    }

    case 'bulletList':
      return `<ul>${renderChildren(node)}</ul>`;

    case 'orderedList': {
      const start = Number(node.attrs?.start ?? 1);
      const startAttr = Number.isFinite(start) && start !== 1 ? ` start="${Math.trunc(start)}"` : '';
      return `<ol${startAttr}>${renderChildren(node)}</ol>`;
    }

    case 'listItem':
      return `<li>${renderChildren(node)}</li>`;

    case 'blockquote':
      return `<blockquote>${renderChildren(node)}</blockquote>`;

    case 'codeBlock':
      return `<pre><code>${escapeHtml(textContentOf(node))}</code></pre>`;

    case 'horizontalRule':
      return '<hr />';

    case 'hardBreak':
      return '<br />';

    case 'table':
      return `<table>${renderChildren(node)}</table>`;

    case 'tableRow':
      return `<tr>${renderChildren(node)}</tr>`;

    case 'tableHeader':
    case 'tableCell': {
      const tag = node.type === 'tableHeader' ? 'th' : 'td';
      const colspan = Number(node.attrs?.colspan ?? 1);
      const rowspan = Number(node.attrs?.rowspan ?? 1);
      const attrs = [
        colspan > 1 ? ` colspan="${Math.trunc(colspan)}"` : '',
        rowspan > 1 ? ` rowspan="${Math.trunc(rowspan)}"` : '',
      ].join('');
      return `<${tag}${attrs}>${renderChildren(node)}</${tag}>`;
    }

    case 'doc':
      return renderChildren(node);

    default:
      // Unknown node from a newer editor build: keep the words rather than
      // silently dropping a clause. A contract missing a paragraph is worse
      // than one whose formatting was lost.
      if (node.content?.length) return renderChildren(node);
      return node.text ? escapeHtml(node.text) : '';
  }
}

function textContentOf(node: TipTapNode): string {
  if (typeof node.text === 'string') return node.text;
  return (node.content ?? []).map(textContentOf).join('');
}

/** Renders the document body. The surrounding page comes from `html-document`. */
export function tiptapToHtml(doc: unknown): string {
  if (!isTipTapNode(doc)) return '';
  return renderNode(doc);
}
