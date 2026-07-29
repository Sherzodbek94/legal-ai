import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class DocumentService {
  constructor(private readonly prisma: PrismaService) {}

  findAll(matterId?: string) {
    return this.prisma.client.document.findMany({
      where: matterId ? { matterId } : undefined,
    });
  }

  findOne(id: string) {
    return this.prisma.client.document.findUnique({ where: { id } });
  }
}
