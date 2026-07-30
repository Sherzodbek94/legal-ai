/**
 * The catalogue of notifiable events.
 *
 * Which channels an event may reach is a product decision that lives in code,
 * like the plan catalogue: it needs to be reviewed and revertible, and a routing
 * rule edited in a production database is invisible in a way one edited here is
 * not.
 *
 * The distinction that matters most here is `urgency`. It decides whether an
 * event may wake someone up. Getting it wrong in the permissive direction trains
 * users to disable notifications entirely, at which point the ones that actually
 * matter stop arriving too.
 */
import { NotificationChannel } from '@legaltech/database';

export type NotificationUrgency =
  /** May be delivered during quiet hours on any channel. */
  | 'critical'
  /** Held on interruptive channels until quiet hours end. */
  | 'normal'
  /** In-app only. Never emails, never buzzes a phone. */
  | 'low';

export interface NotificationEventDefinition {
  key: string;
  description: string;
  /** Channels this event is *allowed* to use, before user preferences. */
  channels: NotificationChannel[];
  urgency: NotificationUrgency;
  /**
   * Whether a user can turn this off.
   *
   * A handful cannot: being told your account was suspended, or that a document
   * you are the sole approver of is blocking, is not a marketing preference.
   */
  mandatory?: boolean;
}

const { IN_APP, EMAIL, SMS, TELEGRAM } = NotificationChannel;

export const NOTIFICATION_EVENTS: Record<string, NotificationEventDefinition> = {
  // --- Approval workflow ----------------------------------------------------
  'document.approval_requested': {
    key: 'document.approval_requested',
    description: 'A document is waiting on your approval',
    channels: [IN_APP, EMAIL, TELEGRAM],
    urgency: 'normal',
  },
  'document.approved': {
    key: 'document.approved',
    description: 'A document you submitted completed its approval chain',
    channels: [IN_APP, EMAIL, TELEGRAM],
    urgency: 'normal',
  },
  'document.rejected': {
    key: 'document.rejected',
    description: 'A document you submitted was rejected',
    channels: [IN_APP, EMAIL, TELEGRAM],
    urgency: 'normal',
  },
  'document.generation_failed': {
    key: 'document.generation_failed',
    description: 'Document generation failed',
    channels: [IN_APP, EMAIL],
    urgency: 'normal',
  },

  // --- OCR ------------------------------------------------------------------
  'ocr.completed': {
    key: 'ocr.completed',
    description: 'A scanned document finished text extraction',
    channels: [IN_APP],
    urgency: 'low',
  },
  'ocr.low_confidence': {
    key: 'ocr.low_confidence',
    description: 'Extraction succeeded but the text needs review',
    channels: [IN_APP, EMAIL],
    urgency: 'low',
  },

  // --- Billing --------------------------------------------------------------
  'billing.payment_failed': {
    key: 'billing.payment_failed',
    description: 'A subscription payment failed',
    // SMS included: this one has a deadline attached and an unread email means
    // losing service.
    channels: [IN_APP, EMAIL, SMS, TELEGRAM],
    urgency: 'critical',
    mandatory: true,
  },
  'billing.payment_succeeded': {
    key: 'billing.payment_succeeded',
    description: 'A subscription payment went through',
    channels: [IN_APP, EMAIL],
    urgency: 'low',
  },
  'billing.grace_period_ending': {
    key: 'billing.grace_period_ending',
    description: 'Service will be suspended shortly unless payment is updated',
    channels: [IN_APP, EMAIL, SMS, TELEGRAM],
    urgency: 'critical',
    mandatory: true,
  },
  'billing.quota_exhausted': {
    key: 'billing.quota_exhausted',
    description: 'A plan limit has been reached',
    channels: [IN_APP, EMAIL],
    urgency: 'normal',
  },
  'billing.trial_ending': {
    key: 'billing.trial_ending',
    description: 'A trial is about to end',
    channels: [IN_APP, EMAIL],
    urgency: 'normal',
  },

  // --- Security -------------------------------------------------------------
  'security.account_locked': {
    key: 'security.account_locked',
    description: 'An account was suspended',
    channels: [EMAIL, SMS],
    urgency: 'critical',
    mandatory: true,
  },
  'security.impersonation_started': {
    key: 'security.impersonation_started',
    description: 'Support accessed your account',
    // Transparency obligation, not a courtesy: the user is told regardless of
    // preferences, which is why it is mandatory and skips IN_APP — an in-app
    // notice only visible from inside the account being accessed is no notice.
    channels: [EMAIL],
    urgency: 'critical',
    mandatory: true,
  },
  'security.new_sign_in': {
    key: 'security.new_sign_in',
    description: 'A sign-in from an unrecognised device',
    channels: [IN_APP, EMAIL],
    urgency: 'normal',
  },

  // --- Membership -----------------------------------------------------------
  'company.member_invited': {
    key: 'company.member_invited',
    description: 'You were invited to a company workspace',
    channels: [EMAIL],
    urgency: 'normal',
    mandatory: true,
  },
} as const;

export type NotificationEventKey = keyof typeof NOTIFICATION_EVENTS;

export function getEventDefinition(
  key: string,
): NotificationEventDefinition | undefined {
  return NOTIFICATION_EVENTS[key];
}

/** Events a user may configure, for the preferences screen. */
export function configurableEvents(): NotificationEventDefinition[] {
  return Object.values(NOTIFICATION_EVENTS).filter((event) => !event.mandatory);
}
