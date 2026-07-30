import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  AuditAction,
  Prisma,
  TemplateStatus,
  type TemplateCategoryKind,
} from '@legaltech/database';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  parseVariableSchema,
  VariableSchemaError,
  EMPTY_VARIABLE_SCHEMA,
} from '../validation/variable-schema';
import {
  ApprovalChainError,
  DEFAULT_APPROVAL_CHAIN_BY_KIND,
  parseApprovalChain,
} from '../workflow/approval-chain';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import type {
  CreateTemplateDto,
  ListTemplatesQuery,
  MoveTemplateDto,
  UpdateTemplateDto,
} from '../dto/template.dto';

/** Page size ceiling. The catalogue is thousands of rows; nobody renders them all. */
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 50;

@Injectable()
export class TemplateService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /**
   * Lists templates within the taxonomy.
   *
   * Keyset (cursor) pagination rather than offset: at a few thousand templates
   * an `OFFSET 2500` still makes Postgres walk 2500 rows, and a template
   * inserted mid-scroll shifts every subsequent page. Ordering by `(createdAt,
   * id)` gives a stable, index-backed cursor.
   */
  async list(query: ListTemplatesQuery, companyId: string) {
    const take = Math.min(query.take ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

    const where: Prisma.DocumentTemplateWhereInput = {
      companyId,
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { description: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    // A category filter means "this branch", not "this exact node" — asking for
    // Contracts should return every contract, not the handful filed directly on
    // the root. Resolved to a path prefix so it stays one indexed scan.
    if (query.categoryId) {
      const category = await this.prisma.client.templateCategory.findFirst({
        where: {
          id: query.categoryId,
          deletedAt: null,
          OR: [{ companyId: null }, { companyId }],
        },
        select: { path: true },
      });
      if (!category) {
        throw new NotFoundException('Category not found');
      }

      const branch = await this.prisma.client.templateCategory.findMany({
        where: {
          path: { startsWith: category.path },
          deletedAt: null,
          OR: [{ companyId: null }, { companyId }],
        },
        select: { id: true },
      });

      where.categoryId = { in: branch.map((row) => row.id) };
    } else if (query.kind) {
      where.taxonomy = { kind: query.kind as TemplateCategoryKind };
    }

    const rows = await this.prisma.client.documentTemplate.findMany({
      where,
      // One extra row tells us whether another page exists without a count(*).
      take: take + 1,
      ...(query.cursor
        ? { cursor: { id: query.cursor }, skip: 1 }
        : {}),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        status: true,
        version: true,
        categoryId: true,
        currentVersionId: true,
        createdAt: true,
        updatedAt: true,
        taxonomy: {
          select: { id: true, name: true, path: true, kind: true },
        },
      },
    });

    const hasMore = rows.length > take;
    const items = hasMore ? rows.slice(0, take) : rows;

    return {
      items,
      nextCursor: hasMore ? items[items.length - 1].id : null,
    };
  }

  async findOne(id: string, companyId: string) {
    const template = await this.prisma.client.documentTemplate.findFirst({
      where: { id, companyId, deletedAt: null },
      include: {
        taxonomy: { select: { id: true, name: true, path: true, kind: true } },
        currentVersion: {
          select: {
            id: true,
            version: true,
            status: true,
            variableSchema: true,
            approvalChain: true,
            publishedAt: true,
          },
        },
      },
    });

    if (!template) {
      throw new NotFoundException('Template not found');
    }
    return template;
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  /**
   * Creates a template together with its first draft version.
   *
   * Both or neither: a template row with no version is unusable — it cannot be
   * published, cannot be generated from, and shows up in the catalogue as a
   * dead entry someone has to clean up by hand.
   */
  async create(dto: CreateTemplateDto, user: AuthenticatedUser) {
    const companyId = user.companyId!;

    const category = await this.resolveCategory(dto.categoryId, companyId);

    const variableSchema = this.parseSchema(
      dto.variableSchema ?? EMPTY_VARIABLE_SCHEMA,
    );
    const approvalChain = this.parseChain(
      dto.approvalChain ?? DEFAULT_APPROVAL_CHAIN_BY_KIND[category.kind],
    );

    try {
      return await this.prisma.client.$transaction(async (tx) => {
        const template = await tx.documentTemplate.create({
          data: {
            companyId,
            categoryId: category.id,
            name: dto.name,
            slug: dto.slug,
            description: dto.description,
            content: dto.content as Prisma.InputJsonValue,
            status: TemplateStatus.DRAFT,
            version: 1,
          },
        });

        const version = await tx.templateVersion.create({
          data: {
            templateId: template.id,
            version: 1,
            status: TemplateStatus.DRAFT,
            content: dto.content as Prisma.InputJsonValue,
            variableSchema: variableSchema as unknown as Prisma.InputJsonValue,
            approvalChain: approvalChain as unknown as Prisma.InputJsonValue,
            changeNote: 'Initial version',
            createdById: user.id,
          },
        });

        await tx.auditLog.create({
          data: {
            companyId,
            userId: user.id,
            action: AuditAction.CREATE,
            entityType: 'DocumentTemplate',
            entityId: template.id,
            metadata: { categoryPath: category.path, versionId: version.id },
          },
        });

        return { ...template, currentDraftVersionId: version.id };
      });
    } catch (error) {
      throw this.translateUniqueViolation(error);
    }
  }

  async update(id: string, dto: UpdateTemplateDto, user: AuthenticatedUser) {
    const companyId = user.companyId!;
    await this.findOne(id, companyId);

    try {
      return await this.prisma.client.documentTemplate.update({
        where: { id },
        data: {
          name: dto.name,
          slug: dto.slug,
          description: dto.description,
        },
      });
    } catch (error) {
      throw this.translateUniqueViolation(error);
    }
  }

  /** Re-files a template under a different taxonomy node. */
  async move(id: string, dto: MoveTemplateDto, user: AuthenticatedUser) {
    const companyId = user.companyId!;
    await this.findOne(id, companyId);

    const category = await this.resolveCategory(dto.categoryId, companyId);

    return this.prisma.client.$transaction(async (tx) => {
      const moved = await tx.documentTemplate.update({
        where: { id },
        data: { categoryId: category.id },
      });

      await tx.auditLog.create({
        data: {
          companyId,
          userId: user.id,
          action: AuditAction.UPDATE,
          entityType: 'DocumentTemplate',
          entityId: id,
          metadata: { movedTo: category.path },
        },
      });

      return moved;
    });
  }

  /**
   * Soft-deletes a template.
   *
   * Versions are left untouched — documents generated from them still point at
   * that text, and an approved contract must stay resolvable after the template
   * behind it is retired.
   */
  async softDelete(id: string, user: AuthenticatedUser) {
    const companyId = user.companyId!;
    await this.findOne(id, companyId);

    await this.prisma.client.$transaction(async (tx) => {
      await tx.documentTemplate.update({
        where: { id },
        data: { deletedAt: new Date(), status: TemplateStatus.ARCHIVED },
      });

      await tx.auditLog.create({
        data: {
          companyId,
          userId: user.id,
          action: AuditAction.DELETE,
          entityType: 'DocumentTemplate',
          entityId: id,
        },
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async resolveCategory(categoryId: string, companyId: string) {
    const category = await this.prisma.client.templateCategory.findFirst({
      where: {
        id: categoryId,
        deletedAt: null,
        OR: [{ companyId: null }, { companyId }],
      },
      select: { id: true, kind: true, path: true },
    });

    if (!category) {
      throw new NotFoundException('Category not found');
    }

    // Interior nodes are navigation. Filing a template on one hides it from the
    // leaf listings users actually browse.
    const childCount = await this.prisma.client.templateCategory.count({
      where: {
        parentId: category.id,
        deletedAt: null,
      },
    });
    if (childCount > 0) {
      throw new BadRequestException(
        'Templates must be filed on a leaf category, not a branch',
      );
    }

    return category;
  }

  private parseSchema(raw: unknown) {
    try {
      return parseVariableSchema(raw);
    } catch (error) {
      if (error instanceof VariableSchemaError) {
        throw new UnprocessableEntityException({
          message: 'Invalid variable schema',
          issues: error.issues,
        });
      }
      throw error;
    }
  }

  private parseChain(raw: unknown) {
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

  /** `(companyId, slug)` is unique; Prisma reports the collision as P2002. */
  private translateUniqueViolation(error: unknown): unknown {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return new ConflictException(
        'A template with that slug already exists in this company',
      );
    }
    return error;
  }
}
