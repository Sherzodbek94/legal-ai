import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { TokenService } from './services/token.service';

/**
 * Phone and Google sign-in.
 *
 * Both provision an account on first use, which makes the collision rules the
 * whole of the security story: an account keyed on something the provider
 * controls must never be reachable by presenting a matching *email*, because
 * addresses get reassigned and workspaces do not.
 */
describe('AuthService — phone and Google sign-in', () => {
  function build(
    rows: {
      byPhone?: Record<string, unknown> | null;
      bySubject?: { id: string } | null;
      byEmail?: { id: string; googleSubject: string | null } | null;
      upserted?: Record<string, unknown>;
    } = {},
  ) {
    const upsertArgs: Record<string, unknown>[] = [];

    const prisma = {
      client: {
        user: {
          findUnique: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
            if ('googleSubject' in where) return rows.bySubject ?? null;
            if ('email' in where) return rows.byEmail ?? null;
            return null;
          }),
          upsert: jest.fn(async (args: Record<string, unknown>) => {
            upsertArgs.push(args);
            return {
              id: 'user_1',
              email: 'someone@example.uz',
              role: 'USER',
              lockedAt: null,
              lockedReason: null,
              memberships: [],
              ...(rows.upserted ?? {}),
            };
          }),
        },
      },
    } as unknown as PrismaService;

    const tokens = {
      issueTokens: jest.fn(async () => ({ accessToken: 'a', refreshToken: 'r' })),
    } as unknown as TokenService;

    return { service: new AuthService(prisma, tokens), prisma, tokens, upsertArgs };
  }

  // ---------------------------------------------------------------------------
  // Phone
  // ---------------------------------------------------------------------------

  describe('loginWithVerifiedPhone', () => {
    it('provisions an account with no email and no password', async () => {
      const built = build({ upserted: { email: null } });

      const result = await built.service.loginWithVerifiedPhone('+998901234567');

      expect(result.hasCompany).toBe(false);
      const create = built.upsertArgs[0].create as Record<string, unknown>;
      expect(create.phone).toBe('+998901234567');
      // A null hash can never satisfy bcrypt.compare, so the password path
      // stays closed for an account that never set one.
      expect(create.passwordHash).toBeNull();
      expect(create.email).toBeNull();
      expect(create.phoneVerified).toBeInstanceOf(Date);
    });

    it('marks the number verified again on every sign-in', async () => {
      const built = build();

      await built.service.loginWithVerifiedPhone('+998901234567');

      const update = built.upsertArgs[0].update as Record<string, unknown>;
      expect(update.phoneVerified).toBeInstanceOf(Date);
      expect(update.lastLoginAt).toBeInstanceOf(Date);
    });

    it('refuses a suspended account', async () => {
      const built = build({
        upserted: { lockedAt: new Date(), lockedReason: 'abuse' },
      });

      await expect(
        built.service.loginWithVerifiedPhone('+998901234567'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('issues a session with an empty email claim rather than a fake one', async () => {
      const built = build({ upserted: { email: null } });

      await built.service.loginWithVerifiedPhone('+998901234567');

      const [payload] = (built.tokens.issueTokens as jest.Mock).mock.calls[0];
      expect(payload.email).toBeUndefined();
      expect(payload.sub).toBe('user_1');
    });
  });

  // ---------------------------------------------------------------------------
  // Google
  // ---------------------------------------------------------------------------

  describe('loginWithGoogle', () => {
    const profile = {
      subject: 'google-sub-1',
      email: 'Person@Example.uz',
      name: 'A Person',
      emailVerified: true,
    };

    it('binds the Google subject on first sign-in', async () => {
      const built = build({ bySubject: null, byEmail: null });

      await built.service.loginWithGoogle(profile);

      const create = built.upsertArgs[0].create as Record<string, unknown>;
      expect(create.googleSubject).toBe('google-sub-1');
      // Normalised: the address is a unique key and casing must not fork it.
      expect(create.email).toBe('person@example.uz');
    });

    it('refuses an unverified Google address', async () => {
      const built = build({ bySubject: null, byEmail: null });

      // Some Workspace configurations return an unverified address; treating
      // it as proof would let anyone who can create such an account claim a
      // matching one here.
      await expect(
        built.service.loginWithGoogle({ ...profile, emailVerified: false }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('refuses a different Google identity on an already-bound address', async () => {
      const built = build({
        bySubject: null,
        byEmail: { id: 'user_2', googleSubject: 'google-sub-OTHER' },
      });

      await expect(built.service.loginWithGoogle(profile)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('refuses to annex a pre-existing account that has never used Google', async () => {
      const built = build({
        bySubject: null,
        byEmail: { id: 'user_2', googleSubject: null },
      });

      await expect(built.service.loginWithGoogle(profile)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('signs a returning user in by subject, not by address', async () => {
      const built = build({ bySubject: { id: 'user_9' }, byEmail: null });

      await built.service.loginWithGoogle(profile);

      // Keyed on the row the subject resolved to — a Google account that has
      // since changed its address still reaches the same workspace.
      expect(built.upsertArgs[0].where).toEqual({ id: 'user_9' });
    });

    it('refuses a suspended account', async () => {
      const built = build({
        bySubject: { id: 'user_9' },
        upserted: { lockedAt: new Date(), lockedReason: null },
      });

      await expect(built.service.loginWithGoogle(profile)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });
});
