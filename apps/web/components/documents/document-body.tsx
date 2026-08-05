import { Fragment, type ReactNode } from 'react';

/**
 * Renders a stored document body.
 *
 * Built from React elements rather than `dangerouslySetInnerHTML`. The body is
 * assembled from user-supplied variables and, on the AI path, from model
 * output — injecting it as raw HTML would make a party's name an XSS vector.
 * React escapes every text child, so this is safe by construction rather than
 * by remembering to sanitise.
 *
 * Unrecognised nodes render their text rather than disappearing: the tree may
 * have been written by a newer editor build, and silently dropping a clause is
 * far worse than rendering it unstyled.
 */

interface Mark {
  type?: string;
  attrs?: Record<string, unknown>;
}

interface Node {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Mark[];
  content?: Node[];
}

export function DocumentBody({ content }: { content: unknown }) {
  if (!isNode(content)) {
    return (
      <p className="text-sm text-muted-foreground">
        This document has no body.
      </p>
    );
  }

  return (
    <div className="prose-legal space-y-4 text-sm leading-relaxed">
      {renderChildren(content)}
    </div>
  );
}

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function renderChildren(node: Node): ReactNode {
  return (node.content ?? []).map((child, index) => (
    <Fragment key={index}>{renderNode(child)}</Fragment>
  ));
}

function clampLevel(node: Node): 1 | 2 | 3 | 4 | 5 | 6 {
  const raw = Number(node.attrs?.level ?? 1);
  if (!Number.isFinite(raw)) return 1;
  return Math.min(6, Math.max(1, Math.trunc(raw))) as 1 | 2 | 3 | 4 | 5 | 6;
}

/**
 * A link target, rejecting anything that is not plain navigation.
 *
 * `javascript:` and `data:` hrefs are script execution on click, and this
 * content is not trusted.
 */
function safeHref(marks: Mark[] | undefined): string | undefined {
  const href = marks?.find((mark) => mark.type === 'link')?.attrs?.href;
  if (typeof href !== 'string') return undefined;
  const trimmed = href.trim();
  return /^(https?:\/\/|mailto:)/i.test(trimmed) ? trimmed : undefined;
}

function renderText(node: Node): ReactNode {
  let element: ReactNode = node.text ?? '';

  for (const mark of node.marks ?? []) {
    switch (mark.type) {
      case 'bold':
        element = <strong>{element}</strong>;
        break;
      case 'italic':
        element = <em>{element}</em>;
        break;
      case 'underline':
        element = <u>{element}</u>;
        break;
      case 'strike':
        element = <s>{element}</s>;
        break;
      case 'code':
        element = (
          <code className="rounded bg-muted px-1 py-0.5 text-xs">{element}</code>
        );
        break;
      default:
        break;
    }
  }

  const href = safeHref(node.marks);
  if (href) {
    return (
      <a
        href={href}
        rel="noopener noreferrer"
        target="_blank"
        className="text-primary underline underline-offset-2"
      >
        {element}
      </a>
    );
  }

  return element;
}

function renderNode(node: Node): ReactNode {
  switch (node.type) {
    case 'text':
      return renderText(node);

    case 'hardBreak':
      return <br />;

    case 'horizontalRule':
      return <hr className="my-6 border-border" />;

    case 'heading': {
      const level = clampLevel(node);
      const Tag = `h${level}` as 'h1';
      const size =
        level === 1
          ? 'text-xl font-semibold'
          : level === 2
            ? 'text-base font-semibold'
            : 'text-sm font-semibold';
      return <Tag className={`${size} mt-6 first:mt-0`}>{renderChildren(node)}</Tag>;
    }

    case 'paragraph':
      return <p>{renderChildren(node)}</p>;

    case 'bulletList':
      return (
        <ul className="ml-5 list-disc space-y-1">{renderChildren(node)}</ul>
      );

    case 'orderedList':
      return (
        <ol className="ml-5 list-decimal space-y-1">{renderChildren(node)}</ol>
      );

    case 'listItem':
      return <li>{renderChildren(node)}</li>;

    case 'blockquote':
      return (
        <blockquote className="border-l-2 border-border pl-4 italic text-muted-foreground">
          {renderChildren(node)}
        </blockquote>
      );

    case 'codeBlock':
      return (
        <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
          <code>{renderChildren(node)}</code>
        </pre>
      );

    case 'table':
      return (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <tbody>{renderChildren(node)}</tbody>
          </table>
        </div>
      );

    case 'tableRow':
      return <tr>{renderChildren(node)}</tr>;

    case 'tableHeader':
      return (
        <th className="border border-border px-3 py-2 text-left font-semibold">
          {renderChildren(node)}
        </th>
      );

    case 'tableCell':
      return (
        <td className="border border-border px-3 py-2 align-top">
          {renderChildren(node)}
        </td>
      );

    default:
      // Unknown node: keep its content visible rather than dropping a clause.
      return node.content ? <div>{renderChildren(node)}</div> : (node.text ?? null);
  }
}
