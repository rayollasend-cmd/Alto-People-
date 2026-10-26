import type { Role } from './roles.js';

/**
 * ONE REGISTRY OF DECISION QUEUES (F500 SH-4).
 *
 * The Inbox (GET /me/inbox, apps/api/src/routes/inbox.ts) and the Approvals
 * page (apps/web/src/pages/approvals) show many of the same queues. They
 * used to name them differently — the Inbox's "Approvals waiting on you" was
 * the Approvals page's "Second person" — and the tenant-wide queues (contract
 * duties, missed paydays, people on no pay schedule, Fieldglass setup, client
 * requests) had no owner, so six roles each counted the same items.
 *
 * Here each such queue has one name and, where it is a desk's job, one
 * OWNER DESK. The Inbox counts a queue toward someone's badge only when it is
 * their desk's (or nobody in the company staffs that desk); everyone else who
 * may see it gets it in a collapsed "Also watching" band. The Approvals page's
 * chips read the same words (its English i18n values are checked against this
 * file by a test).
 */

/** The desks that own company-wide queues. */
export type QueueDesk = 'hr' | 'payroll' | 'ops';

/** Who staffs each desk. A queue whose desk nobody in the company staffs is everyone's who can see it. */
export const QUEUE_DESK_ROLES: Readonly<Record<QueueDesk, readonly Role[]>> = {
  hr: ['HR_ADMINISTRATOR'],
  payroll: ['FINANCE_ACCOUNTANT'],
  ops: ['OPERATIONS_MANAGER'],
};

export interface QueueDef {
  /** The one name both pages use. */
  label: string;
  /** The desk whose job it is; absent = everyone who may see it owns it. */
  ownerDesk?: QueueDesk;
  /** The Approvals page tab that lists the same items. */
  approvalsTab?: ApprovalsQueueKey;
}

/** The Approvals page's queues (DeskTemplate tabs). */
export const APPROVALS_QUEUE_KEYS = ['walk-ins', 'time-off', 'swaps', 'pickups', 'proposals', 'requests', 'timesheets', 'unconfirmed'] as const;
export type ApprovalsQueueKey = (typeof APPROVALS_QUEUE_KEYS)[number];

/** The Approvals page's chip names, in English (the web's `appr.q.*` values). */
export const APPROVALS_QUEUE_LABELS: Readonly<Record<ApprovalsQueueKey, string>> = {
  'walk-ins': 'Walk-ins',
  'time-off': 'Time off',
  swaps: 'Swaps',
  pickups: 'Pickups',
  proposals: 'Suggested by an AI agent',
  requests: 'Pay & access changes',
  timesheets: 'Timesheets',
  unconfirmed: 'Unconfirmed shifts (48h)',
};

/** Inbox source key → its one name, owner and Approvals twin. */
export const QUEUE_REGISTRY: Readonly<Record<string, QueueDef>> = {
  // On both pages.
  approvals: { label: 'Shift & time-off approvals' },
  timesheets: { label: 'Timesheets to approve', approvalsTab: 'timesheets' },
  'agent-proposals': { label: APPROVALS_QUEUE_LABELS.proposals, approvalsTab: 'proposals' },
  'approval-requests': { label: APPROVALS_QUEUE_LABELS.requests, approvalsTab: 'requests' },
  // Company-wide queues with an owner desk.
  'contract-duties': { label: 'Contract duties overdue', ownerDesk: 'hr' },
  'payroll-missed-paydays': { label: 'Paydays with no run', ownerDesk: 'payroll' },
  'pay-schedule-unassigned': { label: 'People on no pay schedule', ownerDesk: 'payroll' },
  'pay-schedule-moves': { label: 'Pay schedule moves starting this week', ownerDesk: 'payroll' },
  // Carrier feeds (benefits back office) sit with payroll.
  'carrier-answers': { label: 'Carrier answers', ownerDesk: 'payroll' },
  'fieldglass-setup': { label: 'Fieldglass setup', ownerDesk: 'ops' },
  'client-requests': { label: 'Client requests', ownerDesk: 'ops' },
  // One word, one meaning: the associate's unread notices are not "the inbox".
  'my-notifications': { label: 'Unread notices' },
};

/** Whether `role` staffs the desk that owns queue `key` (true for a queue with no owner). */
export function staffsQueueDesk(key: string, role: Role): boolean {
  const desk = QUEUE_REGISTRY[key]?.ownerDesk;
  return !desk || QUEUE_DESK_ROLES[desk].includes(role);
}
