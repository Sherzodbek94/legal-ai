'use server';

import { revalidatePath } from 'next/cache';
import { apiPost } from '@/lib/api';

export interface ApprovalActionState {
  message?: string;
  ok?: boolean;
}

/** Submits a document into its template version's approval chain. */
export async function submitForApproval(
  documentId: string,
  _previous: ApprovalActionState,
  formData: FormData,
): Promise<ApprovalActionState> {
  const note = String(formData.get('note') ?? '').trim();

  const result = await apiPost(`/documents/${documentId}/submit`, {
    ...(note ? { note } : {}),
  });

  if (!result.ok) return { message: result.message };

  // Both paths: the detail view shows the new status and the list shows the
  // new badge, and a stale list is how someone submits the same document twice.
  revalidatePath(`/documents/${documentId}`);
  revalidatePath('/documents');
  return { ok: true, message: 'Submitted for approval.' };
}

/** Records the caller's decision on the current approval step. */
export async function decideApproval(
  documentId: string,
  _previous: ApprovalActionState,
  formData: FormData,
): Promise<ApprovalActionState> {
  const decision = formData.get('decision');
  if (decision !== 'APPROVE' && decision !== 'REJECT') {
    return { message: 'Choose approve or reject.' };
  }

  const comment = String(formData.get('comment') ?? '').trim();

  // Not enforced client-side beyond this: a rejection with no reason is a
  // process problem, and blocking on it only moves the conversation offline.
  const result = await apiPost(`/documents/${documentId}/approvals/decide`, {
    decision,
    ...(comment ? { comment } : {}),
  });

  if (!result.ok) return { message: result.message };

  revalidatePath(`/documents/${documentId}`);
  revalidatePath('/documents');
  return {
    ok: true,
    message: decision === 'APPROVE' ? 'Approved.' : 'Rejected.',
  };
}
