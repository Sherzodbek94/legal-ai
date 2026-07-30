import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  ApprovalStepStatus,
  AuditAction,
  GeneratedDocumentStatus,
  Prisma,
} from '@legaltech/database';
import { PrismaService } from '../../../prisma/prisma.service';
import { parseVariableSchema } from '../validation/variable-schema';
import { validateVariableValues } from '../validation/variable-values';
import { parseApprovalChain } from '../workflow/approval-chain';
import {
  allowedFrom,
  canTransition,
  isSelfApproval,
  nextStatus,
  satisfiesRequiredRole,
  type WorkflowAction,
} from '../workflow/approval-state-machine';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import type { DecideApprovalDto, SubmitForApprovalDto } from '../dto/approval.dto';

@Injectable()
export class ApprovalService {
  private readonly logger = new Logger(ApprovalService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /** Current round's steps plus the decision history of earlier rounds. */
  async getApprovalState(documentId: string, companyId: string) {
    const document = await this.loadDocument(documentId, companyId);

    const approvals = await this.prisma.client.documentApproval.findMany({
      where: { documentId },
      orderBy: [{ round: 'desc' }, { stepOrder: 'asc' }],
      select: {
        id: true,
        round: true,
        stepOrder: true,
        requiredRole: true,
        label: true,
        status: true,
        decidedById: true,
        decidedAt: true,
        comment: true,
      },
    });

    const current = approvals.filter(
      (step) => step.round === document.approvalRound,
    );

    return {
      documentId,
      status: document.status,
      round: document.approvalRound,
      currentStep: current.find(
        (step) => step.status === ApprovalStepStatus.PENDING,
      ),
      steps: current,
      history: approvals.filter((step) => step.round !== document.approvalRound),
    };
  }

  /**
   * Documents waiting on the caller.
   *
   * Only the head pending step of each document counts: a later step is not yet
   * this user's problem, and showing it would have three people think a document
   * is theirs to action.
   */
  async listMyQueue(user: AuthenticatedUser) {
    if (!user.companyRole) return [];

    const documents = await this.prisma.client.generatedDocument.findMany({
      where: {
        companyId: user.companyId,
        status: GeneratedDocumentStatus.PENDING_APPROVAL,
        deletedAt: null,
      },
      select: {
        id: true,
        title: true,
        createdById: true,
        submittedById: true,
        submittedAt: true,
        approvalRound: true,
        approvals: {
          where: { status: ApprovalStepStatus.PENDING },
          orderBy: { stepOrder: 'asc' },
          select: {
            id: true,
            round: true,
            stepOrder: true,
            requiredRole: true,
            label: true,
          },
        },
      },
      orderBy: { submittedAt: 'asc' },
    });

    return documents
      .map((document) => {
        const head = document.approvals.find(
          (step) => step.round === document.approvalRound,
        );
        return head ? { ...document, currentStep: head } : null;
      })
      .filter(
        (entry): entry is NonNullable<typeof entry> =>
          entry !== null &&
          satisfiesRequiredRole(user, entry.currentStep.requiredRole) &&
          !isSelfApproval(user, entry),
      )
      .map(({ approvals: _approvals, ...rest }) => rest);
  }

  // ---------------------------------------------------------------------------
  // Transitions
  // ---------------------------------------------------------------------------

  /**
   * DRAFT -> PENDING_APPROVAL.
   *
   * Instantiates the chain from the template version the document was generated
   * from — a snapshot, not a live reference, so editing the template mid-review
   * cannot change what this document still needs.
   */
  async submitForApproval(
    documentId: string,
    dto: SubmitForApprovalDto,
    user: AuthenticatedUser,
  ) {
    const companyId = user.companyId!;

    return this.prisma.client.$transaction(async (tx) => {
      const document = await tx.generatedDocument.findFirst({
        where: { id: documentId, companyId, deletedAt: null },
        include: {
          templateVersion: {
            select: { id: true, variableSchema: true, approvalChain: true },
          },
        },
      });

      if (!document) {
        throw new NotFoundException('Document not found');
      }

      this.assertTransition(document.status, 'submit');

      if (!document.templateVersion) {
        throw new ConflictException(
          'Document is not pinned to a template version and cannot enter approval',
        );
      }
      if (!document.content) {
        throw new ConflictException(
          'Document has no content to approve',
        );
      }

      // The variables are re-checked at submission, not just at generation:
      // between the two the document may have been edited, and the approvers
      // are about to sign off on whatever is in it now.
      const schema = parseVariableSchema(document.templateVersion.variableSchema);
      const validation = validateVariableValues(
        schema,
        (document.promptVariables as Record<string, unknown>) ?? {},
      );
      if (!validation.ok) {
        throw new UnprocessableEntityException({
          message: 'Document variables do not satisfy the template contract',
          issues: validation.issues,
        });
      }

      const chain = parseApprovalChain(document.templateVersion.approvalChain);
      const round = document.approvalRound + 1;
      const now = new Date();

      // Abandon anything still pending from a previous round so the history
      // reads as "superseded" rather than leaving orphaned open steps.
      await tx.documentApproval.updateMany({
        where: { documentId, status: ApprovalStepStatus.PENDING },
        data: { status: ApprovalStepStatus.SKIPPED },
      });

      await tx.documentApproval.createMany({
        data: chain.map((step) => ({
          documentId,
          round,
          stepOrder: step.order,
          requiredRole: step.role,
          label: step.label,
        })),
      });

      const updated = await tx.generatedDocument.update({
        where: { id: documentId },
        data: {
          status: nextStatus('submit'),
          approvalRound: round,
          submittedAt: now,
          submittedById: user.id,
          rejectionReason: null,
        },
      });

      await this.writeAudit(tx, {
        companyId,
        userId: user.id,
        action: AuditAction.UPDATE,
        entityId: documentId,
        metadata: {
          transition: 'PENDING_APPROVAL',
          round,
          steps: chain.length,
          note: dto.note,
        },
      });

      return updated;
    });
  }

  /**
   * Records a decision on the document's current step.
   *
   * Approving the last step completes the document; rejecting any step ends the
   * round immediately — there is no point asking the director to sign something
   * legal has already turned down.
   */
  async decide(
    documentId: string,
    dto: DecideApprovalDto,
    user: AuthenticatedUser,
  ) {
    const companyId = user.companyId!;
    const action: WorkflowAction = dto.decision === 'APPROVE' ? 'approve' : 'reject';

    return this.prisma.client.$transaction(async (tx) => {
      const document = await tx.generatedDocument.findFirst({
        where: { id: documentId, companyId, deletedAt: null },
        select: {
          id: true,
          status: true,
          approvalRound: true,
          createdById: true,
          submittedById: true,
        },
      });

      if (!document) {
        throw new NotFoundException('Document not found');
      }

      this.assertTransition(document.status, action);

      const steps = await tx.documentApproval.findMany({
        where: { documentId, round: document.approvalRound },
        orderBy: { stepOrder: 'asc' },
      });

      const head = steps.find(
        (step) => step.status === ApprovalStepStatus.PENDING,
      );
      if (!head) {
        throw new ConflictException(
          'No approval step is awaiting a decision on this document',
        );
      }

      if (!satisfiesRequiredRole(user, head.requiredRole)) {
        // Does not name the required role: that discloses the approval
        // structure to someone with no part in it.
        throw new ForbiddenException(
          'You are not authorised to decide this approval step',
        );
      }

      if (isSelfApproval(user, document)) {
        throw new ForbiddenException(
          'You cannot approve a document you authored or submitted',
        );
      }

      const now = new Date();

      await tx.documentApproval.update({
        where: { id: head.id },
        data: {
          status:
            action === 'approve'
              ? ApprovalStepStatus.APPROVED
              : ApprovalStepStatus.REJECTED,
          decidedById: user.id,
          decidedAt: now,
          comment: dto.comment,
        },
      });

      if (action === 'reject') {
        await tx.documentApproval.updateMany({
          where: {
            documentId,
            round: document.approvalRound,
            status: ApprovalStepStatus.PENDING,
          },
          data: { status: ApprovalStepStatus.SKIPPED },
        });

        const rejected = await tx.generatedDocument.update({
          where: { id: documentId },
          data: {
            status: nextStatus('reject'),
            rejectionReason: dto.comment ?? null,
          },
        });

        await this.writeAudit(tx, {
          companyId,
          userId: user.id,
          action: AuditAction.UPDATE,
          entityId: documentId,
          metadata: {
            transition: 'REJECTED',
            round: document.approvalRound,
            stepOrder: head.stepOrder,
          },
        });

        return rejected;
      }

      const remaining = steps.filter(
        (step) =>
          step.id !== head.id && step.status === ApprovalStepStatus.PENDING,
      );

      if (remaining.length > 0) {
        // Still mid-chain: the document stays PENDING_APPROVAL and moves to the
        // next approver.
        return tx.generatedDocument.findFirstOrThrow({
          where: { id: documentId },
        });
      }

      const completed = await tx.generatedDocument.update({
        where: { id: documentId },
        data: {
          status: nextStatus('approve'),
          completedAt: now,
        },
      });

      await this.writeAudit(tx, {
        companyId,
        userId: user.id,
        action: AuditAction.UPDATE,
        entityId: documentId,
        metadata: {
          transition: 'COMPLETED',
          round: document.approvalRound,
          approvedSteps: steps.length,
        },
      });

      return completed;
    });
  }

  /** Pulls a document back out of review, e.g. to correct it before a decision. */
  async withdraw(documentId: string, user: AuthenticatedUser) {
    const companyId = user.companyId!;

    return this.prisma.client.$transaction(async (tx) => {
      const document = await tx.generatedDocument.findFirst({
        where: { id: documentId, companyId, deletedAt: null },
        select: {
          id: true,
          status: true,
          approvalRound: true,
          createdById: true,
          submittedById: true,
        },
      });

      if (!document) {
        throw new NotFoundException('Document not found');
      }

      this.assertTransition(document.status, 'withdraw');

      // Only the submitter (or an owner) may withdraw. Otherwise an approver
      // who would rather not decide could simply make the request disappear.
      const isOwner = user.companyRole === 'OWNER';
      if (document.submittedById !== user.id && !isOwner) {
        throw new ForbiddenException(
          'Only the submitter can withdraw this document from approval',
        );
      }

      await tx.documentApproval.updateMany({
        where: {
          documentId,
          round: document.approvalRound,
          status: ApprovalStepStatus.PENDING,
        },
        data: { status: ApprovalStepStatus.SKIPPED },
      });

      const withdrawn = await tx.generatedDocument.update({
        where: { id: documentId },
        data: { status: nextStatus('withdraw') },
      });

      await this.writeAudit(tx, {
        companyId,
        userId: user.id,
        action: AuditAction.UPDATE,
        entityId: documentId,
        metadata: { transition: 'WITHDRAWN', round: document.approvalRound },
      });

      return withdrawn;
    });
  }

  /** REJECTED -> DRAFT, reopening the document for correction. */
  async reviseAfterRejection(documentId: string, user: AuthenticatedUser) {
    const companyId = user.companyId!;
    const document = await this.loadDocument(documentId, companyId);

    this.assertTransition(document.status, 'revise');

    return this.prisma.client.generatedDocument.update({
      where: { id: documentId },
      data: { status: nextStatus('revise') },
    });
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private assertTransition(
    from: GeneratedDocumentStatus,
    action: WorkflowAction,
  ) {
    if (canTransition(from, action)) return;

    throw new ConflictException(
      `Cannot ${action} a document in status ${from}; expected one of ${allowedFrom(
        action,
      ).join(', ')}`,
    );
  }

  private async loadDocument(documentId: string, companyId: string) {
    const document = await this.prisma.client.generatedDocument.findFirst({
      where: { id: documentId, companyId, deletedAt: null },
      select: {
        id: true,
        status: true,
        approvalRound: true,
        createdById: true,
        submittedById: true,
      },
    });

    if (!document) {
      throw new NotFoundException('Document not found');
    }
    return document;
  }

  private writeAudit(
    tx: Prisma.TransactionClient,
    entry: {
      companyId?: string;
      userId?: string;
      action: AuditAction;
      entityId: string;
      metadata?: Prisma.InputJsonValue;
    },
  ) {
    return tx.auditLog.create({
      data: {
        companyId: entry.companyId ?? null,
        userId: entry.userId ?? null,
        action: entry.action,
        entityType: 'GeneratedDocument',
        entityId: entry.entityId,
        metadata: entry.metadata,
      },
    });
  }
}
