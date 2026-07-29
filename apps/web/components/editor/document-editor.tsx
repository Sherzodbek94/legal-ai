'use client';

import * as React from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { EditorToolbar } from './editor-toolbar';

const INITIAL_CONTENT = `
  <h2>Mutual Non-Disclosure Agreement</h2>
  <p>
    This Mutual Non-Disclosure Agreement (the &ldquo;Agreement&rdquo;) is entered
    into as of the Effective Date by and between the parties identified below.
  </p>
  <h3>1. Definition of Confidential Information</h3>
  <p>
    &ldquo;Confidential Information&rdquo; means any non-public information
    disclosed by one party to the other, whether orally, in writing, or by
    inspection of tangible objects.
  </p>
  <ul>
    <li>Business plans, forecasts, and customer lists</li>
    <li>Technical data, designs, and source code</li>
    <li>Pricing, terms, and negotiation history</li>
  </ul>
  <h3>2. Term</h3>
  <p>
    The obligations set out in this Agreement survive for a period of three (3)
    years following the date of disclosure.
  </p>
`;

export function DocumentEditor() {
  const [wordCount, setWordCount] = React.useState(0);

  const editor = useEditor({
    extensions: [StarterKit],
    content: INITIAL_CONTENT,
    // Required for the Next.js App Router: defer the first render to the client
    // so SSR output and hydration agree.
    immediatelyRender: false,
    editorProps: {
      attributes: {
        id: 'document-editor-surface',
        'aria-label': 'Document body. Rich text editor.',
        'aria-multiline': 'true',
        role: 'textbox',
        class: 'px-6 py-6 text-[0.9375rem] text-foreground focus:outline-none',
      },
    },
    onUpdate: ({ editor: instance }) => {
      const text = instance.getText().trim();
      setWordCount(text ? text.split(/\s+/).length : 0);
    },
  });

  React.useEffect(() => {
    if (!editor) return;
    const text = editor.getText().trim();
    setWordCount(text ? text.split(/\s+/).length : 0);
  }, [editor]);

  return (
    <div className="tiptap-surface flex h-full min-h-0 flex-col bg-card">
      <EditorToolbar editor={editor} />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {editor ? (
          <EditorContent editor={editor} />
        ) : (
          <p className="px-6 py-6 text-sm text-muted-foreground">
            Loading editor&hellip;
          </p>
        )}
      </div>

      <div className="flex h-9 shrink-0 items-center justify-between border-t border-border px-4 text-xs text-muted-foreground">
        <span aria-live="polite">{wordCount} words</span>
        <span>Draft &middot; autosave pending</span>
      </div>
    </div>
  );
}
