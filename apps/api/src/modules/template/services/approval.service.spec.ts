/**
 * The approval chain, as the service actually runs it.
 *
 * `approval-workflow.spec.ts` covers the rules in isolation — which transitions
 * are legal, who may decide a step, what counts as self-approval. This covers
 * the service that applies them, which is where the rules meet rounds, step
 * ordering, and the writes that have to happen together.
 *
 * The failures worth guarding are the ones that leave the document in a state
 * nobody can act on: a rejection that leaves later steps open so the document
 * is both rejected and awaiting a decision, a resubmission that adds a round
 * without closing the old one, an approval that completes the document while a
 * step is still pending. None of those raises an error at the time.
 *
 * Prisma is faked rather than mocked. Step transitions are expressed in
 * `updateMany` filters and `findMany` ordering, so asserting on call arguments
 * would prove the service calls Prisma, not that a document ends up in a
 * coherent state.
 */
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  ApprovalStepStatus,
  CompanyMemberRole,
  GeneratedDocumentStatus,
} from '@legaltech/database';
import { ApprovalService } from './approval.service';
import type { PrismaService } from '../../../prisma/prisma.service';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';

// ---------------------------------------------------------------------------
// A Prisma good enough to hold the properties under test
// ---------------------------------------------------------------------------

type Row = Record<string, any>;

/** Matches Prisma's `where` for the shapes this service actually uses. */
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (value === null) return row[key] === null || row[key] === undefined;
    if (typeof value === 'object' && value !== null && 'in' in value) {
      return (value.in as unknown[]).includes(row[key]);
    }
    return row[key] === value;
  });
}

class FakePrisma {
  documents: Row[] = [];
  approvals: Row[] = [];
  audits: Row[] = [];

  private nextId = 1;

  readonly client = {
    generatedDocument: {
      findFirst: async ({ where, include }: Row = {}) => {
        const row = this.documents.find((doc) => matches(doc, where)) ?? null;
        if (!row) return null;
        // `include` is only ever the pinned template version.
        return include?.templateVersion ? { ...row } : { ...row };
      },
      findFirstOrThrow: async ({ where }: Row = {}) => {
        const row = this.documents.find((doc) => matches(doc, where));
        if (!row) throw new Error('document not found');
        return { ...row };
      },
      update: async ({ where, data }: Row) => {
        const row = this.documents.find((doc) => doc.id === where.id);
        if (!row) throw new Error('document not found');
        Object.assign(row, data);
        return { ...row };
      },
    },
    documentApproval: {
      findMany: async ({ where, orderBy }: Row = {}) => {
        let rows = this.approvals.filter((step) => matches(step, where));
        for (const clause of [orderBy ?? []].flat().reverse()) {
          const [field, direction] = Object.entries(clause as Row)[0] as [
            string,
            string,
          ];
          rows = [...rows].sort((a, b) =>
            direction === 'desc' ? b[field] - a[field] : a[field] - b[field],
          );
        }
        return rows.map((step) => ({ ...step }));
      },
      createMany: async ({ data }: Row) => {
        for (const step of data as Row[]) {
          this.approvals.push({
            id: `step_${this.nextId++}`,
            status: ApprovalStepStatus.PENDING,
            decidedById: null,
            decidedAt: null,
            comment: null,
            ...step,
          });
        }
        return { count: (data as Row[]).length };
      },
      update: async ({ where, data }: Row) => {
        const row = this.approvals.find((step) => step.id === where.id);
        if (!row) throw new Error('step not found');
        Object.assign(row, data);
        return { ...row };
      },
      updateMany: async ({ where, data }: Row) => {
        const rows = this.approvals.filter((step) => matches(step, where));
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      },
    },
    auditLog: {
      create: async ({ data }: Row) => {
        this.audits.push({ ...data });
        return { ...data };
      },
    },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
      fn(this.client),
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CHAIN = [
  { order: 1, role: CompanyMemberRole.ATTORNEY, label: 'Legal review' },
  { order: 2, role: CompanyMemberRole.OWNER, label: 'Authorised signatory' },
];

const SCHEMA = {
  version: 1,
  variables: [{ key: 'party', label: 'Party', type: 'string', required: true }],
};

function user(
  overrides: Partial<AuthenticatedUser> = {},
): AuthenticatedUser {
  return {
    id: 'user_approver',
    companyId: 'co_1',
    companyRole: CompanyMemberRole.ATTORNEY,
    ...overrides,
  } as AuthenticatedUser;
}

function build(document: Row = {}) {
  const db = new FakePrisma();

  db.documents.push({
    id: 'doc_1',
    companyId: 'co_1',
    deletedAt: null,
    status: GeneratedDocumentStatus.GENERATED,
    approvalRound: 0,
    createdById: 'user_author',
    submittedById: null,
    content: { type: 'doc' },
    promptVariables: { party: 'Acme MChJ' },
    rejectionReason: null,
    templateVersion: {
      id: 'tv_1',
      variableSchema: SCHEMA,
      approvalChain: CHAIN,
    },
    ...document,
  });

  const service = new ApprovalService(db as unknown as PrismaService);
  return { service, db };
}

/** Submits, then returns the steps of the current round in order. */
function stepsOf(db: FakePrisma, round: number) {
  return db.approvals
    .filter((step) => step.round === round)
    .sort((a, b) => a.stepOrder - b.stepOrder);
}

const SUBMITTER = user({ id: 'user_submitter', companyRole: CompanyMemberRole.PARALEGAL });

describe('ApprovalService', () => {
  // -------------------------------------------------------------------------
  // submitForApproval
  // -------------------------------------------------------------------------

  describe('submitForApproval', () => {
    it('opens a step per chain entry and moves the document into review', async () => {
      const { service, db } = build();

      const result = await service.submitForApproval('doc_1', {}, SUBMITTER);

      expect(result.status).toBe(GeneratedDocumentStatus.PENDING_APPROVAL);
      expect(result.approvalRound).toBe(1);
      expect(stepsOf(db, 1)).toHaveLength(2);
      expect(stepsOf(db, 1).map((step) => step.requiredRole)).toEqual([
        CompanyMemberRole.ATTORNEY,
        CompanyMemberRole.OWNER,
      ]);
    });

    it('records who submitted it, which is what withdrawal and self-approval read', async () => {
      const { service, db } = build();

      await service.submitForApproval('doc_1', {}, SUBMITTER);

      expect(db.documents[0].submittedById).toBe('user_submitter');
      expect(db.documents[0].submittedAt).toBeInstanceOf(Date);
    });

    it('clears a previous rejection reason', async () => {
      // Left in place it would show against a document that is under review
      // again, reading as a fresh rejection.
      const { service, db } = build({
        status: GeneratedDocumentStatus.DRAFT,
        rejectionReason: 'Missing indemnity clause',
      });

      await service.submitForApproval('doc_1', {}, SUBMITTER);

      expect(db.documents[0].rejectionReason).toBeNull();
    });

    it('writes an audit entry naming the round and step count', async () => {
      const { service, db } = build();

      await service.submitForApproval('doc_1', { note: 'urgent' }, SUBMITTER);

      expect(db.audits).toHaveLength(1);
      expect(db.audits[0].metadata).toMatchObject({
        transition: 'PENDING_APPROVAL',
        round: 1,
        steps: 2,
        note: 'urgent',
      });
    });

    it.each([
      GeneratedDocumentStatus.PENDING_APPROVAL,
      GeneratedDocumentStatus.COMPLETED,
      GeneratedDocumentStatus.GENERATING,
    ])('refuses to submit from %s', async (status) => {
      const { service, db } = build({ status });

      await expect(
        service.submitForApproval('doc_1', {}, SUBMITTER),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(db.approvals).toHaveLength(0);
    });

    it('refuses a document with no pinned template version', async () => {
      // Without one there is no chain to build and no contract to re-check.
      const { service } = build({ templateVersion: null });

      await expect(
        service.submitForApproval('doc_1', {}, SUBMITTER),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('refuses a document with no content', async () => {
      const { service } = build({ content: null });

      await expect(
        service.submitForApproval('doc_1', {}, SUBMITTER),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('re-checks the variables at submission, not just at generation', async () => {
      // The document may have been edited since it was generated, and the
      // approvers are about to sign off on whatever is in it now.
      const { service, db } = build({ promptVariables: {} });

      await expect(
        service.submitForApproval('doc_1', {}, SUBMITTER),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(db.approvals).toHaveLength(0);
    });

    it('refuses a document belonging to another company', async () => {
      const { service } = build({ companyId: 'co_2' });

      await expect(
        service.submitForApproval('doc_1', {}, SUBMITTER),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses a soft-deleted document', async () => {
      const { service } = build({ deletedAt: new Date() });

      await expect(
        service.submitForApproval('doc_1', {}, SUBMITTER),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    describe('resubmission after a rejection', () => {
      it('opens a fresh round rather than reusing the old steps', async () => {
        const { service, db } = build();

        await service.submitForApproval('doc_1', {}, SUBMITTER);
        await service.decide('doc_1', { decision: 'REJECT', comment: 'no' }, user());
        await service.reviseAfterRejection('doc_1', SUBMITTER);
        await service.submitForApproval('doc_1', {}, SUBMITTER);

        expect(db.documents[0].approvalRound).toBe(2);
        expect(stepsOf(db, 1)).toHaveLength(2);
        expect(stepsOf(db, 2)).toHaveLength(2);
      });

      it('leaves no step of an earlier round pending', async () => {
        // An orphaned open step from round 1 would show up in the queue of
        // whoever it was assigned to, for a round that is over.
        const { service, db } = build();

        await service.submitForApproval('doc_1', {}, SUBMITTER);
        await service.decide('doc_1', { decision: 'REJECT' }, user());
        await service.reviseAfterRejection('doc_1', SUBMITTER);
        await service.submitForApproval('doc_1', {}, SUBMITTER);

        expect(
          stepsOf(db, 1).some((step) => step.status === ApprovalStepStatus.PENDING),
        ).toBe(false);
      });
    });
  });

  // -------------------------------------------------------------------------
  // decide
  // -------------------------------------------------------------------------

  describe('decide', () => {
    /** A document already in review, at step 1 of 2. */
    async function inReview(document: Row = {}) {
      const context = build(document);
      await context.service.submitForApproval('doc_1', {}, SUBMITTER);
      return context;
    }

    describe('approving', () => {
      it('advances to the next step without completing the document', async () => {
        // The document is not settled until every step has approved; completing
        // early would let a contract out without the signatory.
        const { service, db } = await inReview();

        const result = await service.decide('doc_1', { decision: 'APPROVE' }, user());

        expect(result.status).toBe(GeneratedDocumentStatus.PENDING_APPROVAL);
        expect(stepsOf(db, 1)[0].status).toBe(ApprovalStepStatus.APPROVED);
        expect(stepsOf(db, 1)[1].status).toBe(ApprovalStepStatus.PENDING);
      });

      it('records who decided, when, and why', async () => {
        const { service, db } = await inReview();

        await service.decide(
          'doc_1',
          { decision: 'APPROVE', comment: 'Looks right' },
          user({ id: 'user_lawyer' }),
        );

        expect(stepsOf(db, 1)[0]).toMatchObject({
          decidedById: 'user_lawyer',
          comment: 'Looks right',
        });
        expect(stepsOf(db, 1)[0].decidedAt).toBeInstanceOf(Date);
      });

      it('completes the document when the last step approves', async () => {
        const { service, db } = await inReview();

        await service.decide('doc_1', { decision: 'APPROVE' }, user());
        const result = await service.decide(
          'doc_1',
          { decision: 'APPROVE' },
          user({ id: 'user_owner', companyRole: CompanyMemberRole.OWNER }),
        );

        expect(result.status).toBe(GeneratedDocumentStatus.COMPLETED);
        expect(db.documents[0].completedAt).toBeInstanceOf(Date);
      });

      it('writes an audit entry only on the transition, not on every step', async () => {
        // One entry for the submission, one for completion. A mid-chain
        // approval changes no document state and should not claim to.
        const { service, db } = await inReview();

        await service.decide('doc_1', { decision: 'APPROVE' }, user());
        expect(db.audits).toHaveLength(1);

        await service.decide(
          'doc_1',
          { decision: 'APPROVE' },
          user({ id: 'user_owner', companyRole: CompanyMemberRole.OWNER }),
        );
        expect(db.audits).toHaveLength(2);
        expect(db.audits[1].metadata).toMatchObject({ transition: 'COMPLETED' });
      });
    });

    describe('rejecting', () => {
      it('ends the round immediately', async () => {
        // There is no point asking the director to sign something legal has
        // already turned down.
        const { service, db } = await inReview();

        const result = await service.decide(
          'doc_1',
          { decision: 'REJECT', comment: 'Indemnity missing' },
          user(),
        );

        expect(result.status).toBe(GeneratedDocumentStatus.REJECTED);
        expect(stepsOf(db, 1)[0].status).toBe(ApprovalStepStatus.REJECTED);
      });

      it('leaves no later step pending', async () => {
        // Both rejected and awaiting a decision is a state nobody can act on:
        // the owner still sees it in their queue.
        const { service, db } = await inReview();

        await service.decide('doc_1', { decision: 'REJECT' }, user());

        expect(stepsOf(db, 1)[1].status).toBe(ApprovalStepStatus.SKIPPED);
      });

      it('surfaces the comment as the rejection reason', async () => {
        const { service, db } = await inReview();

        await service.decide(
          'doc_1',
          { decision: 'REJECT', comment: 'Indemnity missing' },
          user(),
        );

        expect(db.documents[0].rejectionReason).toBe('Indemnity missing');
      });

      it('records a rejection with no comment as no reason, not as undefined', async () => {
        const { service, db } = await inReview();

        await service.decide('doc_1', { decision: 'REJECT' }, user());

        expect(db.documents[0].rejectionReason).toBeNull();
      });
    });

    describe('who may decide', () => {
      it('refuses a role the step does not call for', async () => {
        const { service } = await inReview();

        await expect(
          service.decide(
            'doc_1',
            { decision: 'APPROVE' },
            user({ companyRole: CompanyMemberRole.VIEWER }),
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });

      it('does not disclose which role the step wanted', async () => {
        // Naming it hands the approval structure to someone with no part in it.
        const { service } = await inReview();

        await expect(
          service.decide(
            'doc_1',
            { decision: 'APPROVE' },
            user({ companyRole: CompanyMemberRole.VIEWER }),
          ),
        ).rejects.toThrow(/^You are not authorised to decide this approval step$/);
      });

      it('refuses the author, even when their role fits', async () => {
        const { service } = await inReview();

        await expect(
          service.decide(
            'doc_1',
            { decision: 'APPROVE' },
            user({ id: 'user_author' }),
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });

      it('refuses the submitter, even when their role fits', async () => {
        const { service } = await inReview();

        await expect(
          service.decide(
            'doc_1',
            { decision: 'APPROVE' },
            user({ id: 'user_submitter' }),
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });

      it('leaves the step untouched when a decision is refused', async () => {
        const { service, db } = await inReview();

        await service
          .decide('doc_1', { decision: 'APPROVE' }, user({ id: 'user_author' }))
          .catch(() => undefined);

        expect(stepsOf(db, 1)[0].status).toBe(ApprovalStepStatus.PENDING);
      });
    });

    describe('refusals', () => {
      it('refuses a document that is not in review', async () => {
        const { service } = build({ status: GeneratedDocumentStatus.DRAFT });

        await expect(
          service.decide('doc_1', { decision: 'APPROVE' }, user()),
        ).rejects.toBeInstanceOf(ConflictException);
      });

      it('refuses when no step is awaiting a decision', async () => {
        const { service, db } = await inReview();
        for (const step of db.approvals) step.status = ApprovalStepStatus.APPROVED;

        await expect(
          service.decide('doc_1', { decision: 'APPROVE' }, user()),
        ).rejects.toBeInstanceOf(ConflictException);
      });

      it('refuses a document from another company', async () => {
        const { service } = await inReview();

        await expect(
          service.decide(
            'doc_1',
            { decision: 'APPROVE' },
            user({ companyId: 'co_2' }),
          ),
        ).rejects.toBeInstanceOf(NotFoundException);
      });
    });
  });

  // -------------------------------------------------------------------------
  // withdraw
  // -------------------------------------------------------------------------

  describe('withdraw', () => {
    async function inReview() {
      const context = build();
      await context.service.submitForApproval('doc_1', {}, SUBMITTER);
      return context;
    }

    it('returns the document to draft and closes the open steps', async () => {
      const { service, db } = await inReview();

      const result = await service.withdraw('doc_1', SUBMITTER);

      expect(result.status).toBe(GeneratedDocumentStatus.DRAFT);
      expect(
        stepsOf(db, 1).every((step) => step.status !== ApprovalStepStatus.PENDING),
      ).toBe(true);
    });

    it('refuses anyone but the submitter', async () => {
      // Otherwise an approver who would rather not decide could make the
      // request disappear.
      const { service } = await inReview();

      await expect(service.withdraw('doc_1', user())).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('allows an owner to withdraw on the submitter’s behalf', async () => {
      const { service } = await inReview();

      const result = await service.withdraw(
        'doc_1',
        user({ id: 'user_owner', companyRole: CompanyMemberRole.OWNER }),
      );

      expect(result.status).toBe(GeneratedDocumentStatus.DRAFT);
    });

    it('refuses a document that is not in review', async () => {
      const { service } = build({ status: GeneratedDocumentStatus.COMPLETED });

      await expect(service.withdraw('doc_1', SUBMITTER)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  // -------------------------------------------------------------------------
  // reviseAfterRejection
  // -------------------------------------------------------------------------

  describe('reviseAfterRejection', () => {
    it('reopens a rejected document for correction', async () => {
      const { service } = build({ status: GeneratedDocumentStatus.REJECTED });

      const result = await service.reviseAfterRejection('doc_1', SUBMITTER);

      expect(result.status).toBe(GeneratedDocumentStatus.DRAFT);
    });

    it.each([
      GeneratedDocumentStatus.COMPLETED,
      GeneratedDocumentStatus.PENDING_APPROVAL,
      GeneratedDocumentStatus.DRAFT,
    ])('refuses to revise from %s', async (status) => {
      const { service } = build({ status });

      await expect(
        service.reviseAfterRejection('doc_1', SUBMITTER),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  // -------------------------------------------------------------------------
  // getApprovalState
  // -------------------------------------------------------------------------

  describe('getApprovalState', () => {
    it('reports the current round, and earlier rounds as history', async () => {
      const { service } = build();

      await service.submitForApproval('doc_1', {}, SUBMITTER);
      await service.decide('doc_1', { decision: 'REJECT' }, user());
      await service.reviseAfterRejection('doc_1', SUBMITTER);
      await service.submitForApproval('doc_1', {}, SUBMITTER);

      const state = await service.getApprovalState('doc_1', 'co_1');

      expect(state.round).toBe(2);
      expect(state.steps).toHaveLength(2);
      expect(state.history).toHaveLength(2);
    });

    it('names the step currently awaiting a decision', async () => {
      const { service } = build();
      await service.submitForApproval('doc_1', {}, SUBMITTER);

      const state = await service.getApprovalState('doc_1', 'co_1');

      expect(state.currentStep).toMatchObject({
        stepOrder: 1,
        requiredRole: CompanyMemberRole.ATTORNEY,
      });
    });

    it('reports no current step once the document is settled', async () => {
      const { service } = build();
      await service.submitForApproval('doc_1', {}, SUBMITTER);
      await service.decide('doc_1', { decision: 'APPROVE' }, user());
      await service.decide(
        'doc_1',
        { decision: 'APPROVE' },
        user({ id: 'user_owner', companyRole: CompanyMemberRole.OWNER }),
      );

      const state = await service.getApprovalState('doc_1', 'co_1');

      expect(state.currentStep).toBeUndefined();
      expect(state.status).toBe(GeneratedDocumentStatus.COMPLETED);
    });

    it('refuses a document from another company', async () => {
      const { service } = build();

      await expect(service.getApprovalState('doc_1', 'co_2')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
