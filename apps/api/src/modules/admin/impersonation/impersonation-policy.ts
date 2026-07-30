/**
 * The rules governing who may impersonate whom.
 *
 * Impersonation is the most dangerous feature in an admin panel: it converts a
 * support tool into a working session inside a customer's account, holding their
 * privileges, over their data. The rules below are the whole of the protection,
 * so they live as pure functions that can be tested exhaustively rather than
 * being scattered through a service.
 */
import { UserRole } from '@legaltech/database';

/**
 * Hard ceiling on a session.
 *
 * Fifteen minutes is long enough to reproduce a customer's problem and short
 * enough that a forgotten tab is not a standing back door. It is enforced in
 * three places — the JWT `exp`, the session row's `expiresAt`, and the check in
 * JwtStrategy — because any one of them alone can be bypassed or drift.
 */
export const IMPERSONATION_TTL_MS = 15 * 60 * 1000;

/** Minimum length of the justification recorded against a session. */
export const MIN_REASON_LENGTH = 10;

export type ImpersonationRefusal =
  | 'NOT_SUPER_ADMIN'
  | 'ALREADY_IMPERSONATING'
  | 'SELF_IMPERSONATION'
  | 'TARGET_IS_SUPER_ADMIN'
  | 'TARGET_INACTIVE'
  | 'TARGET_LOCKED'
  | 'REASON_TOO_SHORT'
  | 'CONCURRENT_SESSION';

export interface ImpersonationDecision {
  allowed: boolean;
  reason?: ImpersonationRefusal;
  message?: string;
}

const MESSAGES: Record<ImpersonationRefusal, string> = {
  NOT_SUPER_ADMIN: 'Only platform administrators may impersonate users',
  ALREADY_IMPERSONATING:
    'Cannot start an impersonation from inside another impersonation session',
  SELF_IMPERSONATION: 'You are already signed in as this user',
  TARGET_IS_SUPER_ADMIN: 'Platform administrators cannot be impersonated',
  TARGET_INACTIVE: 'That account is no longer active',
  TARGET_LOCKED:
    'That account is suspended; unlock it before impersonating',
  REASON_TOO_SHORT: `A justification of at least ${MIN_REASON_LENGTH} characters is required`,
  CONCURRENT_SESSION:
    'You already have an active impersonation session; end it first',
};

export interface Actor {
  id: string;
  role: UserRole;
  /** True when the actor's own session is itself an impersonation. */
  isImpersonating: boolean;
}

export interface Target {
  id: string;
  role: UserRole;
  deletedAt: Date | null;
  lockedAt: Date | null;
}

function refuse(reason: ImpersonationRefusal): ImpersonationDecision {
  return { allowed: false, reason, message: MESSAGES[reason] };
}

/**
 * Whether `actor` may impersonate `target`.
 *
 * Checks are ordered from the actor outward, so a caller with no business here
 * at all learns nothing about the target.
 */
export function canImpersonate(
  actor: Actor,
  target: Target,
  reason: string,
  hasActiveSession = false,
): ImpersonationDecision {
  if (actor.role !== UserRole.SUPER_ADMIN) {
    return refuse('NOT_SUPER_ADMIN');
  }

  // No nesting. Chained impersonation makes the audit trail ambiguous about who
  // actually acted, and it is the natural path for laundering an action through
  // two accounts.
  if (actor.isImpersonating) {
    return refuse('ALREADY_IMPERSONATING');
  }

  if (actor.id === target.id) {
    return refuse('SELF_IMPERSONATION');
  }

  // Lateral privilege escalation: impersonating a peer administrator would let
  // one operator act with another's identity, defeating the point of naming the
  // actor at all.
  if (target.role === UserRole.SUPER_ADMIN) {
    return refuse('TARGET_IS_SUPER_ADMIN');
  }

  if (target.deletedAt) return refuse('TARGET_INACTIVE');

  // A locked account is one under investigation or suspended for abuse.
  // Entering it would both bypass the lock and contaminate whatever is being
  // investigated.
  if (target.lockedAt) return refuse('TARGET_LOCKED');

  if (!reason || reason.trim().length < MIN_REASON_LENGTH) {
    return refuse('REASON_TOO_SHORT');
  }

  // One at a time, per operator. Concurrent sessions make "who was in this
  // account at 14:32" unanswerable.
  if (hasActiveSession) return refuse('CONCURRENT_SESSION');

  return { allowed: true };
}

/**
 * Capabilities withheld from an impersonated session.
 *
 * Impersonation exists to *see* what a customer sees and reproduce their
 * problem. Actions in this list either move money, change who can get in, or
 * cannot be undone — none of which a support engineer should be able to do while
 * wearing a customer's identity, however legitimate their intent.
 *
 * Enforced by ImpersonationGuard against routes marked @NoImpersonation().
 */
export const IMPERSONATION_DENIED_CAPABILITIES = [
  'billing:write',
  'payment:write',
  'auth:credentials',
  'company:delete',
  'member:write',
  'impersonation:start',
] as const;

export type DeniedCapability =
  (typeof IMPERSONATION_DENIED_CAPABILITIES)[number];

export function expiresAtFrom(startedAt: Date): Date {
  return new Date(startedAt.getTime() + IMPERSONATION_TTL_MS);
}

/** Seconds of life left, floored at zero — surfaced in the UI as a countdown. */
export function remainingSeconds(expiresAt: Date, now = new Date()): number {
  const ms = expiresAt.getTime() - now.getTime();
  return ms <= 0 ? 0 : Math.floor(ms / 1000);
}
