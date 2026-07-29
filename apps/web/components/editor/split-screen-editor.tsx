import { Download, Share2, Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { AnalysisPanel } from './analysis-panel';
import { DocumentEditor } from './document-editor';

interface SplitScreenEditorProps {
  documentTitle: string;
  matterName: string;
}

/**
 * Split-screen shell: the editable document on the left, AI analysis on the
 * right. Panes sit side by side from `lg` up and stack on narrow viewports.
 */
export function SplitScreenEditor({
  documentTitle,
  matterName,
}: SplitScreenEditorProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3 sm:px-6">
        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold tracking-tight">
            {documentTitle}
          </h1>
          <p className="truncate text-xs text-muted-foreground">{matterName}</p>
        </div>

        <Badge variant="success" className="shrink-0">
          Analyzed
        </Badge>

        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" className="hidden sm:inline-flex">
            <Share2 aria-hidden="true" />
            Share
          </Button>
          <Button variant="outline" size="sm" className="hidden sm:inline-flex">
            <Download aria-hidden="true" />
            Export
          </Button>
          <Button size="sm">
            <Sparkles aria-hidden="true" />
            Re-analyze
          </Button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,26rem)]">
        <section
          aria-labelledby="editor-heading"
          className="flex min-h-0 min-w-0 flex-col border-b border-border lg:border-b-0 lg:border-r"
        >
          <h2 id="editor-heading" className="sr-only">
            Document editor
          </h2>
          <DocumentEditor />
        </section>

        <AnalysisPanel />
      </div>
    </div>
  );
}
