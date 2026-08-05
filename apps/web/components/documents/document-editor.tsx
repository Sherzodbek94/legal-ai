'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import {
  Bold,
  Heading2,
  Italic,
  List,
  ListOrdered,
  Loader2,
  Pencil,
  Quote,
  Redo2,
  Save,
  Strikethrough,
  Undo2,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { DocumentBody } from './document-body';
import { apiBaseUrl } from '@/lib/api-config';
import { useHydrated } from '@/lib/use-hydrated';

/**
 * Editing a generated document.
 *
 * Read-only until *Edit* is pressed, rather than an always-live editor. A
 * contract is read far more often than it is changed, and a page that puts a
 * caret in the text the moment it loads invites an accidental keystroke into a
 * document somebody is about to sign.
 *
 * The stored body is TipTap JSON — the same shape the generator writes and the
 * PDF and DOCX renderers read — so an edited document exports through exactly
 * the path a generated one does, with no separate conversion to keep in step.
 */
export function DocumentEditor({
  documentId,
  content,
  revision,
  editable,
  lockedReason,
}: {
  documentId: string;
  content: unknown;
  revision: number;
  /** False while the document is awaiting approval or has completed one. */
  editable: boolean;
  lockedReason: string | null;
}) {
  const hydrated = useHydrated();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  const editor = useEditor({
    extensions: [StarterKit],
    content: (content as object) ?? '',
    editable: false,
    // Rendering the editor on the server and again on the client produces two
    // different trees for the same document; TipTap says so explicitly.
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: 'prose-legal focus:outline-none min-h-[24rem]',
      },
    },
  });

  useEffect(() => {
    editor?.setEditable(editing);
  }, [editor, editing]);

  const save = useCallback(async () => {
    if (!editor) return;

    setSaving(true);
    setError(null);

    try {
      const response = await fetch(`${apiBaseUrl}/documents/${documentId}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: editor.getJSON(),
          // What the editor was showing when the user started. The API returns
          // 409 rather than overwriting a colleague's save.
          expectedRevision: revision,
        }),
      });

      if (response.status === 409) {
        setStale(true);
        return;
      }

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          message?: string | { message?: string };
        } | null;

        const message =
          typeof body?.message === 'string'
            ? body.message
            : body?.message?.message;

        setError(message ?? 'Could not save. Please try again.');
        return;
      }

      // A full navigation, not a client-side state update: the page is a
      // server component and its approval panel, status badge, and version
      // list all read from the request. Patching one of them here would leave
      // the rest showing the document as it was before the save.
      window.location.reload();
    } catch {
      setError('Could not reach the server. Check your connection.');
    } finally {
      setSaving(false);
    }
  }, [documentId, editor, revision]);

  if (!editable) {
    return (
      <div className="space-y-3">
        {lockedReason ? (
          <p className="text-xs text-muted-foreground">{lockedReason}</p>
        ) : null}
        <DocumentBody content={content} />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {stale ? (
        <Alert variant="warning" title="Someone else saved this document">
          Your copy is out of date. Reload to see their changes — saving now
          would overwrite them.
          <div className="mt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => window.location.reload()}
            >
              Reload
            </Button>
          </div>
        </Alert>
      ) : null}

      {error ? (
        <p role="alert" className="animate-fade-in text-xs text-destructive">
          {error}
        </p>
      ) : null}

      {editing ? (
        <Toolbar editor={editor} />
      ) : (
        <div className="flex justify-end">
          <Button
            type="button"
            variant="outline"
            onClick={() => setEditing(true)}
            disabled={!hydrated}
          >
            <Pencil aria-hidden="true" />
            Edit
          </Button>
        </div>
      )}

      <div
        className={
          editing
            ? 'rounded-md border border-input bg-background p-4 transition-[border-color] duration-150 focus-within:ring-2 focus-within:ring-ring'
            : ''
        }
      >
        {editor ? <EditorContent editor={editor} /> : <DocumentBody content={content} />}
      </div>

      {editing ? (
        <div className="flex items-center gap-2">
          <Button type="button" onClick={() => void save()} disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="animate-spin" aria-hidden="true" />
                Saving…
              </>
            ) : (
              <>
                <Save aria-hidden="true" />
                Save changes
              </>
            )}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={saving}
            onClick={() => {
              // Reset from the stored body rather than trusting the editor's
              // own history: undo has a depth limit, and "cancel" that leaves
              // some edits behind is worse than no cancel at all.
              editor?.commands.setContent((content as object) ?? '');
              setEditing(false);
              setError(null);
            }}
          >
            <X aria-hidden="true" />
            Cancel
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The formatting controls.
 *
 * Deliberately short. This is a legal document, not a newsletter: headings,
 * emphasis, and lists are what a contract uses, and every control beyond that
 * is one more way to produce a body the PDF and DOCX renderers have no mapping
 * for — `tiptap-to-docx` handles this set and would silently drop the rest.
 */
function Toolbar({ editor }: { editor: Editor | null }) {
  if (!editor) return null;

  return (
    <div className="flex flex-wrap items-center gap-1 rounded-md border border-border bg-muted/40 p-1">
      <ToolbarButton
        label="Undo"
        icon={Undo2}
        onClick={() => editor.chain().focus().undo().run()}
        disabled={!editor.can().undo()}
      />
      <ToolbarButton
        label="Redo"
        icon={Redo2}
        onClick={() => editor.chain().focus().redo().run()}
        disabled={!editor.can().redo()}
      />

      <span aria-hidden="true" className="mx-1 h-5 w-px bg-border" />

      <ToolbarButton
        label="Heading"
        icon={Heading2}
        active={editor.isActive('heading', { level: 2 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
      />
      <ToolbarButton
        label="Bold"
        icon={Bold}
        active={editor.isActive('bold')}
        onClick={() => editor.chain().focus().toggleBold().run()}
      />
      <ToolbarButton
        label="Italic"
        icon={Italic}
        active={editor.isActive('italic')}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      />
      <ToolbarButton
        label="Strikethrough"
        icon={Strikethrough}
        active={editor.isActive('strike')}
        onClick={() => editor.chain().focus().toggleStrike().run()}
      />

      <span aria-hidden="true" className="mx-1 h-5 w-px bg-border" />

      <ToolbarButton
        label="Bulleted list"
        icon={List}
        active={editor.isActive('bulletList')}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      />
      <ToolbarButton
        label="Numbered list"
        icon={ListOrdered}
        active={editor.isActive('orderedList')}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      />
      <ToolbarButton
        label="Quote"
        icon={Quote}
        active={editor.isActive('blockquote')}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
      />
    </div>
  );
}

function ToolbarButton({
  label,
  icon: Icon,
  onClick,
  active,
  disabled,
}: {
  label: string;
  icon: typeof Bold;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      // `aria-pressed` rather than only a colour: a screen reader user has no
      // other way to know bold is already on.
      aria-pressed={active}
      title={label}
      className={`press rounded p-1.5 transition-colors duration-150 hover:bg-accent disabled:opacity-40 disabled:hover:bg-transparent ${
        active ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'
      }`}
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </button>
  );
}
