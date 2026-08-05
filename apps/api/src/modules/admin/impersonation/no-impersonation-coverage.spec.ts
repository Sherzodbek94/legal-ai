import { PaymentController } from '../../payment/payment.controller';
import { BillingController } from '../../billing/billing.controller';
import { NO_IMPERSONATION_KEY } from './no-impersonation.decorator';

/**
 * Every route that moves money must carry @NoImpersonation.
 *
 * `PaymentController.cancel` shipped once without it: `create()` was decorated
 * and `cancel()` was added later next to it, silently, without the same
 * metadata — an operator impersonating a customer could cancel their pending
 * payment order. RolesGuard and ImpersonationGuard both passed every unit test
 * for the routes they *did* know about; nothing failed when a new mutating
 * route simply forgot the decorator. This test enumerates the money-moving
 * handlers explicitly so a forgotten decorator fails CI instead of shipping.
 */
describe('money-moving routes carry @NoImpersonation', () => {
  const moneyRoutes: Array<{
    name: string;
    controller: new (...args: never[]) => unknown;
    handler: string;
    capability: string;
  }> = [
    { name: 'PaymentController.create', controller: PaymentController, handler: 'create', capability: 'payment:write' },
    { name: 'PaymentController.cancel', controller: PaymentController, handler: 'cancel', capability: 'payment:write' },
    { name: 'BillingController.changePlan', controller: BillingController, handler: 'changePlan', capability: 'billing:write' },
    { name: 'BillingController.cancel', controller: BillingController, handler: 'cancel', capability: 'billing:write' },
    { name: 'BillingController.resume', controller: BillingController, handler: 'resume', capability: 'billing:write' },
    { name: 'BillingController.applyCoupon', controller: BillingController, handler: 'applyCoupon', capability: 'billing:write' },
  ];

  it.each(moneyRoutes)('$name is unreachable while impersonating', ({ controller, handler, capability }) => {
    const method = (controller.prototype as Record<string, object>)[handler];
    const metadata = Reflect.getMetadata(NO_IMPERSONATION_KEY, method);
    expect(metadata).toBe(capability);
  });
});
