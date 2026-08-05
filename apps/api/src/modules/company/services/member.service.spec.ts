import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { CompanyMemberRole } from '@legaltech/database';
import { MemberService } from './member.service';
import type { PrismaService } from '../../../prisma/prisma.service';
import type { ConfigService } from '@nestjs/config';
import type { NotificationService } from '../../notification/notification.service';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';

const OWNER = {
  id: 'user_owner',
  email: 'owner@acme.uz',
  role: 'USER',
  companyId: 'co_1',
  companyRole: 'OWNER',
} as AuthenticatedUser;

/**
 * Company membership.
 *
 * This whole surface is new: before it, `CompanyMember` rows were written only
 * by the seed script and by `registerAsOwner`, so a workspace could never gain
 * a second person — and the approval chains this product is built on need two
 * by definition, since a document cannot be approved by whoever submitted it.
 */
describe('MemberService', () => {
  function build(
    overrides: {
      existingUser?: { id: string; passwordHash?: string | null } | null;
      existingMembership?: { companyId: string } | null;
      invitation?: Record<string, unknown> | null;
      member?: { id: string; userId: string; role: CompanyMemberRole } | null;
    } = {},
  ) {
    const created: Record<string, Record<string, unknown>[]> = {
      invitation: [],
      member: [],
      user: [],
      audit: [],
    };

    const tx = {
      companyInvitation: {
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
      user: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          created.user.push(data);
          return { id: 'user_new', passwordHash: 'hashed' };
        }),
      },
      companyMember: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          created.member.push(data);
          return { id: 'mem_new', ...data };
        }),
      },
      auditLog: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          created.audit.push(data);
          return data;
        }),
      },
    };

    const prisma = {
      client: {
        user: {
          findUnique: jest.fn(async () => overrides.existingUser ?? null),
        },
        companyMember: {
          findFirst: jest.fn(async () =>
            overrides.member ?? overrides.existingMembership ?? null,
          ),
          findMany: jest.fn(async () => []),
          update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
            id: 'mem_1',
            ...data,
          })),
        },
        companyInvitation: {
          create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
            created.invitation.push(data);
            return { id: 'inv_1', ...data };
          }),
          findUnique: jest.fn(async () => overrides.invitation ?? null),
          findMany: jest.fn(async () => []),
          updateMany: jest.fn(async () => ({ count: 1 })),
        },
        company: {
          findUnique: jest.fn(async () => ({ name: 'Acme Legal' })),
        },
        $transaction: jest.fn(async (work: (t: typeof tx) => unknown) => work(tx)),
      },
    } as unknown as PrismaService;

    const config = {
      get: jest.fn((_key: string, fallback?: unknown) => fallback),
    } as unknown as ConfigService;

    const notifications = {
      dispatch: jest.fn(async () => ({ notificationIds: [], delivered: [], skipped: [] })),
    } as unknown as NotificationService;

    return {
      service: new MemberService(prisma, config, notifications),
      prisma,
      tx,
      created,
      notifications,
    };
  }

  /** A live invitation, as `findLiveInvitation` expects to load it. */
  function liveInvitation(overrides: Record<string, unknown> = {}) {
    return {
      id: 'inv_1',
      companyId: 'co_1',
      email: 'new@acme.uz',
      role: CompanyMemberRole.PARALEGAL,
      acceptedAt: null,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 86_400_000),
      createdAt: new Date(),
      invitedById: 'user_owner',
      company: { id: 'co_1', name: 'Acme Legal', deletedAt: null },
      ...overrides,
    };
  }

  // ---------------------------------------------------------------------------
  // Invite
  // ---------------------------------------------------------------------------

  describe('invite', () => {
    it('stores only a hash of the emailed token', async () => {
      const built = build();

      await built.service.invite('co_1', 'New@Acme.uz', CompanyMemberRole.ATTORNEY, OWNER);

      const [row] = built.created.invitation;
      // A database disclosure must not yield a replayable invitation link.
      expect(row.tokenHash).toMatch(/^[a-f0-9]{64}$/);
      expect(row).not.toHaveProperty('token');
    });

    it('normalises the address so casing cannot create a duplicate invite', async () => {
      const built = build();

      await built.service.invite('co_1', '  New@ACME.uz ', CompanyMemberRole.ATTORNEY, OWNER);

      expect(built.created.invitation[0].email).toBe('new@acme.uz');
    });

    it('refuses to grant ownership by invitation', async () => {
      const built = build();

      await expect(
        built.service.invite('co_1', 'new@acme.uz', CompanyMemberRole.OWNER, OWNER),
      ).rejects.toThrow(BadRequestException);

      expect(built.created.invitation).toHaveLength(0);
    });

    it('refuses someone who already belongs to this company', async () => {
      const built = build({
        existingUser: { id: 'user_2' },
        existingMembership: { companyId: 'co_1' },
      });

      await expect(
        built.service.invite('co_1', 'taken@acme.uz', CompanyMemberRole.ATTORNEY, OWNER),
      ).rejects.toThrow(ConflictException);
    });

    it('refuses someone who belongs to a different company', async () => {
      const built = build({
        existingUser: { id: 'user_2' },
        existingMembership: { companyId: 'co_OTHER' },
      });

      await expect(
        built.service.invite('co_1', 'elsewhere@acme.uz', CompanyMemberRole.ATTORNEY, OWNER),
      ).rejects.toThrow(ConflictException);
    });

    it('still returns the invitation when notifying the inviter fails', async () => {
      const built = build();
      (built.notifications.dispatch as jest.Mock).mockRejectedValueOnce(
        new Error('SMTP down'),
      );

      // An invitation that was created but not delivered is recoverable — the
      // link is on the members list. Losing the row would not be.
      await expect(
        built.service.invite('co_1', 'new@acme.uz', CompanyMemberRole.ATTORNEY, OWNER),
      ).resolves.toMatchObject({ id: 'inv_1' });
    });
  });

  // ---------------------------------------------------------------------------
  // Accept
  // ---------------------------------------------------------------------------

  describe('acceptInvitation', () => {
    it('creates the account and the membership together', async () => {
      const built = build({ invitation: liveInvitation(), existingUser: null });

      const result = await built.service.acceptInvitation(
        'a-token',
        'a-long-enough-password',
        'Nilufar',
      );

      expect(result).toMatchObject({ companyId: 'co_1', role: CompanyMemberRole.PARALEGAL });
      expect(built.created.user).toHaveLength(1);
      expect(built.created.member[0]).toMatchObject({
        companyId: 'co_1',
        role: CompanyMemberRole.PARALEGAL,
      });
      // Receiving the token proves the address.
      expect(built.created.user[0].emailVerified).toBeInstanceOf(Date);
    });

    it('never stores the password in clear', async () => {
      const built = build({ invitation: liveInvitation(), existingUser: null });

      await built.service.acceptInvitation('a-token', 'a-long-enough-password', undefined);

      expect(built.created.user[0].passwordHash).not.toBe('a-long-enough-password');
      expect(built.created.user[0].passwordHash).toMatch(/^\$2[aby]\$/);
    });

    it('adds an existing account without creating a second user', async () => {
      const built = build({
        invitation: liveInvitation(),
        existingUser: { id: 'user_2', passwordHash: 'already-set' },
      });

      await built.service.acceptInvitation('a-token', undefined, undefined);

      expect(built.created.user).toHaveLength(0);
      expect(built.created.member[0]).toMatchObject({ userId: 'user_2' });
    });

    it('requires a password when the address has no account', async () => {
      const built = build({ invitation: liveInvitation(), existingUser: null });

      await expect(
        built.service.acceptInvitation('a-token', 'short', undefined),
      ).rejects.toThrow(BadRequestException);
    });

    it('records the acceptance in the audit log', async () => {
      const built = build({ invitation: liveInvitation(), existingUser: null });

      await built.service.acceptInvitation('a-token', 'a-long-enough-password', undefined);

      expect(built.created.audit[0]).toMatchObject({
        companyId: 'co_1',
        entityType: 'CompanyMember',
      });
    });

    it('is single-use — a second click finds nothing to claim', async () => {
      const built = build({ invitation: liveInvitation(), existingUser: null });
      built.tx.companyInvitation.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(
        built.service.acceptInvitation('a-token', 'a-long-enough-password', undefined),
      ).rejects.toThrow(NotFoundException);

      expect(built.created.member).toHaveLength(0);
    });

    it.each([
      ['expired', { expiresAt: new Date(Date.now() - 1000) }],
      ['already accepted', { acceptedAt: new Date() }],
      ['withdrawn', { revokedAt: new Date() }],
      ['company deleted', { company: { id: 'co_1', name: 'X', deletedAt: new Date() } }],
    ])('refuses an invitation that is %s', async (_label, overrides) => {
      const built = build({ invitation: liveInvitation(overrides), existingUser: null });

      // Uniform 404 across all of these: distinguishing them would tell a
      // guesser which tokens once existed.
      await expect(
        built.service.acceptInvitation('a-token', 'a-long-enough-password', undefined),
      ).rejects.toThrow(NotFoundException);
    });

    it('refuses an unknown token', async () => {
      const built = build({ invitation: null });

      await expect(
        built.service.acceptInvitation('nope', 'a-long-enough-password', undefined),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ---------------------------------------------------------------------------
  // Manage
  // ---------------------------------------------------------------------------

  describe('changeRole and remove', () => {
    it('refuses to change your own role', async () => {
      const built = build({
        member: { id: 'mem_1', userId: OWNER.id, role: CompanyMemberRole.OWNER },
      });

      // Otherwise the only owner can demote themselves and lock the company
      // out of its own billing and member management.
      await expect(
        built.service.changeRole('co_1', 'mem_1', CompanyMemberRole.VIEWER, OWNER),
      ).rejects.toThrow(ForbiddenException);
    });

    it('refuses to promote anyone to owner', async () => {
      const built = build({
        member: { id: 'mem_2', userId: 'user_2', role: CompanyMemberRole.ATTORNEY },
      });

      await expect(
        built.service.changeRole('co_1', 'mem_2', CompanyMemberRole.OWNER, OWNER),
      ).rejects.toThrow(BadRequestException);
    });

    it('changes an ordinary member’s role', async () => {
      const built = build({
        member: { id: 'mem_2', userId: 'user_2', role: CompanyMemberRole.PARALEGAL },
      });

      await expect(
        built.service.changeRole('co_1', 'mem_2', CompanyMemberRole.ATTORNEY, OWNER),
      ).resolves.toMatchObject({ role: CompanyMemberRole.ATTORNEY });
    });

    it('refuses to remove yourself', async () => {
      const built = build({
        member: { id: 'mem_1', userId: OWNER.id, role: CompanyMemberRole.OWNER },
      });

      await expect(built.service.remove('co_1', 'mem_1', OWNER)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('refuses to remove the owner', async () => {
      const built = build({
        member: { id: 'mem_2', userId: 'user_other', role: CompanyMemberRole.OWNER },
      });

      await expect(built.service.remove('co_1', 'mem_2', OWNER)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('soft-deletes rather than dropping the row', async () => {
      const built = build({
        member: { id: 'mem_2', userId: 'user_2', role: CompanyMemberRole.ATTORNEY },
      });

      await built.service.remove('co_1', 'mem_2', OWNER);

      // Their documents, approvals, and audit entries all reference this user
      // and must stay readable after they leave.
      const update = (built.prisma.client.companyMember.update as jest.Mock).mock.calls[0][0];
      expect(update.data.deletedAt).toBeInstanceOf(Date);
    });

    it('refuses to act on a member of another company', async () => {
      const built = build({ member: null });

      await expect(built.service.remove('co_1', 'mem_elsewhere', OWNER)).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
