import {
  CompanyMemberRole,
  GeneratedDocumentStatus,
  TemplateCategoryKind,
  UserRole,
} from '@legaltech/database';
import {
  ApprovalChainError,
  DEFAULT_APPROVAL_CHAIN_BY_KIND,
  parseApprovalChain,
} from './approval-chain';
import {
  allowedFrom,
  canTransition,
  isSelfApproval,
  nextStatus,
  satisfiesRequiredRole,
} from './approval-state-machine';

describe('parseApprovalChain', () => {
  it('accepts a chain and renumbers it densely from 1', () => {
    const chain = parseApprovalChain([
      { order: 30, role: 'OWNER' },
      { order: 10, role: 'ATTORNEY' },
      { order: 20, role: 'ADMIN' },
    ]);

    expect(chain.map((step) => [step.order, step.role])).toEqual([
      [1, CompanyMemberRole.ATTORNEY],
      [2, CompanyMemberRole.ADMIN],
      [3, CompanyMemberRole.OWNER],
    ]);
  });

  it('falls back to array position when no order is given', () => {
    const chain = parseApprovalChain([{ role: 'ATTORNEY' }, { role: 'OWNER' }]);
    expect(chain.map((step) => step.order)).toEqual([1, 2]);
  });

  it('keeps step labels', () => {
    const chain = parseApprovalChain([
      { role: 'ATTORNEY', label: '  Legal review  ' },
    ]);
    expect(chain[0].label).toBe('Legal review');
  });

  it('rejects an empty chain, which could never reach COMPLETED', () => {
    expect(() => parseApprovalChain([])).toThrow(ApprovalChainError);
    expect(() => parseApprovalChain([])).toThrow(/at least one step/);
  });

  it('rejects a chain that is not an array', () => {
    expect(() => parseApprovalChain({ role: 'OWNER' })).toThrow(
      ApprovalChainError,
    );
  });

  it('rejects VIEWER as an approver', () => {
    expect(() => parseApprovalChain([{ role: 'VIEWER' }])).toThrow(
      /role must be one of/,
    );
  });

  it('rejects an unknown role', () => {
    expect(() => parseApprovalChain([{ role: 'NOTARY' }])).toThrow(
      /role must be one of/,
    );
  });

  it('rejects the same role twice, which adds no independent review', () => {
    expect(() =>
      parseApprovalChain([{ role: 'OWNER' }, { role: 'OWNER' }]),
    ).toThrow(/already appears earlier/);
  });

  it('rejects a chain longer than the workflow supports', () => {
    const tooLong = Array.from({ length: 11 }, () => ({ role: 'ATTORNEY' }));
    expect(() => parseApprovalChain(tooLong)).toThrow(/at most 10 steps/);
  });

  describe('shipped defaults', () => {
    it('defines a chain for every taxonomy branch', () => {
      for (const kind of Object.values(TemplateCategoryKind)) {
        expect(() =>
          parseApprovalChain(DEFAULT_APPROVAL_CHAIN_BY_KIND[kind]),
        ).not.toThrow();
      }
    });

    it('never routes approval to a paralegal or a viewer', () => {
      const roles = Object.values(DEFAULT_APPROVAL_CHAIN_BY_KIND)
        .flat()
        .map((step) => step.role);
      expect(roles).not.toContain(CompanyMemberRole.PARALEGAL);
      expect(roles).not.toContain(CompanyMemberRole.VIEWER);
    });

    it('requires the most sign-off for corporate acts', () => {
      expect(
        DEFAULT_APPROVAL_CHAIN_BY_KIND[TemplateCategoryKind.CORPORATE_ACT],
      ).toHaveLength(3);
    });
  });
});

describe('approval state machine', () => {
  const {
    DRAFT,
    GENERATED,
    PENDING_APPROVAL,
    REJECTED,
    COMPLETED,
    FINALIZED,
  } = GeneratedDocumentStatus;

  describe('transitions', () => {
    it('allows a draft to be submitted', () => {
      expect(canTransition(DRAFT, 'submit')).toBe(true);
      expect(nextStatus('submit')).toBe(PENDING_APPROVAL);
    });

    it('treats a freshly generated document as submittable', () => {
      expect(canTransition(GENERATED, 'submit')).toBe(true);
    });

    it('allows a rejected document to be resubmitted', () => {
      expect(canTransition(REJECTED, 'submit')).toBe(true);
    });

    it('refuses to submit a document already in review', () => {
      expect(canTransition(PENDING_APPROVAL, 'submit')).toBe(false);
    });

    it('decides only on a document in review', () => {
      expect(canTransition(PENDING_APPROVAL, 'approve')).toBe(true);
      expect(canTransition(PENDING_APPROVAL, 'reject')).toBe(true);
      expect(canTransition(DRAFT, 'approve')).toBe(false);
      expect(canTransition(COMPLETED, 'approve')).toBe(false);
    });

    it('makes COMPLETED terminal', () => {
      for (const action of ['submit', 'approve', 'reject', 'withdraw', 'revise'] as const) {
        expect(canTransition(COMPLETED, action)).toBe(false);
      }
    });

    it('does not pull a FINALIZED document back into the workflow', () => {
      expect(canTransition(FINALIZED, 'submit')).toBe(false);
    });

    it('returns a document to draft on withdrawal', () => {
      expect(canTransition(PENDING_APPROVAL, 'withdraw')).toBe(true);
      expect(nextStatus('withdraw')).toBe(DRAFT);
    });

    it('reopens a rejected document for revision', () => {
      expect(canTransition(REJECTED, 'revise')).toBe(true);
      expect(nextStatus('revise')).toBe(DRAFT);
    });

    it('explains which statuses an action is legal from', () => {
      expect(allowedFrom('approve')).toEqual([PENDING_APPROVAL]);
    });
  });

  describe('who may decide a step', () => {
    const attorney = {
      id: 'u1',
      role: UserRole.USER,
      companyRole: CompanyMemberRole.ATTORNEY,
    };
    const owner = {
      id: 'u2',
      role: UserRole.USER,
      companyRole: CompanyMemberRole.OWNER,
    };

    it('accepts the exact role the step requires', () => {
      expect(satisfiesRequiredRole(attorney, CompanyMemberRole.ATTORNEY)).toBe(
        true,
      );
    });

    it('rejects a role the step does not name', () => {
      expect(satisfiesRequiredRole(attorney, CompanyMemberRole.ADMIN)).toBe(
        false,
      );
    });

    it('lets an owner satisfy any step, so a departure cannot deadlock a document', () => {
      expect(satisfiesRequiredRole(owner, CompanyMemberRole.ATTORNEY)).toBe(true);
      expect(satisfiesRequiredRole(owner, CompanyMemberRole.ADMIN)).toBe(true);
    });

    it('rejects a user with no membership in the tenant', () => {
      expect(
        satisfiesRequiredRole(
          { id: 'u3', role: UserRole.USER },
          CompanyMemberRole.ATTORNEY,
        ),
      ).toBe(false);
    });

    it('does not let a platform SUPER_ADMIN sign a tenant approval', () => {
      expect(
        satisfiesRequiredRole(
          { id: 'ops', role: UserRole.SUPER_ADMIN },
          CompanyMemberRole.OWNER,
        ),
      ).toBe(false);
    });
  });

  describe('separation of duties', () => {
    const user = {
      id: 'u1',
      role: UserRole.USER,
      companyRole: CompanyMemberRole.OWNER,
    };

    it('blocks approving a document you authored', () => {
      expect(isSelfApproval(user, { createdById: 'u1' })).toBe(true);
    });

    it('blocks approving a document you submitted', () => {
      expect(
        isSelfApproval(user, { createdById: 'other', submittedById: 'u1' }),
      ).toBe(true);
    });

    it('allows approving someone else’s document', () => {
      expect(
        isSelfApproval(user, { createdById: 'other', submittedById: 'other' }),
      ).toBe(false);
    });
  });
});
