import type { Prisma, PrismaClient } from '@prisma/client';
import { can } from '@alto-people/shared';
import type { SessionUser } from '../types/express.js';
import { ATTESTATION_CONFIGS, classifyStatus, dueDateFor, periodForNow, type AttestationCadence } from './manualAttestation.js';
import { isClientBoundedRole, isInternallyScoped } from './scope.js';
import { tenantIdForWrite } from './tenant.js';
import { loadTenantProfile, tenantProfileSync } from './tenantProfile.js';

/**
 * The contract duties that are overdue (role walk HR 2): the recurring
 * things the client contracts (MSA / SOW / MTSA) make the company do —
 * the monthly compliance report, the weekly Fieldglass timesheet, the
 * invoice forfeiture review, the yearly insurance certificates, the OSHA
 * 300A posting — each confirmed on the compliance scorecard by a manual
 * attestation for its period.
 *
 * The scorecard tiles (and the daily posture snapshot, once per client)
 * read them a config at a time, two queries each. This is the one read the
 * HR home and the Inbox count share: every duty's current period, the
 * attestations and snoozes for all of them in two queries, and the ones
 * past due and not confirmed.
 *
 * Reach: the duties are the company's, under contracts that span its
 * clients, so they belong to people whose reach is the whole company —
 * someone limited to sites or regions, or bound to a client, has none.
 * A duty HR snoozed is left out of the count (and reported as snoozed).
 */

type Db = PrismaClient | Prisma.TransactionClient;

export interface ContractDuty {
  key: string;
  label: string;
  /** What is owed ("Workers' comp certificate of insurance"). */
  deliverable: string;
  cadence: AttestationCadence;
  periodStart: string;
  dueDate: string;
  daysOverdue: number;
}

export interface OverdueContractDuties {
  items: ContractDuty[];
  /** Overdue and not snoozed. */
  count: number;
  /** Overdue but snoozed by HR until a date. */
  snoozed: number;
  /** The oldest overdue duty's due date. */
  oldestDue: string | null;
}

const DAY_MS = 86_400_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const NONE: OverdueContractDuties = { items: [], count: 0, snoozed: 0, oldestDue: null };

/** Whether this person's reach includes the company's contract duties (and the tenant has client contracts). */
export function seesContractDuties(user: SessionUser): boolean {
  if (!can(user, 'view:compliance') || isClientBoundedRole(user) || isInternallyScoped(user)) return false;
  // The tenant's profile is loaded before the Inbox filters its rows; unknown yet = let the count decide.
  const profile = tenantProfileSync();
  return !profile || profile.modules.clientPortal || profile.modules.billRates;
}

export async function overdueContractDuties(db: Db, user: SessionUser, now: Date = new Date()): Promise<OverdueContractDuties> {
  if (!seesContractDuties(user)) return NONE;
  const tenantId = tenantIdForWrite();
  // Client contracts exist where the tenant staffs clients (the scorecard's own gate).
  const { modules } = await loadTenantProfile(tenantId);
  if (!modules.clientPortal && !modules.billRates) return NONE;
  const periods = ATTESTATION_CONFIGS.map((c) => ({ config: c, periodStart: periodForNow(c.cadence, now).periodStart }));
  const keyed = periods.map((p) => ({ key: p.config.key, periodStart: p.periodStart }));
  const [attested, snoozes] = await Promise.all([
    db.manualComplianceAttestation.findMany({ where: { tenantId, OR: keyed }, select: { key: true, periodStart: true } }),
    db.attestationSnooze.findMany({ where: { tenantId, OR: keyed, snoozedUntil: { gt: now } }, select: { key: true, periodStart: true } }),
  ]);
  const has = (rows: Array<{ key: string; periodStart: Date }>, key: string, start: Date) =>
    rows.some((r) => r.key === key && ymd(r.periodStart) === ymd(start));

  const items: ContractDuty[] = [];
  let snoozed = 0;
  for (const { config, periodStart } of periods) {
    const done = has(attested, config.key, periodStart);
    if (classifyStatus(config, periodStart, done, now) !== 'overdue') continue;
    if (has(snoozes, config.key, periodStart)) {
      snoozed += 1;
      continue;
    }
    const due = dueDateFor(config, periodStart);
    items.push({
      key: config.key,
      label: config.label,
      deliverable: config.deliverable ?? config.label,
      cadence: config.cadence,
      periodStart: ymd(periodStart),
      dueDate: ymd(due),
      daysOverdue: Math.max(1, Math.floor((now.getTime() - due.getTime()) / DAY_MS)),
    });
  }
  items.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  return { items, count: items.length, snoozed, oldestDue: items[0]?.dueDate ?? null };
}
