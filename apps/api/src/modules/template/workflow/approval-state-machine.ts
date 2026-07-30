/**
 * The document approval state machine.
 *
 * DRAFT --submit--> PENDING_APPROVAL --approve(last step)--> COMPLETED
 *                          |
 *                          +--reject--> REJECTED --revise--> DRAFT
 *                          |
 *                          +--withdraw--> DRAFT
 *
 * Kept as pure functions over the enum rather than embedded in the service so
 * the legal rules — what may follow what, and who may say so — can be tested
 * without a database, and so every caller resolves them the same way.
 */
import {
  CompanyMemberRole,
  GeneratedDocumentStatus,
  UserRole,
} from '@legaltech/database';

export type WorkflowAction =
  | 'submit'
  | 'approve'
  | 'reject'
  | 'withdraw'
  | 'revise';

/**
 * Statuses a document can hold while inside the approval workflow. The
 * generation-pipeline statuses (GENERATING, GENERATED, FAILED, FINALIZED) are
 * not part of it; a document enters the workflow at DRAFT.
 */
export const WORKFLOW_STATUSES = [
  GeneratedDocumentStatus.DRAFT,
  GeneratedDocumentStatus.PENDING_APPROVAL,
  GeneratedDocumentStatus.REJECTED,
  GeneratedDocumentStatus.COMPLETED,
] as const;

/**
 * Permitted transitions.
 *
 * COMPLETED has no outgoing edge: an approved document is a record of what the
 * approvers agreed to. Correcting it means generating a new document, not
 * reopening this one — reopening would leave signatures attached to text that
 * has since changed.
 */
const TRANSITIONS: Record<
  WorkflowAction,
  { from: GeneratedDocumentStatus[]; to: GeneratedDocumentStatus }
> = {
  submit: {
    // GENERATED is included because a freshly generated document has not been
    // touched by a human yet and is functionally a draft.
    from: [
      GeneratedDocumentStatus.DRAFT,
      GeneratedDocumentStatus.GENERATED,
      GeneratedDocumentStatus.REJECTED,
    ],
    to: GeneratedDocumentStatus.PENDING_APPROVAL,
  },
  approve: {
    from: [GeneratedDocumentStatus.PENDING_APPROVAL],
    to: GeneratedDocumentStatus.COMPLETED,
  },
  reject: {
    from: [GeneratedDocumentStatus.PENDING_APPROVAL],
    to: GeneratedDocumentStatus.REJECTED,
  },
  withdraw: {
    from: [GeneratedDocumentStatus.PENDING_APPROVAL],
    to: GeneratedDocumentStatus.DRAFT,
  },
  revise: {
    from: [GeneratedDocumentStatus.REJECTED],
    to: GeneratedDocumentStatus.DRAFT,
  },
};

export function canTransition(
  from: GeneratedDocumentStatus,
  action: WorkflowAction,
): boolean {
  return TRANSITIONS[action].from.includes(from);
}

export function nextStatus(action: WorkflowAction): GeneratedDocumentStatus {
  return TRANSITIONS[action].to;
}

/** Statuses from which `action` is legal — used to explain a rejection. */
export function allowedFrom(action: WorkflowAction): GeneratedDocumentStatus[] {
  return [...TRANSITIONS[action].from];
}

export interface Approver {
  id: string;
  role: UserRole;
  companyRole?: CompanyMemberRole;
}

/**
 * Whether `user` may decide a step requiring `requiredRole`.
 *
 * OWNER satisfies every step: within a tenant the owner already holds the
 * authority each lesser role exercises, so blocking them would only produce
 * deadlocked documents when an attorney leaves the firm.
 *
 * SUPER_ADMIN deliberately does **not** satisfy steps. It is a platform
 * operations role, and an approval is a legal act by someone inside the
 * company; letting operations staff sign a client's board resolution is not a
 * convenience, it is a liability.
 */
export function satisfiesRequiredRole(
  user: Approver,
  requiredRole: CompanyMemberRole,
): boolean {
  if (!user.companyRole) return false;
  if (user.companyRole === requiredRole) return true;
  return user.companyRole === CompanyMemberRole.OWNER;
}

/**
 * Separation of duties: the person who submitted a document cannot approve it.
 *
 * Kept separate from the role check because it is a different question —
 * "are you senior enough" versus "are you independent of this" — and because
 * an owner submitting their own document still needs a second pair of eyes.
 */
export function isSelfApproval(
  user: Approver,
  document: { createdById: string; submittedById?: string | null },
): boolean {
  return (
    user.id === document.submittedById || user.id === document.createdById
  );
}
