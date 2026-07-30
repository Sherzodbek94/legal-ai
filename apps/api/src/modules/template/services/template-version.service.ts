import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  AuditAction,
  Prisma,
  TemplateStatus,
  type TemplateVersion,
} from '@legaltech/database';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  parseVariableSchema,
  VariableSchemaError,
  type VariableSchema,
} from '../validation/variable-schema';
import {
  ApprovalChainError,
  DEFAULT_APPROVAL_CHAIN_BY_KIND,
  parseApprovalChain,
  type ApprovalChain,
} from '../workflow/approval-chain';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import type {
  CreateVersionDto,
  PublishVersionDto,
  RollbackDto,
} from '../dto/version.dto';

/**
 * Attempts at allocating a version number before giving up.
 *
 * Two concurrent editors saving a draft both compute the same "next" number;
 * the unique constraint on (templateId, version) fails one of them. Retrying
 * re-reads the maximum and succeeds, so the loser gets the next number instead
 * of an error they cannot act on. Three attempts covers realistic contention —
 * beyond that something is wrong and failing loudly is better than spinning.
 */
const MAX_ALLOCATION_ATTEMPTS = 3;

/** Postgres serialization failure, surfaced by Prisma as P2034. */
const SERIALIZATION_FAILURE = 'P2034';
const UNIQUE_VIOLATION = 'P2002';

@Injectable()
export class TemplateVersionService {
  private readonly logger = new Logger(TemplateVersionService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  async listVersions(templateId: string, companyId: string) {
    await this.assertTemplateVisible(templateId, companyId);

    return this.prisma.client.templateVersion.findMany({
      where: { templateId },
      orderBy: { version: 'desc' },
      select: {
        id: true,
        version: true,
        status: true,
        changeNote: true,
        createdById: true,
        publishedAt: true,
        archivedAt: true,
        createdAt: true,
      },
    });
  }

  async getVersion(templateId: string, versionId: string, companyId: string) {
    await this.assertTemplateVisible(templateId, companyId);

    const version = await this.prisma.client.templateVersion.findFirst({
      where: { id: versionId, templateId },
    });
    if (!version) {
      throw new NotFoundException('Template version not found');
    }
    return version;
  }

  /** The version document generation should use. */
  async getPublishedVersion(
    templateId: string,
    companyId: string,
  ): Promise<TemplateVersion> {
    await this.assertTemplateVisible(templateId, companyId);

    const version = await this.prisma.client.templateVersion.findFirst({
      where: { templateId, status: TemplateStatus.PUBLISHED },
      orderBy: { version: 'desc' },
    });

    if (!version) {
      throw new ConflictException(
        'Template has no published version; publish one before generating documents from it',
      );
    }
    return version;
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  /**
   * Opens a new draft version.
   *
   * Never edits an existing version in place. A published version is the text
   * somebody approved and possibly signed; the only honest way to change it is
   * to write a new one beside it.
   */
  async createDraft(
    templateId: string,
    dto: CreateVersionDto,
    user: AuthenticatedUser,
  ): Promise<TemplateVersion> {
    const template = await this.assertTemplateVisible(templateId, user.companyId!);

    const variableSchema = this.parseSchemaOrThrow(dto.variableSchema);
    const approvalChain = this.parseChainOrThrow(
      dto.approvalChain ?? this.defaultChainFor(template.categoryKind),
    );

    return this.allocateVersion(async (tx, version) => {
      const created = await tx.templateVersion.create({
        data: {
          templateId,
          version,
          status: TemplateStatus.DRAFT,
          content: dto.content as Prisma.InputJsonValue,
          variableSchema: variableSchema as unknown as Prisma.InputJsonValue,
          approvalChain: approvalChain as unknown as Prisma.InputJsonValue,
          changeNote: dto.changeNote,
          createdById: user.id,
        },
      });

      // Advisory high-water mark on the template, so listings can show the
      // latest number without touching the versions table.
      await tx.documentTemplate.update({
        where: { id: templateId },
        data: { version },
      });

      await this.writeAudit(tx, {
        companyId: user.companyId,
        userId: user.id,
        action: AuditAction.CREATE,
        entityType: 'TemplateVersion',
        entityId: created.id,
        metadata: { templateId, version },
      });

      return created;
    }, templateId);
  }

  /**
   * Makes a draft the version documents are generated from.
   *
   * Three writes that must agree — archive the incumbent, publish the draft,
   * repoint the template — so they run in one transaction. A partial apply here
   * leaves either two published versions or none, and "none" means every
   * generation from this template starts failing.
   */
  async publish(
    templateId: string,
    versionId: string,
    dto: PublishVersionDto,
    user: AuthenticatedUser,
  ): Promise<TemplateVersion> {
    await this.assertTemplateVisible(templateId, user.companyId!);

    return this.prisma.client.$transaction(async (tx) => {
      const version = await tx.templateVersion.findFirst({
        where: { id: versionId, templateId },
      });
      if (!version) {
        throw new NotFoundException('Template version not found');
      }
      if (version.status === TemplateStatus.PUBLISHED) {
        throw new ConflictException('That version is already published');
      }
      if (version.status === TemplateStatus.ARCHIVED) {
        throw new ConflictException(
          'An archived version cannot be republished; roll it forward into a new version instead',
        );
      }

      // Re-validate on the way out of draft. The schema was checked when the
      // draft was written, but a version becomes a contract with every document
      // generated from it, so it is worth confirming rather than assuming.
      this.parseSchemaOrThrow(version.variableSchema);
      this.parseChainOrThrow(version.approvalChain);

      const now = new Date();

      await tx.templateVersion.updateMany({
        where: { templateId, status: TemplateStatus.PUBLISHED },
        data: { status: TemplateStatus.ARCHIVED, archivedAt: now },
      });

      const published = await tx.templateVersion.update({
        where: { id: versionId },
        data: {
          status: TemplateStatus.PUBLISHED,
          publishedAt: now,
          changeNote: dto.changeNote ?? version.changeNote,
        },
      });

      await tx.documentTemplate.update({
        where: { id: templateId },
        data: {
          currentVersionId: published.id,
          status: TemplateStatus.PUBLISHED,
          // Denormalised copy so read paths that only render the current body
          // need no join.
          content: published.content as Prisma.InputJsonValue,
          version: published.version,
        },
      });

      await this.writeAudit(tx, {
        companyId: user.companyId,
        userId: user.id,
        action: AuditAction.UPDATE,
        entityType: 'TemplateVersion',
        entityId: published.id,
        metadata: {
          templateId,
          version: published.version,
          transition: 'PUBLISHED',
        },
      });

      return published;
    });
  }

  /**
   * Restores an earlier version by copying it forward as a new one.
   *
   * Deliberately not "un-archive": history stays append-only, so the record
   * shows that version 7 is a copy of version 3 rather than version 3 having
   * mysteriously become current again months after it was retired.
   */
  async rollback(
    templateId: string,
    dto: RollbackDto,
    user: AuthenticatedUser,
  ): Promise<TemplateVersion> {
    await this.assertTemplateVisible(templateId, user.companyId!);

    const source = await this.prisma.client.templateVersion.findFirst({
      where: { id: dto.versionId, templateId },
    });
    if (!source) {
      throw new NotFoundException('Template version not found');
    }
    if (source.status === TemplateStatus.PUBLISHED) {
      throw new ConflictException('That version is already the published one');
    }

    return this.allocateVersion(async (tx, version) => {
      const now = new Date();

      const clone = await tx.templateVersion.create({
        data: {
          templateId,
          version,
          status: TemplateStatus.PUBLISHED,
          publishedAt: now,
          content: source.content as Prisma.InputJsonValue,
          variableSchema: source.variableSchema as Prisma.InputJsonValue,
          approvalChain: source.approvalChain as Prisma.InputJsonValue,
          changeNote:
            dto.changeNote ?? `Rolled back to version ${source.version}`,
          createdById: user.id,
        },
      });

      await tx.templateVersion.updateMany({
        where: {
          templateId,
          status: TemplateStatus.PUBLISHED,
          id: { not: clone.id },
        },
        data: { status: TemplateStatus.ARCHIVED, archivedAt: now },
      });

      await tx.documentTemplate.update({
        where: { id: templateId },
        data: {
          currentVersionId: clone.id,
          status: TemplateStatus.PUBLISHED,
          content: clone.content as Prisma.InputJsonValue,
          version: clone.version,
        },
      });

      await this.writeAudit(tx, {
        companyId: user.companyId,
        userId: user.id,
        action: AuditAction.UPDATE,
        entityType: 'TemplateVersion',
        entityId: clone.id,
        metadata: {
          templateId,
          version: clone.version,
          rolledBackFrom: source.version,
        },
      });

      return clone;
    }, templateId);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Runs `work` inside a serializable transaction with the next version number.
   *
   * Serializable is the right level here rather than the default: computing
   * `max(version) + 1` and inserting it is a read-then-write whose correctness
   * depends on no one else inserting in between. Under READ COMMITTED two
   * transactions both read 4 and both try to write 5; the unique constraint
   * catches it, but only serializable lets the retry see a consistent snapshot.
   */
  private async allocateVersion<T>(
    work: (tx: Prisma.TransactionClient, version: number) => Promise<T>,
    templateId: string,
  ): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ALLOCATION_ATTEMPTS; attempt++) {
      try {
        return await this.prisma.client.$transaction(
          async (tx) => {
            const latest = await tx.templateVersion.findFirst({
              where: { templateId },
              orderBy: { version: 'desc' },
              select: { version: true },
            });

            return work(tx, (latest?.version ?? 0) + 1);
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if (!this.isRetryableAllocationError(error)) {
          throw error;
        }
        lastError = error;
        this.logger.warn(
          `Version allocation for template ${templateId} lost a race (attempt ${attempt}/${MAX_ALLOCATION_ATTEMPTS})`,
        );
      }
    }

    this.logger.error(
      `Version allocation for template ${templateId} failed after ${MAX_ALLOCATION_ATTEMPTS} attempts: ${
        (lastError as Error)?.message ?? 'unknown error'
      }`,
    );
    throw new ServiceUnavailableException(
      'Could not allocate a version number; please retry',
    );
  }

  private isRetryableAllocationError(error: unknown): boolean {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;

    if (error.code === SERIALIZATION_FAILURE) return true;

    // Only a collision on the version sequence is worth retrying — any other
    // unique violation would collide identically on the next attempt.
    if (error.code === UNIQUE_VIOLATION) {
      const target = error.meta?.target;
      const fields = Array.isArray(target) ? target : [target];
      return fields.includes('version') || fields.includes('templateId');
    }

    return false;
  }

  private parseSchemaOrThrow(raw: unknown): VariableSchema {
    try {
      return parseVariableSchema(raw);
    } catch (error) {
      if (error instanceof VariableSchemaError) {
        // 422, not 400: the request was well-formed JSON, the schema it carries
        // is not a usable variable contract.
        throw new UnprocessableEntityException({
          message: 'Invalid variable schema',
          issues: error.issues,
        });
      }
      throw error;
    }
  }

  private parseChainOrThrow(raw: unknown): ApprovalChain {
    try {
      return parseApprovalChain(raw);
    } catch (error) {
      if (error instanceof ApprovalChainError) {
        throw new UnprocessableEntityException({
          message: 'Invalid approval chain',
          issues: error.issues,
        });
      }
      throw error;
    }
  }

  private defaultChainFor(kind?: keyof typeof DEFAULT_APPROVAL_CHAIN_BY_KIND) {
    return kind
      ? DEFAULT_APPROVAL_CHAIN_BY_KIND[kind]
      : DEFAULT_APPROVAL_CHAIN_BY_KIND.CONTRACT;
  }

  /** Loads the template and the taxonomy branch it sits in, tenant-scoped. */
  private async assertTemplateVisible(templateId: string, companyId: string) {
    const template = await this.prisma.client.documentTemplate.findFirst({
      where: { id: templateId, companyId, deletedAt: null },
      include: { taxonomy: { select: { kind: true } } },
    });

    if (!template) {
      throw new NotFoundException('Template not found');
    }

    return { ...template, categoryKind: template.taxonomy?.kind };
  }

  private writeAudit(
    tx: Prisma.TransactionClient,
    entry: {
      companyId?: string;
      userId?: string;
      action: AuditAction;
      entityType: string;
      entityId: string;
      metadata?: Prisma.InputJsonValue;
    },
  ) {
    return tx.auditLog.create({
      data: {
        companyId: entry.companyId ?? null,
        userId: entry.userId ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        metadata: entry.metadata,
      },
    });
  }
}
