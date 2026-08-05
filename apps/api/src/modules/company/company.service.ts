import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CompanyMemberRole, Prisma, type Company } from '@legaltech/database';
import { PrismaService } from '../../prisma/prisma.service';
import type { CreateCompanyDto, UpdateCompanyDto } from './dto/company.dto';
import {
  findMissingContractVariables,
  mapCompanyToVariables,
  type CompanyVariables,
} from './utils/map-company-to-variables';

/**
 * Company profiles.
 *
 * Every method takes the caller's tenant and scopes to it. This service
 * previously did not: `findAll()` returned every company on the platform to any
 * authenticated user, and `findOne`/`update`/`softDelete` accepted any id — so
 * the owner of one company could read, edit, or delete another's profile, which
 * carries their banking details and registry identifiers.
 *
 * The role guard did not help. `@Roles('OWNER')` asks "is this caller an owner",
 * not "an owner of *this* company", and that distinction is the whole of
 * multi-tenant authorisation.
 */
@Injectable()
export class CompanyService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The caller's own company, as a list.
   *
   * A list of one, because the session carries a single tenant. The shape is
   * kept so the frontend does not need a special case, and so it stays correct
   * if a user is ever a member of several companies.
   */
  findAll(companyId: string) {
    return this.prisma.client.company.findMany({
      where: { id: companyId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  findOne(id: string, companyId: string) {
    // An id from another tenant simply does not resolve. Filtering in the query
    // rather than comparing after the fetch means there is no window where the
    // row exists in memory.
    return this.prisma.client.company.findFirst({
      where: { id, deletedAt: null, ...scopeTo(companyId, id) },
    });
  }

  private async getOrThrow(id: string, companyId: string) {
    const company = await this.findOne(id, companyId);
    if (!company) {
      // 404 rather than 403: a 403 would confirm the company exists, which is
      // itself information a stranger should not get.
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

  /**
   * Creates a user's first company and makes them its owner.
   *
   * This is the one gap that made registration a dead end: `POST /companies`
   * requires `@Roles('OWNER', 'ADMIN')`, which only an *existing* member can
   * hold, and even a caller who somehow got past that guard would find that
   * `create()` above never writes a `CompanyMember` row. A brand-new user —
   * whether from `/auth/register` or a first OneID login — had no path to
   * ever become the owner of anything. This is that path: no role
   * requirement (there is nothing to require a role of yet), and both rows
   * are written together so the company never exists without its owner.
   *
   * Refuses outright if the caller already belongs to a company. One person,
   * one company is the whole of this product's tenancy model — see the
   * `findAll` comment above — and silently creating a second one would leave
   * the caller with two active memberships that nothing else expects.
   */
  async registerAsOwner(userId: string, dto: CreateCompanyDto): Promise<Company> {
    const existing = await this.prisma.client.companyMember.findFirst({
      where: { userId, deletedAt: null },
      select: { id: true },
    });

    if (existing) {
      throw new ConflictException('This account already belongs to a company');
    }

    try {
      return await this.prisma.client.$transaction(async (tx) => {
        const company = await tx.company.create({ data: dto });

        await tx.companyMember.create({
          data: {
            companyId: company.id,
            userId,
            role: CompanyMemberRole.OWNER,
            joinedAt: new Date(),
          },
        });

        return company;
      });
    } catch (error) {
      throw this.translateUniqueViolation(error);
    }
  }

  async update(id: string, dto: UpdateCompanyDto, companyId: string) {
    await this.getOrThrow(id, companyId);
    try {
      return await this.prisma.client.company.update({
        where: { id },
        data: dto,
      });
    } catch (error) {
      throw this.translateUniqueViolation(error);
    }
  }

  async softDelete(id: string, companyId: string) {
    await this.getOrThrow(id, companyId);
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
  async getPromptVariables(
    id: string,
    companyId: string,
  ): Promise<{
    variables: CompanyVariables;
    missingRequired: string[];
  }> {
    const company = await this.getOrThrow(id, companyId);
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

/**
 * Restricts a lookup to the caller's tenant.
 *
 * Returns an unsatisfiable predicate when the requested id is not the caller's
 * company, so the query returns nothing rather than the caller's own row under
 * someone else's id.
 */
function scopeTo(companyId: string, requestedId: string): Prisma.CompanyWhereInput {
  return requestedId === companyId ? {} : { id: '__no_match__' };
}
