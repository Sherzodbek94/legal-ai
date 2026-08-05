import Link from 'next/link';
import type { Metadata } from 'next';
import { Badge } from '@/components/ui/badge';
import {
  EmptyState,
  Panel,
  PanelError,
  TableScroll,
  Td,
  Th,
} from '@/components/admin/panel';
import { apiGet } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { DOCUMENT_STATUS_TONE } from '@/lib/document-status';

interface DocumentRow {
  id: string;
  title: string;
  status: string;
  templateId: string | null;
  aiSummary: string | null;
  createdAt: string;
}

export const metadata: Metadata = { title: 'Documents' };

export default async function DocumentsPage() {
  const documents = await apiGet<DocumentRow[]>('/documents');

  return (
    <div className="mx-auto w-full max-w-6xl animate-rise-in space-y-6 px-4 py-8 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Documents</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Everything generated in this workspace. Each is pinned to the exact
            template version that produced it.
          </p>
        </div>
        <Link
          href="/templates"
          className="text-sm font-medium text-primary hover:underline"
        >
          Generate from a template →
        </Link>
      </div>

      <Panel title="All documents">
        {!documents.ok ? (
          <PanelError result={documents} />
        ) : documents.data.length === 0 ? (
          <EmptyState message="No documents yet. Pick a published template to generate one." />
        ) : (
          <TableScroll>
            <table className="w-full">
              <thead className="border-b border-border">
                <tr>
                  <Th>Title</Th>
                  <Th>Status</Th>
                  <Th>Created</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {documents.data.map((document) => (
                  <tr key={document.id}>
                    <Td>
                      <Link
                        href={`/documents/${document.id}`}
                        className="font-medium hover:underline"
                      >
                        {document.title}
                      </Link>
                      {document.aiSummary ? (
                        <div className="max-w-lg truncate text-xs text-muted-foreground">
                          {document.aiSummary}
                        </div>
                      ) : null}
                    </Td>
                    <Td>
                      <Badge variant={DOCUMENT_STATUS_TONE[document.status] ?? 'outline'}>
                        {document.status.replace(/_/g, ' ')}
                      </Badge>
                    </Td>
                    <Td className="whitespace-nowrap text-muted-foreground">
                      {formatDate(document.createdAt)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Panel>
    </div>
  );
}
