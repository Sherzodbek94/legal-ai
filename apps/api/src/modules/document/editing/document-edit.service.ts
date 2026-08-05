import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  GeneratedDocumentStatus,
  Prisma,
} from '@legaltech/database';
import { PrismaService } from '../../../prisma/prisma.service';

export interface EditDocumentInput {
  title?: string;
  /** Editor JSON, same shape the generator writes and the exporters read. */
  content?: Prisma.InputJsonValue;
  /**
   * The revision the editor was showing when the user started typing.
   *
   * Required. Without it the last save silently wins, and in a two-lawyer
   * workspace the way that presents is one of them finding their clause gone
   * with nothing to indicate it ever existed.
   */
  expectedRevision: number;
}

/**
 * Editing a generated document, with history.
 *
 * A document used to be immutable — created, approved, exported. Real drafting
 * is not that: a clause gets reworded, a date corrected, an annex added. With
 * no edit path, every correction meant regenerating from the template and
 * losing the work.
 *
 * Two rules carry the weight here, and both are about not destroying something
 * quietly.
 */
@Injectable()
export class DocumentEditService {
  private readonly logger = new Logger(DocumentEditService.name);

  /**
   * Statuses an edit is refused for.
   *
   * PENDING_APPROVAL: approvers are reading the text right now, and changing it
   * under them means they approve something other than what they read.
   *
   * COMPLETED: every step approved. Editing after that silently converts other
   * people's signatures into approval of text they never saw — the same class
   * of failure as letting a submitter approve their own document, which this
   * product already refuses. A finished document that needs changing needs a
   * new round, not a quiet rewrite.
   */
  private static readonly LOCKED: GeneratedDocumentStatus[] = [
    GeneratedDocumentStatus.PENDING_APPROVAL,
    GeneratedDocumentStatus.COMPLETED,
    GeneratedDocumentStatus.FINALIZED,
    GeneratedDocumentStatus.GENERATING,
  ];

  constructor(private readonly prisma: PrismaService) {}

  async update(
    documentId: string,
    companyId: string,
    userId: string,
    input: EditDocumentInput,
  ) {
    const document = await this.prisma.client.generatedDocument.findFirst({
      where: { id: documentId, companyId, deletedAt: null },
      select: {
        id: true,
        title: true,
        content: true,
        status: true,
        revision: true,
        approvalRound: true,
      },
    });

    if (!document) throw new NotFoundException('Document not found');

    if (DocumentEditService.LOCKED.includes(document.status)) {
      throw new ConflictException(
        document.status === GeneratedDocumentStatus.PENDING_APPROVAL
          ? 'This document is awaiting approval. Withdraw it before editing.'
          : `A ${document.status.toLowerCase().replace(/_/g, ' ')} document cannot be edited.`,
      );
    }

    if (document.revision !== input.expectedRevision) {
      // 409 with the current revision, so the client can show what changed
      // rather than only that something did.
      throw new ConflictException({
        message:
          'Someone else saved this document while you were editing. Reload to see their changes.',
        currentRevision: document.revision,
      });
    }

    const updated = await this.prisma.client.$transaction(async (tx) => {
      // The state being displaced is snapshotted, not the new one. That is what
      // makes the list "the states this document passed through" — the current
      // state is the live row, which is where a reader already looks.
      await tx.generatedDocumentVersion.create({
        data: {
          documentId,
          version: document.revision,
          title: document.title,
          content: document.content ?? Prisma.DbNull,
          editedById: userId,
          approvalRound: document.approvalRound,
        },
      });

      // Conditional on the revision as well as the id. Two saves that both
      // passed the check above race here, and this is what makes the second
      // one update no rows rather than overwrite the first.
      const { count } = await tx.generatedDocument.updateMany({
        where: { id: documentId, revision: document.revision },
        data: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.content !== undefined ? { content: input.content } : {}),
          revision: { increment: 1 },
          // A rejected document that is being corrected returns to DRAFT, which
          // is what its status already is; nothing else changes status here.
        },
      });

      if (count === 0) {
        throw new ConflictException(
          'Someone else saved this document while you were editing. Reload to see their changes.',
        );
      }

      await tx.auditLog.create({
        data: {
          companyId,
          userId,
          action: AuditAction.UPDATE,
          entityType: 'GeneratedDocument',
          entityId: documentId,
          metadata: {
            // The revision the edit produced, so the log entry and the version
            // list line up without a join.
            revision: document.revision + 1,
            titleChanged: input.title !== undefined,
            bodyChanged: input.content !== undefined,
          },
        },
      });

      return tx.generatedDocument.findUniqueOrThrow({
        where: { id: documentId },
        select: {
          id: true,
          title: true,
          content: true,
          status: true,
          revision: true,
          updatedAt: true,
        },
      });
    });

    return updated;
  }

  /**
   * The document's history, newest first.
   *
   * Bodies are excluded. A version's content is the whole document and the list
   * is rendered as a sidebar — sending every past body to draw a list of dates
   * would move megabytes to display kilobytes.
   */
  async listVersions(documentId: string, companyId: string) {
    await this.assertVisible(documentId, companyId);

    return this.prisma.client.generatedDocumentVersion.findMany({
      where: { documentId },
      orderBy: { version: 'desc' },
      select: {
        id: true,
        version: true,
        title: true,
        approvalRound: true,
        createdAt: true,
        editedBy: { select: { id: true, name: true, email: true } },
      },
    });
  }

  /** One past state, with its body — for previewing before a restore. */
  async getVersion(documentId: string, companyId: string, versionId: string) {
    await this.assertVisible(documentId, companyId);

    const version = await this.prisma.client.generatedDocumentVersion.findFirst({
      where: { id: versionId, documentId },
      select: {
        id: true,
        version: true,
        title: true,
        content: true,
        approvalRound: true,
        createdAt: true,
        editedBy: { select: { id: true, name: true, email: true } },
      },
    });

    if (!version) throw new NotFoundException('Version not found');
    return version;
  }

  /**
   * Restores a past state.
   *
   * Implemented as an ordinary edit rather than a rewind: the current state is
   * snapshotted first, so restoring is itself undoable. A restore that
   * discarded the state it replaced would be the one operation in this service
   * that loses work.
   */
  async restore(
    documentId: string,
    companyId: string,
    userId: string,
    versionId: string,
  ) {
    const version = await this.getVersion(documentId, companyId, versionId);

    const current = await this.prisma.client.generatedDocument.findFirstOrThrow({
      where: { id: documentId, companyId, deletedAt: null },
      select: { revision: true },
    });

    const restored = await this.update(documentId, companyId, userId, {
      title: version.title,
      content: (version.content ?? Prisma.DbNull) as Prisma.InputJsonValue,
      expectedRevision: current.revision,
    });

    this.logger.log(
      `Document ${documentId} restored to version ${version.version} by ${userId}`,
    );

    return restored;
  }

  private async assertVisible(documentId: string, companyId: string) {
    const found = await this.prisma.client.generatedDocument.findFirst({
      where: { id: documentId, companyId, deletedAt: null },
      select: { id: true },
    });

    if (!found) throw new NotFoundException('Document not found');
  }
}
