/**
 * The ordered list of roles that must sign off a document.
 *
 * Stored on `TemplateVersion.approvalChain` and therefore versioned with the
 * template body. That pairing is the point: tightening the chain must not
 * retroactively invalidate a document already halfway through the old one, and
 * loosening it must not let an in-flight document skip a step it was submitted
 * under.
 */
import { CompanyMemberRole, TemplateCategoryKind } from '@legaltech/database';

export interface ApprovalStepDefinition {
  /** 1-based position; steps are decided in ascending order. */
  order: number;
  /** Tenant role permitted to decide this step. */
  role: CompanyMemberRole;
  /** Shown in the approval queue, e.g. "Legal review". */
  label?: string;
}

export type ApprovalChain = ApprovalStepDefinition[];

export interface ApprovalChainIssue {
  path: string;
  message: string;
}

export class ApprovalChainError extends Error {
  constructor(readonly issues: ApprovalChainIssue[]) {
    super(`Invalid approval chain: ${issues.map((i) => i.message).join('; ')}`);
    this.name = 'ApprovalChainError';
  }
}

/** More than a handful of sequential approvers stops being a workflow. */
const MAX_STEPS = 10;

/**
 * Sensible starting chains, by taxonomy branch.
 *
 * VIEWER and PARALEGAL never appear as approvers: a paralegal prepares
 * paperwork, and approving one's own preparation is exactly the separation a
 * chain exists to enforce.
 */
export const DEFAULT_APPROVAL_CHAIN_BY_KIND: Record<
  TemplateCategoryKind,
  ApprovalChain
> = {
  // A contract binds the company externally — legal review, then a signatory.
  [TemplateCategoryKind.CONTRACT]: [
    { order: 1, role: CompanyMemberRole.ATTORNEY, label: 'Legal review' },
    { order: 2, role: CompanyMemberRole.OWNER, label: 'Authorised signatory' },
  ],
  // Internal effect only; HR administration signs it off.
  [TemplateCategoryKind.HR_ORDER]: [
    { order: 1, role: CompanyMemberRole.ADMIN, label: 'HR review' },
    { order: 2, role: CompanyMemberRole.OWNER, label: 'Director approval' },
  ],
  // Constitutive instruments carry registry consequences — all three.
  [TemplateCategoryKind.CORPORATE_ACT]: [
    { order: 1, role: CompanyMemberRole.ATTORNEY, label: 'Legal review' },
    { order: 2, role: CompanyMemberRole.ADMIN, label: 'Corporate secretary' },
    { order: 3, role: CompanyMemberRole.OWNER, label: 'Director approval' },
  ],
};

/** Roles that may never be assigned as an approver. */
const INELIGIBLE_APPROVER_ROLES: CompanyMemberRole[] = [
  CompanyMemberRole.VIEWER,
];

const APPROVER_ROLES = Object.values(CompanyMemberRole).filter(
  (role) => !INELIGIBLE_APPROVER_ROLES.includes(role),
);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates and normalises an author-supplied chain.
 *
 * Order is renumbered densely from 1 on the way out, so a chain authored as
 * `[10, 20, 30]` is stored as `[1, 2, 3]` and step ordering never depends on
 * gaps the author happened to leave.
 */
export function parseApprovalChain(raw: unknown): ApprovalChain {
  const issues: ApprovalChainIssue[] = [];

  if (!Array.isArray(raw)) {
    throw new ApprovalChainError([
      { path: '', message: 'approval chain must be an array' },
    ]);
  }

  if (raw.length === 0) {
    throw new ApprovalChainError([
      {
        path: '',
        message:
          'approval chain must declare at least one step; a document nobody approves cannot reach COMPLETED',
      },
    ]);
  }

  if (raw.length > MAX_STEPS) {
    issues.push({
      path: '',
      message: `approval chain must hold at most ${MAX_STEPS} steps`,
    });
  }

  const seenRoles = new Set<CompanyMemberRole>();

  const steps: (ApprovalStepDefinition | null)[] = raw.map((entry, index) => {
    const at = `[${index}]`;

    if (!isPlainObject(entry)) {
      issues.push({ path: at, message: `${at} must be an object` });
      return null;
    }

    const role = entry.role;
    if (
      typeof role !== 'string' ||
      !APPROVER_ROLES.includes(role as CompanyMemberRole)
    ) {
      issues.push({
        path: `${at}.role`,
        message: `${at}.role must be one of ${APPROVER_ROLES.join(', ')}`,
      });
      return null;
    }

    const typedRole = role as CompanyMemberRole;

    // The same role twice means the second approval adds nothing: whoever
    // satisfied the first step satisfies the second.
    if (seenRoles.has(typedRole)) {
      issues.push({
        path: `${at}.role`,
        message: `${at}.role "${role}" already appears earlier in the chain`,
      });
      return null;
    }
    seenRoles.add(typedRole);

    const order =
      typeof entry.order === 'number' && Number.isFinite(entry.order)
        ? entry.order
        : index + 1;

    const label =
      typeof entry.label === 'string' && entry.label.trim()
        ? entry.label.trim().slice(0, 120)
        : undefined;

    return { order, role: typedRole, label };
  });

  if (issues.length > 0) {
    throw new ApprovalChainError(issues);
  }

  return steps
    .filter((step): step is ApprovalStepDefinition => step !== null)
    .sort((a, b) => a.order - b.order)
    .map((step, index) => ({ ...step, order: index + 1 }));
}
