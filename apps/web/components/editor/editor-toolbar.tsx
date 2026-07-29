'use client';

import type { Editor } from '@tiptap/react';
import {
  Bold,
  Heading2,
  Heading3,
  Italic,
  List,
  ListOrdered,
  Quote,
  Redo2,
  Strikethrough,
  Undo2,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface ToolbarAction {
  label: string;
  icon: LucideIcon;
  run: () => void;
  isActive?: () => boolean;
  canRun?: () => boolean;
}

export function EditorToolbar({ editor }: { editor: Editor | null }) {
  if (!editor) {
    return (
      <div
        className="h-12 shrink-0 border-b border-border bg-muted/40"
        aria-hidden="true"
      />
    );
  }

  const groups: ToolbarAction[][] = [
    [
      {
        label: 'Bold',
        icon: Bold,
        run: () => editor.chain().focus().toggleBold().run(),
        isActive: () => editor.isActive('bold'),
      },
      {
        label: 'Italic',
        icon: Italic,
        run: () => editor.chain().focus().toggleItalic().run(),
        isActive: () => editor.isActive('italic'),
      },
      {
        label: 'Strikethrough',
        icon: Strikethrough,
        run: () => editor.chain().focus().toggleStrike().run(),
        isActive: () => editor.isActive('strike'),
      },
    ],
    [
      {
        label: 'Heading level 2',
        icon: Heading2,
        run: () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
        isActive: () => editor.isActive('heading', { level: 2 }),
      },
      {
        label: 'Heading level 3',
        icon: Heading3,
        run: () => editor.chain().focus().toggleHeading({ level: 3 }).run(),
        isActive: () => editor.isActive('heading', { level: 3 }),
      },
    ],
    [
      {
        label: 'Bullet list',
        icon: List,
        run: () => editor.chain().focus().toggleBulletList().run(),
        isActive: () => editor.isActive('bulletList'),
      },
      {
        label: 'Numbered list',
        icon: ListOrdered,
        run: () => editor.chain().focus().toggleOrderedList().run(),
        isActive: () => editor.isActive('orderedList'),
      },
      {
        label: 'Block quote',
        icon: Quote,
        run: () => editor.chain().focus().toggleBlockquote().run(),
        isActive: () => editor.isActive('blockquote'),
      },
    ],
    [
      {
        label: 'Undo',
        icon: Undo2,
        run: () => editor.chain().focus().undo().run(),
        canRun: () => editor.can().undo(),
      },
      {
        label: 'Redo',
        icon: Redo2,
        run: () => editor.chain().focus().redo().run(),
        canRun: () => editor.can().redo(),
      },
    ],
  ];

  return (
    <div
      role="toolbar"
      aria-label="Text formatting"
      aria-controls="document-editor-surface"
      className="flex h-12 shrink-0 flex-wrap items-center gap-1 border-b border-border bg-muted/40 px-2"
    >
      {groups.map((group, groupIndex) => (
        <div key={groupIndex} className="flex items-center gap-0.5">
          {groupIndex > 0 && (
            <span aria-hidden="true" className="mx-1 h-5 w-px bg-border" />
          )}
          {group.map((action) => {
            const Icon = action.icon;
            const active = action.isActive?.() ?? false;
            const disabled = action.canRun ? !action.canRun() : false;

            return (
              <button
                key={action.label}
                type="button"
                onClick={action.run}
                disabled={disabled}
                // Toggle buttons expose state via aria-pressed; action buttons
                // (undo/redo) omit it entirely.
                aria-pressed={action.isActive ? active : undefined}
                aria-label={action.label}
                title={action.label}
                className={cn(
                  'inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
                  'disabled:pointer-events-none disabled:opacity-40',
                  active
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                )}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
