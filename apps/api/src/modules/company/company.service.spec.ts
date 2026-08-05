import { ConflictException } from '@nestjs/common';
import { CompanyMemberRole, Prisma } from '@legaltech/database';
import { CompanyService } from './company.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { CreateCompanyDto } from './dto/company.dto';

/**
 * `registerAsOwner` — the only path that can ever create a user's first
 * company.
 *
 * `POST /companies` requires `@Roles('OWNER', 'ADMIN')`, a role only an
 * existing member can hold, and `create()` never wrote a `CompanyMember`
 * row even for a caller who somehow had one — so no user, registered by
 * password or by OneID, could ever become the owner of anything. This
 * exercises that the new path actually closes that gap: both rows commit
 * together, and a second attempt by an already-affiliated user is refused
 * rather than quietly handing them a second company.
 */
describe('CompanyService.registerAsOwner', () => {
  const DTO: CreateCompanyDto = {
    name: 'Acme Legal',
    slug: 'acme-legal',
  } as CreateCompanyDto;

  function build(existingMembership: unknown = null) {
    const created: { company: Record<string, unknown>[]; member: Record<string, unknown>[] } = {
      company: [],
      member: [],
    };

    const tx = {
      company: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: 'co_1', ...data };
          created.company.push(row);
          return row;
        }),
      },
      companyMember: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          created.member.push(data);
          return { id: 'mem_1', ...data };
        }),
      },
    };

    const prisma = {
      client: {
        companyMember: {
          findFirst: jest.fn(async () => existingMembership),
        },
        $transaction: jest.fn(async (work: (t: typeof tx) => unknown) => work(tx)),
      },
    } as unknown as PrismaService;

    return { service: new CompanyService(prisma), tx, created, prisma };
  }

  it('creates the company and an OWNER membership for the caller, together', async () => {
    const built = build();

    const company = await built.service.registerAsOwner('user_1', DTO);

    expect(company.id).toBe('co_1');
    expect(built.created.member).toEqual([
      expect.objectContaining({
        companyId: 'co_1',
        userId: 'user_1',
        role: CompanyMemberRole.OWNER,
      }),
    ]);
    expect(built.created.member[0].joinedAt).toBeInstanceOf(Date);
  });

  it('refuses a user who already belongs to a company', async () => {
    const built = build({ id: 'existing_membership' });

    await expect(built.service.registerAsOwner('user_1', DTO)).rejects.toThrow(
      ConflictException,
    );

    expect(built.tx.company.create).not.toHaveBeenCalled();
    expect(built.tx.companyMember.create).not.toHaveBeenCalled();
  });

  it('translates a duplicate slug into a clear conflict rather than a raw Prisma error', async () => {
    const built = build();
    const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: '5.22.0',
      meta: { target: ['slug'] },
    });
    built.tx.company.create.mockRejectedValueOnce(p2002);

    await expect(built.service.registerAsOwner('user_1', DTO)).rejects.toThrow(ConflictException);
  });
});
