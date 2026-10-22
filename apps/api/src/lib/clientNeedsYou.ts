import type { Prisma, PrismaClient } from '@prisma/client';
import type { ClientNeedsYouItem, ClientNeedsYouKind } from '@alto-people/shared';
import { prisma as defaultPrisma } from '../db.js';
import { daysPastDue, dueOnFor } from './books/aging.js';
import { statementBalances } from './books/posting/receivables.js';
import { computePortalReadiness } from './portalReadiness.js';
import { orgDateKey } from './timeAnomalies.js';

/**
 * What needs someone on one client account (CL-A, 2026-10-22) — the list
 * at the top of the client's Overview. Each item is computed from the
 * tables that hold it, carries an exact count, and links to the list
 * behind it:
 *
 *   unfilled_shifts      published (OPEN) shifts with no one on them, next 7 days
 *   overdue_statements   finalized statements past due with money still open
 *                        (books/aging; money readers only)
 *   contract_ended /     the contract's end date has passed, or falls within
 *   contract_ending      60 days (30 or fewer is a risk)
 *   nps_detractors       scores of 6 or less in the last 90 days
 *   client_requests      the client's requests not yet resolved
 *   portal_readiness     the portal's setup gaps, once the client has a portal login
 *   no_primary_contact / a nudge for the people who run accounts
 *   no_account_owner
 *
 * Risks first, then watches, each in the order above.
 */

type Db = PrismaClient | Prisma.TransactionClient;

const DAY_MS = 86_400_000;
export const UNFILLED_WINDOW_DAYS = 7;
export const CONTRACT_WATCH_DAYS = 60;
export const CONTRACT_RISK_DAYS = 30;
export const NPS_WINDOW_DAYS = 90;
export const NPS_DETRACTOR_MAX = 6;

const ORDER: ClientNeedsYouKind[] = [
  'overdue_statements',
  'unfilled_shifts',
  'contract_ended',
  'contract_ending',
  'client_requests',
  'nps_detractors',
  'portal_readiness',
  'no_account_owner',
  'no_primary_contact',
];

const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const longDate = (ymd: string) => new Date(`${ymd}T12:00:00.000Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const ymdOf = (d: Date) => d.toISOString().slice(0, 10);

/** Whole calendar days from today (the company's date) to a YYYY-MM-DD; negative once it has passed. */
export function daysUntil(ymd: string, now: Date): number {
  return Math.round((Date.parse(`${ymd}T00:00:00.000Z`) - Date.parse(`${orgDateKey(now)}T00:00:00.000Z`)) / DAY_MS);
}

function inWords(days: number): string {
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

export interface NeedsYouInput {
  client: { id: string; name: string; contractEndDate: Date | null; accountOwnerUserId: string | null };
  tenantId: string;
  now?: Date;
  /** process:payroll or view:executive — overdue statements are money. */
  canSeeMoney: boolean;
  /** manage:clients — the owner / primary-contact nudges are theirs. */
  canManage: boolean;
  /** view:executive or view:marketing — /clients/nps opens for them. */
  canSeeNps: boolean;
  /** view:org — the Relay board's client requests open for them. */
  canSeeRelay: boolean;
  /** A live primary contact exists (the overview already read the contacts). */
  hasPrimaryContact: boolean;
}

export async function clientNeedsYou(input: NeedsYouInput, db: Db = defaultPrisma): Promise<ClientNeedsYouItem[]> {
  const { client, tenantId } = input;
  const now = input.now ?? new Date();
  const base = `/clients/${client.id}`;
  const items: ClientNeedsYouItem[] = [];

  const [openShifts, balances, detractors, requests, readiness] = await Promise.all([
    db.shift.findMany({
      where: {
        tenantId,
        clientId: client.id,
        status: 'OPEN',
        assignedAssociateId: null,
        startsAt: { gte: now, lt: new Date(now.getTime() + UNFILLED_WINDOW_DAYS * DAY_MS) },
      },
      select: { startsAt: true },
      orderBy: { startsAt: 'asc' },
      take: 1000,
    }),
    input.canSeeMoney ? statementBalances(db, { clientId: client.id, paidAt: null }) : Promise.resolve([]),
    db.clientNpsInvite.findMany({
      where: {
        tenantId,
        clientId: client.id,
        respondedAt: { gte: new Date(now.getTime() - NPS_WINDOW_DAYS * DAY_MS), lte: now },
        score: { lte: NPS_DETRACTOR_MAX },
      },
      select: { score: true, respondedAt: true, comment: true },
      orderBy: { respondedAt: 'desc' },
      take: 200,
    }),
    db.clientRequest.findMany({
      where: { tenantId, clientId: client.id, status: { not: 'RESOLVED' } },
      select: { createdAt: true, dueAt: true, status: true },
      orderBy: { createdAt: 'asc' },
      take: 500,
    }),
    computePortalReadiness(client.id, db as PrismaClient),
  ]);

  // Unfilled shifts in the next 7 days.
  if (openShifts.length > 0) {
    const firstIn = Math.max(0, Math.floor((openShifts[0]!.startsAt.getTime() - now.getTime()) / DAY_MS));
    const soon = openShifts.filter((s) => s.startsAt.getTime() - now.getTime() < 2 * DAY_MS).length;
    items.push({
      kind: 'unfilled_shifts',
      severity: soon > 0 ? 'risk' : 'watch',
      title: `${plural(openShifts.length, 'shift')} with no one on ${openShifts.length === 1 ? 'it' : 'them'}`,
      detail: soon > 0 ? `${plural(soon, 'starts', 'start')} in the next 48 hours.` : `In the next 7 days; the first starts ${inWords(firstIn)}.`,
      count: openShifts.length,
      href: `/scheduling?client=${client.id}&open=1`,
    });
  }

  // Overdue statements (money).
  if (input.canSeeMoney) {
    const late = balances
      .map((b) => ({ ...b, days: daysPastDue(dueOnFor({ dueAt: b.dueAt, finalizedAt: b.finalizedAt, periodEnd: b.periodEnd }), now) }))
      .filter((b) => b.open > 0 && b.days > 0)
      .sort((a, b) => b.days - a.days);
    if (late.length > 0) {
      const cents = late.reduce((n, b) => n + b.open, 0);
      const oldest = late[0]!;
      const label = oldest.number !== null ? `No. ${String(oldest.number).padStart(4, '0')}` : `the ${longDate(oldest.periodEnd)} statement`;
      items.push({
        kind: 'overdue_statements',
        severity: oldest.days > 30 ? 'risk' : 'watch',
        title: `${money(cents / 100)} past due on ${plural(late.length, 'statement')}`,
        detail: `The oldest, ${label}, is ${plural(oldest.days, 'day')} past due.`,
        count: late.length,
        href: `${base}?section=statements`,
      });
    }
  }

  // The contract's end.
  if (client.contractEndDate) {
    const end = ymdOf(client.contractEndDate);
    const left = daysUntil(end, now);
    if (left < 0) {
      items.push({
        kind: 'contract_ended',
        severity: 'risk',
        title: `Contract ended ${longDate(end)}`,
        detail: `${plural(-left, 'day')} ago. Record the renewed term, or mark the account inactive.`,
        href: `${base}?section=overview#account`,
      });
    } else if (left <= CONTRACT_WATCH_DAYS) {
      items.push({
        kind: 'contract_ending',
        severity: left <= CONTRACT_RISK_DAYS ? 'risk' : 'watch',
        title: `Contract ends ${longDate(end)}`,
        detail: left === 0 ? 'Today.' : `${plural(left, 'day')} left.`,
        href: `${base}?section=overview#account`,
      });
    }
  }

  // Client requests waiting on us.
  if (requests.length > 0) {
    const overdue = requests.filter((r) => r.dueAt && r.dueAt.getTime() < now.getTime()).length;
    const oldestDays = Math.floor((now.getTime() - requests[0]!.createdAt.getTime()) / DAY_MS);
    items.push({
      kind: 'client_requests',
      severity: overdue > 0 ? 'risk' : 'watch',
      title: `${plural(requests.length, 'request')} from the client waiting on us`,
      detail: overdue > 0 ? `${plural(overdue, 'is', 'are')} past the time promised.` : oldestDays === 0 ? 'The oldest came in today.' : `The oldest came in ${plural(oldestDays, 'day')} ago.`,
      count: requests.length,
      href: input.canSeeRelay ? '/relay#client-requests' : `${base}?section=portal`,
    });
  }

  // NPS detractors in the last 90 days.
  if (detractors.length > 0) {
    const latest = detractors[0]!;
    const said = latest.comment?.trim();
    const quote = said ? ` “${said.length > 90 ? `${said.slice(0, 89).trimEnd()}…` : said}”` : '';
    items.push({
      kind: 'nps_detractors',
      severity: 'risk',
      title: `${plural(detractors.length, 'detractor')} in the last 90 days`,
      detail: `Latest: ${latest.score}/10 on ${longDate(ymdOf(latest.respondedAt!))}.${quote}`,
      count: detractors.length,
      href: input.canSeeNps ? '/clients/nps' : `${base}?section=performance`,
    });
  }

  // The portal's setup gaps, once someone at the client has a login.
  if (readiness.accounts > 0 && readiness.gaps.length > 0) {
    items.push({
      kind: 'portal_readiness',
      severity: 'watch',
      title: `The client portal has ${plural(readiness.gaps.length, 'setup gap')}`,
      detail: readiness.gaps[0]!,
      count: readiness.gaps.length,
      href: `${base}?section=portal`,
    });
  }

  if (input.canManage && !client.accountOwnerUserId) {
    items.push({
      kind: 'no_account_owner',
      severity: 'watch',
      title: 'No account owner',
      detail: `Name the person who runs ${client.name}.`,
      href: `${base}?section=overview#account`,
    });
  }
  if (input.canManage && !input.hasPrimaryContact) {
    items.push({
      kind: 'no_primary_contact',
      severity: 'watch',
      title: 'No primary contact',
      detail: `Add the person you call at ${client.name}.`,
      href: `${base}?section=overview#contacts`,
    });
  }

  const rank = (i: ClientNeedsYouItem) => (i.severity === 'risk' ? 0 : 100) + ORDER.indexOf(i.kind);
  return items.sort((a, b) => rank(a) - rank(b));
}
