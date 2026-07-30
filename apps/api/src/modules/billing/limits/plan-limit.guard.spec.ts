import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SubscriptionPlan, UsageMetric, UserRole } from '@legaltech/database';
import { PlanLimitGuard, QUOTA_RESERVATION } from './plan-limit.guard';
import { QUOTA_KEY, FEATURE_KEY } from './plan-limit.decorator';
import type { UsageService } from './usage.service';

/**
 * Exercises the guard's decision-making against a stubbed UsageService.
 *
 * The database work it delegates to is covered by quota-policy.spec; what
 * matters here is the wiring: that an undecorated route is never metered, that
 * a refusal carries what a client needs to render an upgrade prompt, and — the
 * part that silently over-bills when wrong — that a successful reservation is
 * left on the request for the refund interceptor to find.
 */

const request = (user?: Record<string, unknown>) => ({ user }) as never;

function makeContext(req: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
  } as unknown as ExecutionContext;
}

function makeGuard(
  metadata: { quota?: unknown; feature?: unknown },
  usage: Partial<UsageService> = {},
) {
  const reflector = {
    getAllAndOverride: (key: string) =>
      key === QUOTA_KEY
        ? metadata.quota
        : key === FEATURE_KEY
          ? metadata.feature
          : undefined,
  } as unknown as Reflector;

  const usageService = {
    reserve: jest.fn().mockResolvedValue({ allowed: true }),
    getSubscription: jest.fn().mockResolvedValue(null),
    release: jest.fn(),
    ...usage,
  } as unknown as UsageService;

  return { guard: new PlanLimitGuard(reflector, usageService), usageService };
}

const OWNER = {
  id: 'u1',
  email: 'a@b.test',
  role: UserRole.USER,
  companyId: 'co_1',
  companyRole: 'OWNER',
};

describe('PlanLimitGuard', () => {
  describe('routes that are not metered', () => {
    it('passes through when neither decorator is present', async () => {
      const { guard, usageService } = makeGuard({});
      const context = makeContext(request(OWNER));

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(usageService.reserve).not.toHaveBeenCalled();
    });

    it('does not even require a company context', async () => {
      const { guard } = makeGuard({});
      await expect(guard.canActivate(makeContext(request()))).resolves.toBe(true);
    });
  });

  describe('tenant context', () => {
    it('refuses a metered route with no company on the principal', async () => {
      const { guard } = makeGuard({
        quota: { metric: UsageMetric.AI_GENERATIONS, amount: 1 },
      });

      await expect(
        guard.canActivate(makeContext(request({ id: 'u1', role: UserRole.USER }))),
      ).rejects.toThrow(ForbiddenException);
    });

    it('does not meter a platform SUPER_ADMIN against a tenant allowance', async () => {
      const { guard, usageService } = makeGuard({
        quota: { metric: UsageMetric.AI_GENERATIONS, amount: 1 },
      });

      const context = makeContext(
        request({ ...OWNER, role: UserRole.SUPER_ADMIN }),
      );

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(usageService.reserve).not.toHaveBeenCalled();
    });
  });

  describe('quota enforcement', () => {
    it('reserves the declared metric and amount', async () => {
      const { guard, usageService } = makeGuard({
        quota: { metric: UsageMetric.DOCUMENTS_GENERATED, amount: 3 },
      });

      await guard.canActivate(makeContext(request(OWNER)));

      expect(usageService.reserve).toHaveBeenCalledWith(
        'co_1',
        UsageMetric.DOCUMENTS_GENERATED,
        3,
      );
    });

    it('blocks when the quota is exhausted', async () => {
      const { guard } = makeGuard(
        { quota: { metric: UsageMetric.AI_GENERATIONS, amount: 1 } },
        {
          reserve: jest.fn().mockResolvedValue({
            allowed: false,
            reason: 'QUOTA_EXCEEDED',
            message: 'You have used all 5 of this period’s allowance.',
            limit: 5,
            used: 5,
            remaining: 0,
          }),
        },
      );

      await expect(
        guard.canActivate(makeContext(request(OWNER))),
      ).rejects.toThrow(ForbiddenException);
    });

    it('returns the numbers a client needs to render an upgrade prompt', async () => {
      const { guard } = makeGuard(
        { quota: { metric: UsageMetric.AI_GENERATIONS, amount: 1 } },
        {
          reserve: jest.fn().mockResolvedValue({
            allowed: false,
            reason: 'QUOTA_EXCEEDED',
            message: 'Limit reached',
            limit: 5,
            used: 5,
            remaining: 0,
          }),
        },
      );

      await expect(
        guard.canActivate(makeContext(request(OWNER))),
      ).rejects.toMatchObject({
        response: {
          reason: 'QUOTA_EXCEEDED',
          metric: UsageMetric.AI_GENERATIONS,
          limit: 5,
          used: 5,
          remaining: 0,
        },
      });
    });

    it('blocks an unpaid subscription before it looks at any quota', async () => {
      const { guard } = makeGuard(
        { quota: { metric: UsageMetric.AI_GENERATIONS, amount: 1 } },
        {
          reserve: jest.fn().mockResolvedValue({
            allowed: false,
            reason: 'SUBSCRIPTION_UNPAID',
            message: 'Payment failed.',
            limit: 100,
            used: 0,
            remaining: 0,
          }),
        },
      );

      await expect(
        guard.canActivate(makeContext(request(OWNER))),
      ).rejects.toMatchObject({
        response: { reason: 'SUBSCRIPTION_UNPAID' },
      });
    });

    it('leaves the reservation on the request so it can be refunded', async () => {
      const reservation = {
        companyId: 'co_1',
        metric: UsageMetric.AI_GENERATIONS,
        periodStart: new Date('2026-07-01T00:00:00Z'),
        amount: 1,
      };

      const { guard } = makeGuard(
        { quota: { metric: UsageMetric.AI_GENERATIONS, amount: 1 } },
        { reserve: jest.fn().mockResolvedValue({ allowed: true, reservation }) },
      );

      const req = request(OWNER) as Record<symbol, unknown>;
      await guard.canActivate(makeContext(req));

      expect(req[QUOTA_RESERVATION]).toEqual(reservation);
    });

    it('leaves nothing to refund for an unmetered plan', async () => {
      const { guard } = makeGuard(
        { quota: { metric: UsageMetric.AI_GENERATIONS, amount: 1 } },
        // Enterprise: allowed, but no counter was written.
        { reserve: jest.fn().mockResolvedValue({ allowed: true }) },
      );

      const req = request(OWNER) as Record<symbol, unknown>;
      await guard.canActivate(makeContext(req));

      expect(req[QUOTA_RESERVATION]).toBeUndefined();
    });
  });

  describe('feature gating', () => {
    it('allows a plan that includes the feature', async () => {
      const { guard } = makeGuard(
        { feature: 'apiAccess' },
        {
          getSubscription: jest
            .fn()
            .mockResolvedValue({ plan: SubscriptionPlan.BUSINESS }),
        },
      );

      await expect(
        guard.canActivate(makeContext(request(OWNER))),
      ).resolves.toBe(true);
    });

    it('blocks a plan that does not, and says which feature', async () => {
      const { guard } = makeGuard(
        { feature: 'apiAccess' },
        {
          getSubscription: jest
            .fn()
            .mockResolvedValue({ plan: SubscriptionPlan.PRO }),
        },
      );

      await expect(
        guard.canActivate(makeContext(request(OWNER))),
      ).rejects.toMatchObject({
        response: {
          reason: 'FEATURE_NOT_IN_PLAN',
          feature: 'apiAccess',
          plan: SubscriptionPlan.PRO,
        },
      });
    });

    it('treats a company with no subscription as Free for feature checks', async () => {
      const { guard } = makeGuard(
        { feature: 'approvalWorkflows' },
        { getSubscription: jest.fn().mockResolvedValue(null) },
      );

      await expect(
        guard.canActivate(makeContext(request(OWNER))),
      ).rejects.toMatchObject({ response: { plan: SubscriptionPlan.FREE } });
    });

    it('checks the feature before spending quota on a call it will refuse', async () => {
      const reserve = jest.fn().mockResolvedValue({ allowed: true });
      const { guard } = makeGuard(
        {
          feature: 'apiAccess',
          quota: { metric: UsageMetric.AI_GENERATIONS, amount: 1 },
        },
        {
          reserve,
          getSubscription: jest
            .fn()
            .mockResolvedValue({ plan: SubscriptionPlan.FREE }),
        },
      );

      await expect(
        guard.canActivate(makeContext(request(OWNER))),
      ).rejects.toThrow(ForbiddenException);
      expect(reserve).not.toHaveBeenCalled();
    });
  });
});
