import {
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  AuditAction,
  GeneratedDocumentStatus,
  Prisma,
  UsageMetric,
} from '@legaltech/database';
import { PrismaService } from '../../../prisma/prisma.service';
import { TemplateVersionService } from '../../template/services/template-version.service';
import {
  parseVariableSchema,
  VariableSchemaError,
} from '../../template/validation/variable-schema';
import {
  formatValuesForDocument,
  validateVariableValues,
} from '../../template/validation/variable-values';
import { CompanyService } from '../../company/company.service';
import { AiEngineService } from '../../ai-engine/ai-engine.service';
import { UsageService } from '../../billing/limits/usage.service';
import { quotaRefusal } from '../../billing/limits/quota-refusal';
import { collectPlaceholders, interpolateContent } from './interpolate-content';
import { draftToContent, draftToSummary } from './draft-to-content';
import type { TipTapNode } from '../generator/tiptap-node';
import type { CreateDocumentDto } from '../dto/create-document.dto';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import type { LegalLocale } from '../../ai-engine/providers/llm-provider.interface';

interface BuiltBody {
  content: TipTapNode;
  status: GeneratedDocumentStatus;
  aiSummary?: string;
  /** Declared variables left blank in the rendered body. */
  unresolved: string[];
}

/**
 * Creates documents from templates.
 *
 * This is the endpoint everything else in the product waits on. Templates could
 * be authored and versioned, the approval chain could run, and PDF/DOCX export
 * worked — but nothing ever wrote a `GeneratedDocument`, so none of it was
 * reachable. Approval and export both start from a row this service creates.
 *
 * Two ways to produce a body:
 *
 *   * Interpolation (default) — substitutes values into the published template
 *     text. Deterministic, free, needs no API key, and produces text a lawyer
 *     already reviewed. This is why the product is usable before any AI vendor
 *     is configured.
 *   * AI drafting (`useAi`) — asks the model for the body. Costs money and
 *     metered separately, so it is opt-in rather than the default.
 */
@Injectable()
export class DocumentCreationService {
  private readonly logger = new Logger(DocumentCreationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly versions: TemplateVersionService,
    private readonly companies: CompanyService,
    private readonly aiEngine: AiEngineService,
    private readonly usage: UsageService,
  ) {}

  async create(dto: CreateDocumentDto, user: AuthenticatedUser) {
    const companyId = user.companyId!;

    // Resolved through the version service rather than the template's
    // denormalised `currentVersionId`, so "which version generates documents"
    // has exactly one definition. Throws if the template was never published.
    const version = await this.versions.getPublishedVersion(
      dto.templateId,
      companyId,
    );

    const template = await this.prisma.client.documentTemplate.findFirst({
      where: { id: dto.templateId, companyId, deletedAt: null },
      select: { id: true, name: true },
    });
    if (!template) throw new NotFoundException('Template not found');

    const schema = this.parseSchemaOrThrow(version.variableSchema);

    const merged = await this.mergeWithCompanyDefaults(
      schema.variables.map((variable) => variable.key),
      dto.variables ?? {},
      companyId,
    );

    const validation = validateVariableValues(schema, merged);
    if (!validation.ok) {
      // 422 with the full issue list, not 400 on the first failure: the caller
      // is rendering a form and needs every field marked at once.
      throw new UnprocessableEntityException({
        message: 'Invalid variable values',
        issues: validation.issues,
      });
    }

    const body = dto.useAi
      ? await this.buildWithAi(dto, template.name, validation.promptVariables, user)
      : this.buildFromTemplate(
          version.content,
          formatValuesForDocument(schema, validation.values),
        );

    const document = await this.persist({
      companyId,
      templateId: template.id,
      templateVersionId: version.id,
      createdById: user.id,
      title: dto.title?.trim() || template.name,
      body,
      // The values as validated, not as rendered: reproducing a generation
      // needs the inputs, and the rendered strings are derived from them.
      promptVariables: validation.values,
    });

    return {
      ...document,
      // Surfaced rather than buried. A document whose optional clauses rendered
      // as blanks looks finished, and the person who asked for it is the only
      // one positioned to notice a blank should have been filled.
      unresolvedVariables: body.unresolved,
    };
  }

  // ---------------------------------------------------------------------------
  // Body construction
  // ---------------------------------------------------------------------------

  private buildFromTemplate(
    templateContent: Prisma.JsonValue,
    values: Record<string, string>,
  ): BuiltBody {
    const result = interpolateContent(templateContent, values);

    if (result.malformed) {
      // The template body has a `{{` whose closing braces sit in a different
      // text node, usually because an author bolded part of a placeholder. It
      // can never be filled, so failing here is better than shipping a contract
      // with template syntax printed in it.
      const declared = collectPlaceholders(templateContent);
      throw new UnprocessableEntityException({
        message:
          'The template body contains a placeholder split by formatting and cannot be filled. Re-enter it as unformatted text.',
        placeholders: declared,
      });
    }

    return {
      content: result.content,
      // DRAFT, not GENERATED: nothing was generated, the approved template text
      // was filled in. Both are submittable, so the workflow is unaffected.
      status: GeneratedDocumentStatus.DRAFT,
      unresolved: result.unresolved,
    };
  }

  private async buildWithAi(
    dto: CreateDocumentDto,
    templateName: string,
    promptVariables: Record<string, string>,
    user: AuthenticatedUser,
  ): Promise<BuiltBody> {
    const companyId = user.companyId!;

    // Metered separately from DOCUMENTS_GENERATED, which the route guard
    // already reserved. An AI draft consumes both: one document from the
    // allowance, and one call with a real vendor cost attached.
    const decision = await this.usage.reserve(
      companyId,
      UsageMetric.AI_GENERATIONS,
    );
    if (!decision.allowed) {
      throw quotaRefusal(UsageMetric.AI_GENERATIONS, decision);
    }

    try {
      const { document } = await this.aiEngine.generateLegalDocument({
        locale: (dto.locale ?? 'uz-Latn') as LegalLocale,
        documentType: templateName,
        variables: promptVariables,
        instructions: dto.instructions,
        companyId,
        userId: user.id,
      });

      return {
        content: draftToContent(document),
        status: GeneratedDocumentStatus.GENERATED,
        aiSummary: draftToSummary(document),
        unresolved: document.missingFields,
      };
    } catch (error) {
      // A provider outage must not cost the customer a generation. The route's
      // own reservation is released by QuotaRefundInterceptor when the handler
      // throws; this one is ours to hand back.
      if (decision.reservation) {
        await this.usage.release(decision.reservation);
      }
      this.logger.warn(
        `AI draft failed for company ${companyId}: ${
          (error as Error)?.message ?? 'unknown error'
        }`,
      );
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Reads the variable contract off a published version.
   *
   * `parseVariableSchema` throws a bare `VariableSchemaError`, which would leave
   * this endpoint returning a 500 with an internal error string. The schema was
   * already validated when the draft was written and again at publish, so
   * reaching here means the row was written by a different release — a broken
   * template, which the caller can actually act on by republishing it.
   */
  private parseSchemaOrThrow(raw: unknown) {
    try {
      return parseVariableSchema(raw);
    } catch (error) {
      if (error instanceof VariableSchemaError) {
        this.logger.error(
          `Published template version has an unreadable variable schema: ${error.issues
            .map((issue) => `${issue.path}: ${issue.message}`)
            .join('; ')}`,
        );
        throw new UnprocessableEntityException({
          message:
            'This template’s variable schema is not readable; republish the template before generating from it.',
          issues: error.issues,
        });
      }
      throw error;
    }
  }

  /**
   * Pre-fills declared variables from the company profile.
   *
   * Only keys the schema declares are merged in — `validateVariableValues`
   * rejects undeclared keys, so passing the whole company profile through would
   * turn every generation into a wall of "Unknown variable" errors.
   *
   * Caller-supplied values win. The profile is a default, and a contract signed
   * under a former address is exactly the case the override exists for.
   */
  private async mergeWithCompanyDefaults(
    declaredKeys: string[],
    supplied: Record<string, unknown>,
    companyId: string,
  ): Promise<Record<string, unknown>> {
    const { variables } = await this.companies.getPromptVariables(
      companyId,
      companyId,
    );

    const declared = new Set(declaredKeys);
    const merged: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(variables)) {
      if (declared.has(key)) merged[key] = value;
    }

    // Assigned wholesale rather than filtered, so an undeclared key the caller
    // sent still reaches validation and is reported back to them.
    return Object.assign(merged, supplied);
  }

  private async persist(input: {
    companyId: string;
    templateId: string;
    templateVersionId: string;
    createdById: string;
    title: string;
    body: BuiltBody;
    promptVariables: Record<string, unknown>;
  }) {
    return this.prisma.client.$transaction(async (tx) => {
      const document = await tx.generatedDocument.create({
        data: {
          companyId: input.companyId,
          templateId: input.templateId,
          // Pinned to the version, not just the template. The template will be
          // revised; this document must stay reproducible from the exact text
          // it was built from.
          templateVersionId: input.templateVersionId,
          createdById: input.createdById,
          title: input.title,
          content: input.body.content as unknown as Prisma.InputJsonValue,
          status: input.body.status,
          promptVariables: input.promptVariables as Prisma.InputJsonValue,
          aiSummary: input.body.aiSummary,
          generatedAt: new Date(),
        },
        select: {
          id: true,
          title: true,
          status: true,
          content: true,
          promptVariables: true,
          aiSummary: true,
          templateId: true,
          templateVersionId: true,
          createdById: true,
          approvalRound: true,
          generatedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      await tx.auditLog.create({
        data: {
          companyId: input.companyId,
          userId: input.createdById,
          action: AuditAction.CREATE,
          entityType: 'GeneratedDocument',
          entityId: document.id,
          metadata: {
            templateId: input.templateId,
            templateVersionId: input.templateVersionId,
            status: input.body.status,
          },
        },
      });

      return document;
    });
  }
}
