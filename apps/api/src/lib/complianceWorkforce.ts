import type { Prisma, PrismaClient } from '@prisma/client';
import {
  parseComplianceWorkforce,
  workforceOfStatus,
  type ComplianceWorkforce,
  type WorkforceCounts,
  type WorkforceGroup,
  type WorkStatus,
} from '@alto-people/shared';
import { prisma as defaultPrisma } from '../db.js';
import { peopleStandings, type Standings } from './peopleStatus.js';

/**
 * Who a compliance list is about (owner, 2026-11-03; the groups are
 * packages/shared complianceWorkforce.ts). The E-Verify, I-9, background,
 * drug-test and J-1 lists each take `?workforce=current|starting|paused|
 * former|all` (default current) and read it through here, so a person sits
 * in the same group on every list as on the People directory: the group is
 * their one status (lib/peopleStatus), not a rule each route writes again.
 *
 * Read the workforce once per request, then filter the list's rows with
 * `includes` (or a Prisma `in` from `idsOf`), and count the list's own
 * people with `countWorkforce` — the chip counts are about that list, in
 * the caller's reach, not about the whole company.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export interface WorkforceReading {
  standings: Standings;
  /** The person's status; null when they are no longer on file (deleted or erased). */
  statusOf(associateId: string): WorkStatus | null;
  groupOf(associateId: string): WorkforceGroup | null;
  /** In this group? `all` takes everyone, including people no longer on file. */
  includes(associateId: string, workforce: ComplianceWorkforce): boolean;
  /** The group's ids, for a Prisma `in`; null for `all` (no filter). */
  idsOf(workforce: ComplianceWorkforce): string[] | null;
}

export async function readWorkforce(tenantId: string, now: Date = new Date(), db: Db = defaultPrisma): Promise<WorkforceReading> {
  const standings = await peopleStandings({ tenantId }, now, db);
  const groups = new Map<string, WorkforceGroup>();
  for (const p of standings.people.values()) groups.set(p.id, workforceOfStatus(p.status));
  return {
    standings,
    statusOf: (id) => standings.people.get(id)?.status ?? null,
    groupOf: (id) => groups.get(id) ?? null,
    includes: (id, w) => w === 'all' || groups.get(id) === w,
    idsOf: (w) => (w === 'all' ? null : [...groups].filter(([, g]) => g === w).map(([id]) => id)),
  };
}

/** The chip counts over a list's people, each person once. `all` is the whole list. */
export function countWorkforce(associateIds: Iterable<string>, reading: WorkforceReading): WorkforceCounts {
  const counts: WorkforceCounts = { current: 0, starting: 0, paused: 0, former: 0, all: 0 };
  for (const id of new Set(associateIds)) {
    counts.all += 1;
    const g = reading.groupOf(id);
    if (g) counts[g] += 1;
  }
  return counts;
}

/** `?workforce=` from a request's query; anything else is the default (current). */
export function workforceFromQuery(query: Record<string, unknown>): ComplianceWorkforce {
  return parseComplianceWorkforce(query.workforce);
}
