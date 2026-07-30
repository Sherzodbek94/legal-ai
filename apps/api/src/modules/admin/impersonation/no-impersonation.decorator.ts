import { SetMetadata } from '@nestjs/common';
import type { DeniedCapability } from './impersonation-policy';

export const NO_IMPERSONATION_KEY = 'admin:no-impersonation';

/**
 * Marks a route as unreachable while impersonating.
 *
 * Applied to anything that moves money, changes who can sign in, or cannot be
 * undone. A support engineer reproducing a customer's problem has no business
 * cancelling their subscription or resetting their password, however good the
 * intention — and the customer has no way to tell afterwards that it was not
 * them.
 *
 * Deny-listing specific routes rather than allow-listing the rest is the
 * deliberate trade: an allow-list would break every ordinary read the moment
 * someone adds an endpoint and forgets to mark it, and a support tool that
 * silently stops working is a support tool nobody uses.
 */
export const NoImpersonation = (capability: DeniedCapability) =>
  SetMetadata<string, DeniedCapability>(NO_IMPERSONATION_KEY, capability);
