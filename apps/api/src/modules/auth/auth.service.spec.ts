import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { TokenService } from './services/token.service';

/**
 * `loginWithVerifiedIdentity` — OneID subject binding.
 *
 * Regression coverage for a real gap: the method used to upsert purely by
 * email, so a OneID profile sharing an email with an existing account (a
 * shared family address, a stale email on a password-based account) would
 * log the caller into that account with no proof they are the same person.
 */
describe('AuthService.loginWithVerifiedIdentity', () => {
  function makeService(userRow: Record<string, unknown> | null) {
    const findUnique = jest.fn().mockResolvedValue(userRow);
    const upsert = jest.fn().mockResolvedValue({
      id: 'u1',
      email: 'citizen@example.uz',
      role: 'USER',
      memberships: [],
    });

    const prisma = {
      client: { user: { findUnique, upsert } },
    } as unknown as PrismaService;

    const tokens = {
      issueTokens: jest.fn().mockResolvedValue({ accessToken: 'a', refreshToken: 'r' }),
    } as unknown as TokenService;

    return { service: new AuthService(prisma, tokens), findUnique, upsert, tokens };
  }

  it('provisions a new account and binds the OneID subject', async () => {
    const { service, upsert } = makeService(null);

    await service.loginWithVerifiedIdentity('citizen@example.uz', 'oneid-subject-1', {
      name: 'Aziz Karimov',
    });

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ oneIdSubject: 'oneid-subject-1' }),
        update: expect.objectContaining({ oneIdSubject: 'oneid-subject-1' }),
      }),
    );
  });

  it('logs back in when the subject matches the previously bound one', async () => {
    const { service, upsert } = makeService({
      id: 'u1',
      oneIdSubject: 'oneid-subject-1',
    });

    await service.loginWithVerifiedIdentity('citizen@example.uz', 'oneid-subject-1', {});

    expect(upsert).toHaveBeenCalled();
  });

  it('refuses a different OneID subject sharing a previously bound email', async () => {
    const { service, upsert } = makeService({
      id: 'u1',
      oneIdSubject: 'oneid-subject-1',
    });

    await expect(
      service.loginWithVerifiedIdentity('citizen@example.uz', 'oneid-subject-2', {}),
    ).rejects.toThrow(UnauthorizedException);

    expect(upsert).not.toHaveBeenCalled();
  });

  it('refuses to annex a pre-existing account that has never signed in with OneID', async () => {
    const { service, upsert } = makeService({
      id: 'u1',
      oneIdSubject: null,
    });

    await expect(
      service.loginWithVerifiedIdentity('citizen@example.uz', 'oneid-subject-1', {}),
    ).rejects.toThrow(UnauthorizedException);

    expect(upsert).not.toHaveBeenCalled();
  });
});
