import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class DocumentService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Lists a tenant's documents.
   *
   * `companyId` is required, not optional. It was optional, and an optional
   * tenant filter is one `undefined` away from returning every document on the
   * platform — which is exactly what happened for any user whose token carried no
   * company. Requiring it makes that a compile error instead of a disclosure.
   *
   * `content` is deliberately excluded: it is the full document body as editor
   * JSON, and returning it for every row turns a list request into megabytes.
   * The detail endpoint serves it for the one document actually being opened.
   */
  findAll(companyId: string) {
    return this.prisma.client.generatedDocument.findMany({
      where: { companyId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        title: true,
        status: true,
        templateId: true,
        templateVersionId: true,
        createdById: true,
        aiSummary: true,
        failureReason: true,
        approvalRound: true,
        revision: true,
        submittedAt: true,
        completedAt: true,
        generatedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  /**
   * A single document, including its body.
   *
   * Scoped by `companyId`. Without it this was a cross-tenant read: any
   * authenticated user could fetch any company's document by id, and document ids
   * travel in URLs, audit logs, and notification payloads. Filtering in the query
   * rather than checking after the fetch means an id from another tenant simply
   * does not resolve.
   */
  async findOne(id: string, companyId: string) {
    const document = await this.prisma.client.generatedDocument.findFirst({
      where: { id, companyId, deletedAt: null },
      select: {
        id: true,
        title: true,
        status: true,
        content: true,
        promptVariables: true,
        aiSummary: true,
        failureReason: true,
        templateId: true,
        templateVersionId: true,
        createdById: true,
        approvalRound: true,
        revision: true,
        submittedAt: true,
        submittedById: true,
        completedAt: true,
        rejectionReason: true,
        generatedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!document) throw new NotFoundException('Document not found');
    return document;
  }
}
