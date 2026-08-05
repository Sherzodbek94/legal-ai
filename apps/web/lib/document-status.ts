/**
 * How each document status is rendered.
 *
 * Kept in one place because the list and the detail view must agree — a
 * document showing as amber on one screen and grey on the next reads as two
 * different documents.
 */
export type BadgeTone =
  | 'default'
  | 'secondary'
  | 'success'
  | 'warning'
  | 'destructive'
  | 'outline';

export const DOCUMENT_STATUS_TONE: Record<string, BadgeTone> = {
  DRAFT: 'secondary',
  GENERATING: 'secondary',
  GENERATED: 'secondary',
  PENDING_APPROVAL: 'warning',
  // Terminal and approved — the only status that means the document is settled.
  COMPLETED: 'success',
  FINALIZED: 'success',
  REJECTED: 'destructive',
  FAILED: 'destructive',
};

/** Statuses the approval chain accepts a submission from. */
export const SUBMITTABLE = new Set(['DRAFT', 'GENERATED', 'REJECTED']);

/**
 * Statuses a document body can still be changed in.
 *
 * Mirrors `DocumentEditService.LOCKED` on the API, which is the authority — this
 * copy exists so the page does not offer an Edit button the API will refuse.
 * The alternative is a user typing a clause and learning on save that editing
 * was never allowed.
 *
 * REJECTED is included deliberately: a rejected document is exactly the one
 * somebody needs to correct before resubmitting.
 */
export const EDITABLE = new Set(['DRAFT', 'GENERATED', 'REJECTED']);
