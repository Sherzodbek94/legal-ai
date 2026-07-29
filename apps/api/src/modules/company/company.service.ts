import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class CompanyService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.client.organization.findMany();
  }

  findOne(id: string) {
    return this.prisma.client.organization.findUnique({ where: { id } });
  }
}
