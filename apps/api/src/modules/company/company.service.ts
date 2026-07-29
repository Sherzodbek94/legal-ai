import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class CompanyService {
  constructor(private readonly prisma: PrismaService) {}

  /** Soft-deleted companies are excluded from every read path. */
  findAll() {
    return this.prisma.client.company.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  findOne(id: string) {
    return this.prisma.client.company.findFirst({
      where: { id, deletedAt: null },
    });
  }
}
