import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@legaltech/database';
import { PrismaService } from '../../prisma/prisma.service';
import type { CreateCompanyDto, UpdateCompanyDto } from './dto/company.dto';
import {
  findMissingContractVariables,
  mapCompanyToVariables,
  type CompanyVariables,
} from './utils/map-company-to-variables';

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

  private async getOrThrow(id: string) {
    const company = await this.findOne(id);
    if (!company) {
      throw new NotFoundException('Company not found');
    }
    return company;
  }

  async create(dto: CreateCompanyDto) {
    try {
      return await this.prisma.client.company.create({ data: dto });
    } catch (error) {
      throw this.translateUniqueViolation(error);
    }
  }

  async update(id: string, dto: UpdateCompanyDto) {
    await this.getOrThrow(id);
    try {
      return await this.prisma.client.company.update({
        where: { id },
        data: dto,
      });
    } catch (error) {
      throw this.translateUniqueViolation(error);
    }
  }

  async softDelete(id: string) {
    await this.getOrThrow(id);
    await this.prisma.client.company.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  /**
   * Prompt variables for this company, plus any required fields still missing.
   *
   * Returning the gaps alongside the variables lets a caller refuse to spend a
   * generation call on a profile that would produce an incomplete contract.
   */
  async getPromptVariables(id: string): Promise<{
    variables: CompanyVariables;
    missingRequired: string[];
  }> {
    const company = await this.getOrThrow(id);
    const variables = mapCompanyToVariables(company);
    return {
      variables,
      missingRequired: findMissingContractVariables(variables),
    };
  }

  /**
   * `slug` and `stir` are both unique. Prisma reports these as P2002; surfacing
   * which field collided is safe here because both are business identifiers the
   * caller already supplied.
   */
  private translateUniqueViolation(error: unknown): unknown {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      const target = (error.meta?.target as string[] | undefined)?.join(', ');
      return new ConflictException(
        target
          ? `A company with that ${target} already exists`
          : 'A company with those details already exists',
      );
    }
    return error;
  }
}
