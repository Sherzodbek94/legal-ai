import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class DocumentService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Documents are tenant-scoped; `companyId` narrows to a single tenant and
   * soft-deleted rows are excluded from every read path.
   */
  findAll(companyId?: string) {
    return this.prisma.client.generatedDocument.findMany({
      where: { deletedAt: null, ...(companyId ? { companyId } : {}) },
      orderBy: { createdAt: 'desc' },
    });
  }

  findOne(id: string) {
    return this.prisma.client.generatedDocument.findFirst({
      where: { id, deletedAt: null },
    });
  }
}
