import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { EmptyState, Panel, PanelError } from '@/components/admin/panel';
import { DocumentEditor } from '@/components/documents/document-editor';
import {
  DecideApproval,
  SubmitForApproval,
} from '@/components/documents/approval-actions';
import { apiGet } from '@/lib/api';
import { apiBaseUrl } from '@/lib/api-config';
import { formatDateTime } from '@/lib/format';
import { DOCUMENT_STATUS_TONE, EDITABLE, SUBMITTABLE } from '@/lib/document-status';
import { decideApproval, submitForApproval } from './actions';

interface DocumentDetail {
  id: string;
  title: string;
  status: string;
  content: unknown;
  promptVariables: Record<string, unknown> | null;
  aiSummary: string | null;
  rejectionReason: string | null;
  templateId: string | null;
  templateVersionId: string | null;
  approvalRound: number;
  revision: number;
  submittedAt: string | null;
  completedAt: string | null;
  generatedAt: string | null;
  createdAt: string;
}

interface ApprovalStep {
  id: string;
  round: number;
  stepOrder: number;
  requiredRole: string;
  label: string | null;
  status: string;
  decidedById: string | null;
  decidedAt: string | null;
  comment: string | null;
}

interface ApprovalState {
  status: string;
  round: number;
  currentStep?: ApprovalStep;
  steps: ApprovalStep[];
  history: ApprovalStep[];
}

export const metadata = { title: 'Document' };

export default async function DocumentPage({
  params,
}: {
  params: { id: string };
}) {
  const [document, approvals] = await Promise.all([
    apiGet<DocumentDetail>(`/documents/${params.id}`),
    apiGet<ApprovalState>(`/documents/${params.id}/approvals`),
  ]);

  if (!document.ok) {
    if (document.status === 404) notFound();
    return (
      <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
        <Panel title="Document">
          <PanelError result={document} />
        </Panel>
      </div>
    );
  }

  const doc = document.data;
  const canSubmit = SUBMITTABLE.has(doc.status);
  const awaitingDecision = doc.status === 'PENDING_APPROVAL';

  // Mirrors DocumentEditService.LOCKED. Stated here as well so the page does
  // not offer a control the API is going to refuse — the alternative is a user
  // typing a clause and learning on save that it was never allowed.
  const lockedReason = EDITABLE.has(doc.status)
    ? null
    : awaitingDecision
      ? 'Awaiting approval. Withdraw it to make changes — approvers must decide on the text they were shown.'
      : 'This document has completed its approval chain and can no longer be edited.';

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 px-4 py-8 sm:px-6 lg:px-8">
      <div>
        <Link
          href="/documents"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← Documents
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{doc.title}</h1>
          <Badge variant={DOCUMENT_STATUS_TONE[doc.status] ?? 'outline'}>
            {doc.status.replace(/_/g, ' ')}
          </Badge>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Created {formatDateTime(doc.createdAt)}
          {doc.templateVersionId ? ' · pinned to the version that produced it' : ''}
        </p>
      </div>

      {doc.aiSummary ? (
        <div className="rounded-md border border-warning/40 bg-warning/10 px-4 py-3 text-sm">
          <span className="font-medium">Review before signing: </span>
          {doc.aiSummary}
        </div>
      ) : null}

      {doc.rejectionReason ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <span className="font-medium">Rejected: </span>
          {doc.rejectionReason}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {/* Plain links, not fetches: the export streams a file, and letting the
            browser navigate hands it the download without buffering megabytes
            of PDF through JavaScript first. */}
        <ExportLink id={doc.id} format="pdf" />
        <ExportLink id={doc.id} format="docx" />
      </div>

      <Panel
        title="Document"
        description={`Round ${doc.approvalRound} · revision ${doc.revision}`}
      >
        <div className="px-5 py-4">
          <DocumentEditor
            documentId={doc.id}
            content={doc.content}
            revision={doc.revision}
            editable={EDITABLE.has(doc.status)}
            lockedReason={lockedReason}
          />
        </div>
      </Panel>

      {canSubmit ? (
        <Panel
          title="Approval"
          description="Starts the chain declared by the template version"
        >
          <SubmitForApproval action={submitForApproval.bind(null, doc.id)} />
        </Panel>
      ) : null}

      {awaitingDecision ? (
        <Panel
          title="Decision"
          description="Only the approver this step names can decide; the API enforces it."
        >
          <DecideApproval action={decideApproval.bind(null, doc.id)} />
        </Panel>
      ) : null}

      <Panel title="Approval chain">
        {!approvals.ok ? (
          <PanelError result={approvals} />
        ) : approvals.data.steps.length === 0 ? (
          <EmptyState message="Not submitted yet." />
        ) : (
          <ol className="divide-y divide-border">
            {approvals.data.steps.map((step) => (
              <li key={step.id} className="flex items-start gap-4 px-5 py-3">
                <span className="mt-0.5 w-6 shrink-0 text-sm tabular-nums text-muted-foreground">
                  {step.stepOrder}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">
                    {step.label ?? step.requiredRole}
                  </div>
                  {step.comment ? (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {step.comment}
                    </p>
                  ) : null}
                  {step.decidedAt ? (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {formatDateTime(step.decidedAt)}
                    </p>
                  ) : null}
                </div>
                <Badge
                  variant={
                    step.status === 'APPROVED'
                      ? 'success'
                      : step.status === 'REJECTED'
                        ? 'destructive'
                        : step.status === 'PENDING'
                          ? 'warning'
                          : 'outline'
                  }
                >
                  {step.status}
                </Badge>
              </li>
            ))}
          </ol>
        )}
      </Panel>

      {doc.promptVariables && Object.keys(doc.promptVariables).length > 0 ? (
        <Panel
          title="Inputs"
          description="Retained so this generation can be reproduced exactly"
        >
          <dl className="divide-y divide-border">
            {Object.entries(doc.promptVariables).map(([key, value]) => (
              <div key={key} className="flex gap-4 px-5 py-2 text-sm">
                <dt className="w-1/3 shrink-0 text-muted-foreground">{key}</dt>
                <dd className="min-w-0 flex-1 break-words">{String(value)}</dd>
              </div>
            ))}
          </dl>
        </Panel>
      ) : null}
    </div>
  );
}

function ExportLink({ id, format }: { id: string; format: 'pdf' | 'docx' }) {
  return (
    <a
      href={`${apiBaseUrl}/documents/${id}/export/${format}`}
      className="inline-flex h-9 items-center rounded-md border border-input px-4 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground"
    >
      Download {format.toUpperCase()}
    </a>
  );
}
