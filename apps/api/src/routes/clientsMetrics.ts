import type { Request, Response, NextFunction } from 'express';
import { can, type ClientListItem, type ClientPerformanceResponse, type ClientPerformanceStatement } from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { clientMetrics, clientWeeks } from '../lib/clientMetrics.js';
import { ownerName } from '../lib/clientAccountFields.js';
import { daysPastDue, dueOnFor } from '../lib/books/aging.js';
import { statementBalances } from '../lib/books/posting/receivables.js';
import { statementAmounts } from '../lib/books/posting/statements.js';
import { scopeClients } from '../lib/scope.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { orgDateKey } from '../lib/timeAnomalies.js';

/**
 * The clients list's account numbers and a client's Performance tab
 * (Clients rebuild, 2026-10-22). Both read lib/clientMetrics, so a row and
 * the record agree. Money goes only to callers who can read statements
 * (routes/clients STATEMENTS_READ: process:payroll or view:executive) —
 * for everyone else the fields are omitted, never 0.
 */

export const canReadStatements = (req: Request): boolean => can(req.user!, 'process:payroll') || can(req.user!, 'view:executive');
const canReadNps = (req: Request): boolean => can(req.user!, 'view:executive') || can(req.user!, 'view:marketing');

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** ?from=&to= (YYYY-MM-DD, inclusive); default this month to date on the company's clock. */
export function listRange(query: Request['query'], now: Date = new Date()): { from: Date; to: Date } {
  const from = typeof query.from === 'string' ? query.from : '';
  const to = typeof query.to === 'string' ? query.to : '';
  if (from || to) {
    if (!YMD.test(from) || !YMD.test(to) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to)) || from > to) {
      throw new HttpError(400, 'invalid_query', 'from and to are YYYY-MM-DD, from on or before to.');
    }
    return { from: new Date(`${from}T00:00:00.000Z`), to: new Date(`${to}T00:00:00.000Z`) };
  }
  const today = orgDateKey(now);
  return { from: new Date(`${today.slice(0, 8)}01T00:00:00.000Z`), to: new Date(`${today}T00:00:00.000Z`) };
}

/**
 * The account numbers for a page of the list, in a bounded number of
 * reads whatever its length. `items` are already in the caller's reach
 * (the list's scopeClients query); nothing here widens it.
 */
export async function withAccountNumbers(req: Request, items: ClientListItem[], rows: Array<{ id: string; accountOwnerUserId: string | null }>): Promise<ClientListItem[]> {
  if (items.length === 0) return items;
  const money = canReadStatements(req);
  const range = listRange(req.query);
  const ownerIds = [...new Set(rows.map((r) => r.accountOwnerUserId).filter((id): id is string => !!id))];
  const [metrics, owners] = await Promise.all([
    clientMetrics(items.map((c) => c.id), { range, includeMoney: money }),
    ownerIds.length
      ? prisma.user.findMany({
          where: { id: { in: ownerIds }, tenantId: tenantIdForWrite() },
          select: { id: true, email: true, displayName: true, associate: { select: { firstName: true, lastName: true } } },
        })
      : Promise.resolve([]),
  ]);
  const ownerById = new Map(owners.map((u) => [u.id, { id: u.id, name: ownerName(u) }]));
  const ownerOf = new Map(rows.map((r) => [r.id, r.accountOwnerUserId ? (ownerById.get(r.accountOwnerUserId) ?? null) : null]));
  return items.map((c) => {
    const m = metrics.get(c.id);
    if (!m) return c;
    return {
      ...c,
      activeAssociateCount: m.onAssignment,
      onAssignment: m.onAssignment,
      shiftsNext7: m.shiftsNext7,
      fillRatePct: m.fillRatePct,
      hoursThisWeek: m.hoursThisWeek,
      health: m.health,
      healthReasons: m.healthReasons,
      accountOwner: ownerOf.get(c.id) ?? null,
      ...(money && m.money ? { outstanding: m.money.outstanding, billedInRange: m.money.billedInRange } : {}),
    };
  });
}

const PERFORMANCE_WEEKS = 12;
const PERFORMANCE_STATEMENTS = 26;
const NPS_WAVES = 8;

/**
 * GET /clients/:id/performance — the Performance tab: the last 12 complete
 * weeks (hours, overtime, fill rate), the statements with their dates and
 * whether each is paid, waiting or a draft (statements readers only), and
 * NPS wave by wave (executive and marketing only, as on the NPS page).
 */
export async function clientPerformanceHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = tenantIdForWrite();
    // AND, not spread: scopeClients clamps a bounded role with `id`, which a spread would override.
    const client = await prisma.client.findFirst({ where: { AND: [scopeClients(req.user!), { id: req.params.id, tenantId }] }, select: { id: true } });
    if (!client) throw new HttpError(404, 'client_not_found', 'Client not found');
    const now = new Date();
    const money = canReadStatements(req);
    const nps = canReadNps(req);

    const [weeks, statements, balances, waves] = await Promise.all([
      clientWeeks(client.id, { weeks: PERFORMANCE_WEEKS, now }),
      money
        ? prisma.clientStatement.findMany({
            where: { tenantId, clientId: client.id, status: { in: ['DRAFT', 'FINAL'] } },
            orderBy: { periodEnd: 'desc' },
            take: PERFORMANCE_STATEMENTS,
            select: { id: true, number: true, status: true, periodStart: true, periodEnd: true, finalizedAt: true, dueAt: true, paidAt: true, snapshot: true },
          })
        : Promise.resolve(null),
      money ? statementBalances(prisma, { clientId: client.id }) : Promise.resolve(null),
      nps
        ? prisma.clientNpsWave.findMany({
            where: { tenantId, invites: { some: { clientId: client.id } } },
            orderBy: { sentAt: 'desc' },
            take: NPS_WAVES,
            select: { quarter: true, invites: { where: { clientId: client.id, score: { not: null } }, select: { score: true } } },
          })
        : Promise.resolve(null),
    ]);
    if (!weeks) throw new HttpError(404, 'client_not_found', 'Client not found');

    const ymd = (d: Date) => d.toISOString().slice(0, 10);
    const openById = new Map((balances ?? []).map((b) => [b.statementId, b.open / 100]));
    const asOf = orgDateKey(now);
    const statementRows: ClientPerformanceStatement[] | undefined = statements
      ? [...statements].reverse().map((s) => {
          const amounts = statementAmounts(s.snapshot);
          const open = s.status === 'FINAL' ? (openById.get(s.id) ?? 0) : 0;
          const dueOn = s.status === 'FINAL' ? dueOnFor(s) : null;
          const state = s.status === 'DRAFT' ? 'draft' : open > 0 ? 'waiting' : 'paid';
          return {
            id: s.id,
            number: s.number,
            periodStart: ymd(s.periodStart),
            periodEnd: ymd(s.periodEnd),
            amount: amounts.total / 100,
            hours: Number((s.snapshot as { totals?: { hours?: number } } | null)?.totals?.hours ?? 0),
            open,
            state,
            dueOn,
            daysPastDue: state === 'waiting' && dueOn ? Math.max(0, daysPastDue(dueOn, asOf)) : null,
          };
        })
      : undefined;
    const npsPoints = waves
      ? [...waves].reverse().map((w) => {
          const scores = w.invites.map((i) => i.score!);
          const promoters = scores.filter((s) => s >= 9).length;
          const detractors = scores.filter((s) => s <= 6).length;
          return { quarter: w.quarter, nps: scores.length ? Math.round(((promoters - detractors) / scores.length) * 100) : null, responses: scores.length };
        })
      : undefined;

    const payload: ClientPerformanceResponse = {
      clientId: client.id,
      asOf: now.toISOString(),
      weekStartsOn: weeks.weekStartsOn,
      timezone: weeks.timezone,
      weeks: weeks.weeks,
      canSeeMoney: money,
      ...(statementRows ? { statements: statementRows } : {}),
      ...(npsPoints ? { nps: npsPoints } : {}),
    };
    res.json(payload);
  } catch (err) {
    next(err);
  }
}
