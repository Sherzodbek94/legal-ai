import { UserRole } from '@legaltech/database';
import {
  IMPERSONATION_DENIED_CAPABILITIES,
  IMPERSONATION_TTL_MS,
  canImpersonate,
  expiresAtFrom,
  remainingSeconds,
  type Actor,
  type Target,
} from './impersonation-policy';

const REASON = 'Investigating a reported PDF export failure on ticket #4412';

const actor = (overrides: Partial<Actor> = {}): Actor => ({
  id: 'admin_1',
  role: UserRole.SUPER_ADMIN,
  isImpersonating: false,
  ...overrides,
});

const target = (overrides: Partial<Target> = {}): Target => ({
  id: 'user_1',
  role: UserRole.USER,
  deletedAt: null,
  lockedAt: null,
  ...overrides,
});

describe('canImpersonate', () => {
  it('permits a platform administrator with a stated reason', () => {
    expect(canImpersonate(actor(), target(), REASON)).toEqual({ allowed: true });
  });

  describe('who may act', () => {
    it('refuses an ordinary user outright', () => {
      const decision = canImpersonate(
        actor({ role: UserRole.USER }),
        target(),
        REASON,
      );
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('NOT_SUPER_ADMIN');
    });

    it('checks the actor before looking at the target', () => {
      // A caller with no business here learns nothing about the target account.
      const decision = canImpersonate(
        actor({ role: UserRole.USER }),
        target({ deletedAt: new Date(), lockedAt: new Date() }),
        '',
      );
      expect(decision.reason).toBe('NOT_SUPER_ADMIN');
    });

    it('refuses nesting one impersonation inside another', () => {
      // Chained impersonation makes "who actually acted" ambiguous, which is
      // the natural way to launder an action through two accounts.
      const decision = canImpersonate(
        actor({ isImpersonating: true }),
        target(),
        REASON,
      );
      expect(decision.reason).toBe('ALREADY_IMPERSONATING');
    });

    it('refuses impersonating yourself', () => {
      const decision = canImpersonate(
        actor({ id: 'same' }),
        target({ id: 'same' }),
        REASON,
      );
      expect(decision.reason).toBe('SELF_IMPERSONATION');
    });
  });

  describe('who may be acted as', () => {
    it('refuses another platform administrator', () => {
      // Lateral escalation: one operator acting with another's identity defeats
      // the point of recording an actor at all.
      const decision = canImpersonate(
        actor(),
        target({ role: UserRole.SUPER_ADMIN }),
        REASON,
      );
      expect(decision.reason).toBe('TARGET_IS_SUPER_ADMIN');
    });

    it('refuses a deleted account', () => {
      expect(
        canImpersonate(actor(), target({ deletedAt: new Date() }), REASON).reason,
      ).toBe('TARGET_INACTIVE');
    });

    it('refuses a locked account', () => {
      // Entering a suspended account would bypass the lock and contaminate
      // whatever is being investigated.
      expect(
        canImpersonate(actor(), target({ lockedAt: new Date() }), REASON).reason,
      ).toBe('TARGET_LOCKED');
    });
  });

  describe('justification', () => {
    it('requires a reason', () => {
      expect(canImpersonate(actor(), target(), '').reason).toBe('REASON_TOO_SHORT');
    });

    it('rejects a token gesture', () => {
      expect(canImpersonate(actor(), target(), 'debug').reason).toBe(
        'REASON_TOO_SHORT',
      );
    });

    it('rejects whitespace padding as a reason', () => {
      expect(canImpersonate(actor(), target(), '            ').reason).toBe(
        'REASON_TOO_SHORT',
      );
    });
  });

  describe('concurrency', () => {
    it('refuses a second simultaneous session for one operator', () => {
      // Concurrent sessions make "who was in this account at 14:32"
      // unanswerable.
      expect(canImpersonate(actor(), target(), REASON, true).reason).toBe(
        'CONCURRENT_SESSION',
      );
    });

    it('permits a new session once the previous one has ended', () => {
      expect(canImpersonate(actor(), target(), REASON, false).allowed).toBe(true);
    });
  });

  it('carries an actionable message on every refusal', () => {
    const refusals = [
      canImpersonate(actor({ role: UserRole.USER }), target(), REASON),
      canImpersonate(actor({ isImpersonating: true }), target(), REASON),
      canImpersonate(actor(), target({ role: UserRole.SUPER_ADMIN }), REASON),
      canImpersonate(actor(), target({ lockedAt: new Date() }), REASON),
      canImpersonate(actor(), target(), 'x'),
      canImpersonate(actor(), target(), REASON, true),
    ];

    for (const refusal of refusals) {
      expect(refusal.allowed).toBe(false);
      expect(refusal.message).toBeTruthy();
      expect(refusal.message).not.toMatch(/undefined|null/);
    }
  });
});

describe('session lifetime', () => {
  it('is fifteen minutes', () => {
    expect(IMPERSONATION_TTL_MS).toBe(15 * 60 * 1000);
  });

  it('computes expiry from the start instant', () => {
    const startedAt = new Date('2026-07-30T12:00:00Z');
    expect(expiresAtFrom(startedAt).toISOString()).toBe(
      '2026-07-30T12:15:00.000Z',
    );
  });

  it('counts down the remaining seconds', () => {
    const now = new Date('2026-07-30T12:05:00Z');
    const expiresAt = new Date('2026-07-30T12:15:00Z');
    expect(remainingSeconds(expiresAt, now)).toBe(600);
  });

  it('floors at zero once expired rather than going negative', () => {
    const now = new Date('2026-07-30T13:00:00Z');
    const expiresAt = new Date('2026-07-30T12:15:00Z');
    expect(remainingSeconds(expiresAt, now)).toBe(0);
  });
});

describe('denied capabilities', () => {
  it('withholds money movement, credentials, and further impersonation', () => {
    expect(IMPERSONATION_DENIED_CAPABILITIES).toEqual(
      expect.arrayContaining([
        'billing:write',
        'payment:write',
        'auth:credentials',
        'impersonation:start',
      ]),
    );
  });

  it('names each capability once', () => {
    const unique = new Set(IMPERSONATION_DENIED_CAPABILITIES);
    expect(unique.size).toBe(IMPERSONATION_DENIED_CAPABILITIES.length);
  });
});
