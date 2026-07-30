import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  TemplateCategoryKind,
  type TemplateCategory,
} from '@legaltech/database';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  flattenTaxonomy,
  TEMPLATE_TAXONOMY,
  type FlatTaxonomyNode,
} from '../taxonomy/taxonomy.catalog';
import type { CreateCategoryDto, UpdateCategoryDto } from '../dto/taxonomy.dto';

export interface CategoryNode {
  id: string;
  slug: string;
  name: string;
  nameRu: string | null;
  nameUz: string | null;
  description: string | null;
  kind: TemplateCategoryKind;
  path: string;
  depth: number;
  /** Templates filed directly on this node. */
  templateCount: number;
  /** Templates on this node and everything beneath it. */
  totalTemplateCount: number;
  children: CategoryNode[];
}

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Cap on tree depth. The taxonomy is navigation, and a path deeper than this is
 * a sign someone is modelling document *content* as categories.
 */
const MAX_DEPTH = 6;

@Injectable()
export class TaxonomyService {
  private readonly logger = new Logger(TaxonomyService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /**
   * The categories visible to a tenant: the shared platform catalogue plus any
   * the company added for itself.
   */
  private visibilityFilter(companyId?: string): Prisma.TemplateCategoryWhereInput {
    return {
      deletedAt: null,
      OR: [{ companyId: null }, ...(companyId ? [{ companyId }] : [])],
    };
  }

  /**
   * Builds the nested tree in one query.
   *
   * The whole taxonomy is a few hundred rows, so fetching it flat and assembling
   * in memory beats any recursive query — and beats the N+1 that a naive
   * `include: { children: ... }` produces at this depth.
   */
  async getTree(
    companyId?: string,
    kind?: TemplateCategoryKind,
  ): Promise<CategoryNode[]> {
    const [categories, counts] = await Promise.all([
      this.prisma.client.templateCategory.findMany({
        where: {
          ...this.visibilityFilter(companyId),
          ...(kind ? { kind } : {}),
        },
        orderBy: [{ depth: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
      }),
      this.templateCountsByCategory(companyId),
    ]);

    return this.assembleTree(categories, counts);
  }

  /** Direct template counts, keyed by category id. */
  private async templateCountsByCategory(
    companyId?: string,
  ): Promise<Map<string, number>> {
    const grouped = await this.prisma.client.documentTemplate.groupBy({
      by: ['categoryId'],
      where: {
        deletedAt: null,
        categoryId: { not: null },
        ...(companyId ? { companyId } : {}),
      },
      _count: { _all: true },
    });

    return new Map(
      grouped
        .filter((row) => row.categoryId !== null)
        .map((row) => [row.categoryId as string, row._count._all]),
    );
  }

  private assembleTree(
    categories: TemplateCategory[],
    counts: Map<string, number>,
  ): CategoryNode[] {
    const byId = new Map<string, CategoryNode>();
    const roots: CategoryNode[] = [];

    for (const category of categories) {
      byId.set(category.id, {
        id: category.id,
        slug: category.slug,
        name: category.name,
        nameRu: category.nameRu,
        nameUz: category.nameUz,
        description: category.description,
        kind: category.kind,
        path: category.path,
        depth: category.depth,
        templateCount: counts.get(category.id) ?? 0,
        totalTemplateCount: 0,
        children: [],
      });
    }

    // Rows arrive depth-ascending, so a parent is always in the map before its
    // children are visited.
    for (const category of categories) {
      const node = byId.get(category.id);
      if (!node) continue;

      const parent = category.parentId ? byId.get(category.parentId) : undefined;
      if (parent) {
        parent.children.push(node);
      } else {
        // A node whose parent was filtered out (e.g. by `kind`) is treated as a
        // root rather than dropped, so a filtered tree never loses rows.
        roots.push(node);
      }
    }

    const rollUp = (node: CategoryNode): number => {
      node.totalTemplateCount =
        node.templateCount +
        node.children.reduce((sum, child) => sum + rollUp(child), 0);
      return node.totalTemplateCount;
    };
    roots.forEach(rollUp);

    return roots;
  }

  async findOne(id: string, companyId?: string): Promise<TemplateCategory> {
    const category = await this.prisma.client.templateCategory.findFirst({
      where: { id, ...this.visibilityFilter(companyId) },
    });

    if (!category) {
      throw new NotFoundException('Category not found');
    }
    return category;
  }

  /**
   * Every category beneath `id`, inclusive.
   *
   * One indexed prefix scan on the materialized path — the reason the path is
   * stored with a trailing slash is that `/contracts/lease/` cannot then match
   * a hypothetical sibling `/contracts/lease-financing/`.
   */
  async listSubtree(
    id: string,
    companyId?: string,
  ): Promise<TemplateCategory[]> {
    const root = await this.findOne(id, companyId);

    return this.prisma.client.templateCategory.findMany({
      where: {
        ...this.visibilityFilter(companyId),
        path: { startsWith: root.path },
      },
      orderBy: [{ depth: 'asc' }, { sortOrder: 'asc' }],
    });
  }

  /** Ancestors from the root down to `id`, inclusive — derived from the path. */
  async getBreadcrumb(
    id: string,
    companyId?: string,
  ): Promise<TemplateCategory[]> {
    const category = await this.findOne(id, companyId);

    const segments = category.path.split('/').filter(Boolean);
    const ancestorPaths = segments.map(
      (_, index) => `/${segments.slice(0, index + 1).join('/')}/`,
    );

    const ancestors = await this.prisma.client.templateCategory.findMany({
      where: {
        ...this.visibilityFilter(companyId),
        path: { in: ancestorPaths },
      },
    });

    return ancestors.sort((a, b) => a.depth - b.depth);
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  async createCategory(
    dto: CreateCategoryDto,
    companyId: string,
  ): Promise<TemplateCategory> {
    if (!SLUG_PATTERN.test(dto.slug)) {
      throw new BadRequestException(
        'Slug must be lowercase alphanumeric segments separated by hyphens',
      );
    }

    return this.prisma.client.$transaction(async (tx) => {
      let parent: TemplateCategory | null = null;

      if (dto.parentId) {
        parent = await tx.templateCategory.findFirst({
          where: {
            id: dto.parentId,
            deletedAt: null,
            OR: [{ companyId: null }, { companyId }],
          },
        });
        if (!parent) {
          throw new NotFoundException('Parent category not found');
        }
        if (parent.depth + 1 > MAX_DEPTH) {
          throw new BadRequestException(
            `Category nesting is limited to ${MAX_DEPTH} levels`,
          );
        }
      } else if (!dto.kind) {
        throw new BadRequestException(
          'A root category must declare its kind',
        );
      }

      const path = `${parent?.path ?? '/'}${dto.slug}/`;

      const clash = await tx.templateCategory.findFirst({
        where: { path, OR: [{ companyId: null }, { companyId }] },
        select: { id: true },
      });
      if (clash) {
        throw new ConflictException(`A category already exists at ${path}`);
      }

      return tx.templateCategory.create({
        data: {
          companyId,
          parentId: parent?.id ?? null,
          // A child always inherits its branch; only a root may declare one.
          kind: parent?.kind ?? (dto.kind as TemplateCategoryKind),
          slug: dto.slug,
          name: dto.name,
          nameRu: dto.nameRu,
          nameUz: dto.nameUz,
          description: dto.description,
          path,
          depth: parent ? parent.depth + 1 : 0,
          sortOrder: dto.sortOrder ?? 0,
        },
      });
    });
  }

  /**
   * Renames or re-labels a category. Tenant-owned only: the shared catalogue is
   * maintained through the seed so every tenant keeps the same reference tree.
   */
  async updateCategory(
    id: string,
    dto: UpdateCategoryDto,
    companyId: string,
  ): Promise<TemplateCategory> {
    const category = await this.prisma.client.templateCategory.findFirst({
      where: { id, companyId, deletedAt: null },
    });
    if (!category) {
      throw new NotFoundException('Category not found');
    }

    return this.prisma.client.templateCategory.update({
      where: { id },
      data: {
        name: dto.name,
        nameRu: dto.nameRu,
        nameUz: dto.nameUz,
        description: dto.description,
        sortOrder: dto.sortOrder,
      },
    });
  }

  /**
   * Re-parents a category and rewrites the materialized path of its whole
   * subtree.
   *
   * The rewrite is the reason this needs a transaction: a partially rewritten
   * subtree is a tree with orphaned paths, where prefix queries silently return
   * the wrong branch. Either every descendant moves or none does.
   */
  async moveCategory(
    id: string,
    newParentId: string | null,
    companyId: string,
  ): Promise<TemplateCategory> {
    return this.prisma.client.$transaction(async (tx) => {
      const category = await tx.templateCategory.findFirst({
        where: { id, companyId, deletedAt: null },
      });
      if (!category) {
        throw new NotFoundException('Category not found');
      }

      let parent: TemplateCategory | null = null;
      if (newParentId) {
        parent = await tx.templateCategory.findFirst({
          where: {
            id: newParentId,
            deletedAt: null,
            OR: [{ companyId: null }, { companyId }],
          },
        });
        if (!parent) {
          throw new NotFoundException('Parent category not found');
        }

        // Moving a node beneath itself would detach the subtree from every root
        // and make it unreachable. The path makes the check a prefix test.
        if (parent.path.startsWith(category.path)) {
          throw new BadRequestException(
            'A category cannot be moved beneath itself',
          );
        }
        if (parent.kind !== category.kind) {
          throw new BadRequestException(
            'A category cannot be moved into a different taxonomy branch',
          );
        }
      }

      const oldPath = category.path;
      const newPath = `${parent?.path ?? '/'}${category.slug}/`;

      if (newPath === oldPath) {
        return category;
      }

      const descendants = await tx.templateCategory.findMany({
        where: {
          path: { startsWith: oldPath },
          OR: [{ companyId: null }, { companyId }],
        },
        select: { id: true, path: true, depth: true },
      });

      const deepest = Math.max(...descendants.map((d) => d.depth));
      const newDepth = (parent?.depth ?? -1) + 1;
      if (newDepth + (deepest - category.depth) > MAX_DEPTH) {
        throw new BadRequestException(
          `Moving this branch would exceed the ${MAX_DEPTH}-level nesting limit`,
        );
      }

      const clash = await tx.templateCategory.findFirst({
        where: { path: newPath, OR: [{ companyId: null }, { companyId }] },
        select: { id: true },
      });
      if (clash) {
        throw new ConflictException(`A category already exists at ${newPath}`);
      }

      const depthShift = newDepth - category.depth;

      for (const descendant of descendants) {
        await tx.templateCategory.update({
          where: { id: descendant.id },
          data: {
            path: `${newPath}${descendant.path.slice(oldPath.length)}`,
            depth: descendant.depth + depthShift,
            ...(descendant.id === category.id
              ? { parentId: parent?.id ?? null }
              : {}),
          },
        });
      }

      return tx.templateCategory.findFirstOrThrow({ where: { id } });
    });
  }

  /**
   * Soft-deletes a leaf.
   *
   * Refuses while anything still hangs off it: a template whose category has
   * vanished is invisible in navigation, which for a catalogue this size means
   * it is lost rather than merely uncategorised.
   */
  async removeCategory(id: string, companyId: string): Promise<void> {
    await this.prisma.client.$transaction(async (tx) => {
      const category = await tx.templateCategory.findFirst({
        where: { id, companyId, deletedAt: null },
      });
      if (!category) {
        throw new NotFoundException('Category not found');
      }

      const [childCount, templateCount] = await Promise.all([
        tx.templateCategory.count({
          where: {
            deletedAt: null,
            path: { startsWith: category.path },
            id: { not: id },
          },
        }),
        tx.documentTemplate.count({
          where: { categoryId: id, deletedAt: null },
        }),
      ]);

      if (childCount > 0) {
        throw new ConflictException(
          `Category has ${childCount} subcategor${childCount === 1 ? 'y' : 'ies'}; remove them first`,
        );
      }
      if (templateCount > 0) {
        throw new ConflictException(
          `Category still holds ${templateCount} template(s); move them first`,
        );
      }

      await tx.templateCategory.update({
        where: { id },
        data: { deletedAt: new Date() },
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Seeding
  // ---------------------------------------------------------------------------

  /**
   * Installs the platform-wide catalogue from `taxonomy.catalog.ts`.
   *
   * Idempotent and additive: safe to run on every deploy. Rows are written one
   * depth level at a time because a child needs its parent's generated id, and
   * `createMany` does not return ids — three round trips for the whole tree
   * rather than one per node.
   *
   * Removals are deliberately not applied. Deleting a category that tenant
   * templates already reference is a data-loss migration, not a seed step; it
   * goes through an explicit migration when the legal team retires a branch.
   */
  async seedPlatformTaxonomy(): Promise<{
    created: number;
    updated: number;
    unchanged: number;
  }> {
    const nodes = flattenTaxonomy(TEMPLATE_TAXONOMY);
    const maxDepth = Math.max(...nodes.map((node) => node.depth));

    let created = 0;
    let updated = 0;

    const existing = await this.prisma.client.templateCategory.findMany({
      where: { companyId: null },
      select: {
        id: true,
        path: true,
        name: true,
        nameRu: true,
        nameUz: true,
        description: true,
        sortOrder: true,
        deletedAt: true,
      },
    });

    const idByPath = new Map(existing.map((row) => [row.path, row.id]));
    const byPath = new Map(existing.map((row) => [row.path, row]));

    for (let depth = 0; depth <= maxDepth; depth++) {
      const level = nodes.filter((node) => node.depth === depth);
      const missing = level.filter((node) => !idByPath.has(node.path));

      if (missing.length > 0) {
        await this.prisma.client.templateCategory.createMany({
          data: missing.map((node) => this.toSeedRow(node, idByPath)),
          skipDuplicates: true,
        });
        created += missing.length;

        const inserted = await this.prisma.client.templateCategory.findMany({
          where: {
            companyId: null,
            path: { in: missing.map((node) => node.path) },
          },
          select: { id: true, path: true },
        });
        for (const row of inserted) {
          idByPath.set(row.path, row.id);
        }
      }
    }

    // Labels drift as the legal team refines wording; propagate those without
    // touching structure.
    for (const node of nodes) {
      const row = byPath.get(node.path);
      if (!row) continue;

      const changed =
        row.name !== node.name ||
        (row.nameRu ?? undefined) !== node.nameRu ||
        (row.nameUz ?? undefined) !== node.nameUz ||
        (row.description ?? undefined) !== node.description ||
        row.sortOrder !== node.sortOrder ||
        row.deletedAt !== null;

      if (!changed) continue;

      await this.prisma.client.templateCategory.update({
        where: { id: row.id },
        data: {
          name: node.name,
          nameRu: node.nameRu ?? null,
          nameUz: node.nameUz ?? null,
          description: node.description ?? null,
          sortOrder: node.sortOrder,
          // A category that reappears in the catalogue is un-retired.
          deletedAt: null,
        },
      });
      updated++;
    }

    const unchanged = nodes.length - created - updated;
    this.logger.log(
      `Taxonomy seed: ${created} created, ${updated} updated, ${unchanged} unchanged (${nodes.length} nodes)`,
    );

    return { created, updated, unchanged };
  }

  private toSeedRow(
    node: FlatTaxonomyNode,
    idByPath: Map<string, string>,
  ): Prisma.TemplateCategoryCreateManyInput {
    return {
      companyId: null,
      parentId: node.parentPath ? (idByPath.get(node.parentPath) ?? null) : null,
      kind: node.kind,
      slug: node.slug,
      name: node.name,
      nameRu: node.nameRu ?? null,
      nameUz: node.nameUz ?? null,
      description: node.description ?? null,
      path: node.path,
      depth: node.depth,
      sortOrder: node.sortOrder,
    };
  }
}
