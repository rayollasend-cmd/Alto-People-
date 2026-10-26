import type { Prisma, PrismaClient } from '@prisma/client';
import type { ClientActivityItem } from '@alto-people/shared';
import { prisma as defaultPrisma } from '../db.js';
import { statementAmounts } from './books/posting/statements.js';

/**
 * What happened on one client account lately (CL-A, 2026-10-22), newest
 * first, each line naming who and when — read from the tables that hold it:
 *
 *   ClientStatement       finalized / marked paid              (money)
 *   ClientCollectionNote  promises to pay, calls, notes        (money)
 *   ClientRequest         opened by the client / answered by us
 *   AuditLog (clientId)   portal logins given and pulled, bill-rate and
 *                         billing-terms changes (money), contacts added,
 *                         the owner and the contract term changed
 *
 * Money lines appear only for the people who can read statements.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export const ACTIVITY_LIMIT = 10;

const AUDIT_ACTIONS = {
  'client.portal_user_invited': { kind: 'portal_user_added', money: false },
  'client.portal_user_disabled': { kind: 'portal_user_disabled', money: false },
  'pay.bill_rate_changed': { kind: 'bill_rate_changed', money: true },
  'client.billing_terms_updated': { kind: 'billing_terms_changed', money: true },
  'client.contact_added': { kind: 'contact_added', money: false },
  'client.owner_changed': { kind: 'owner_changed', money: false },
  'client.contract_changed': { kind: 'contract_changed', money: false },
} as const satisfies Record<string, { kind: ClientActivityItem['kind']; money: boolean }>;
type AuditAction = keyof typeof AUDIT_ACTIONS;

const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const shortDate = (ymd: string) => new Date(`${ymd.slice(0, 10)}T12:00:00.000Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const statementName = (number: number | null, periodEnd: Date) => (number !== null ? `Statement No. ${String(number).padStart(4, '0')}` : `The statement ending ${shortDate(periodEnd.toISOString())}`);
const clip = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

type Meta = Record<string, unknown>;

/**
 * A person as people say them: their display name, else their worker
 * record's name, else their address's name part made readable
 * ("priya.shah@…" → "Priya Shah") — never a raw email in a sentence.
 */
export function personName(u: { email: string; displayName?: string | null; associate?: { firstName: string; lastName: string } | null }): string {
  const display = u.displayName?.trim();
  if (display) return display;
  const worker = u.associate ? `${u.associate.firstName} ${u.associate.lastName}`.trim() : '';
  if (worker) return worker;
  const local = u.email.split('@')[0] ?? u.email;
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ') || u.email;
}
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function auditText(action: AuditAction, m: Meta): string {
  switch (action) {
    case 'client.portal_user_invited':
      return `Portal login given to ${str(m.email) ?? 'a store manager'}`;
    case 'client.portal_user_disabled':
      return `Portal login pulled${str(m.email) ? ` from ${str(m.email)}` : ''}`;
    case 'pay.bill_rate_changed': {
      const after = (m.after ?? {}) as Meta;
      const before = (m.before ?? {}) as Meta;
      const to = num(after.billRate);
      const from = num(before.billRate);
      const pos = str(m.position) ?? 'a role';
      if (to === null) return `Bill rate for ${pos} cleared`;
      return from === null ? `Bill rate for ${pos} set to ${money(to)}/h` : `Bill rate for ${pos}: ${money(from)} → ${money(to)}/h`;
    }
    case 'client.billing_terms_updated': {
      const parts: string[] = [];
      if (num(m.paymentTermsDays) !== null) parts.push(`net ${num(m.paymentTermsDays)}`);
      if ('poNumber' in m) parts.push(str(m.poNumber) ? `PO ${str(m.poNumber)}` : 'no standing PO');
      if (typeof m.salesTaxable === 'boolean') parts.push(!m.salesTaxable ? 'no sales tax' : num(m.salesTaxRatePct) !== null ? `sales tax ${num(m.salesTaxRatePct)}%` : 'sales tax on');
      return parts.length ? `Billing terms changed: ${parts.join(', ')}` : 'Billing terms changed';
    }
    case 'client.contact_added':
      return `Contact added: ${str(m.name) ?? 'someone'}${str(m.title) ? `, ${str(m.title)}` : ''}`;
    case 'client.owner_changed':
      return str(m.toName) ? `Account owner set to ${str(m.toName)}` : 'Account owner cleared';
    case 'client.contract_changed': {
      const start = str(m.start);
      const end = str(m.end);
      if (!start && !end) return 'Contract dates cleared';
      return `Contract term set: ${start ? shortDate(start) : 'no start'} to ${end ? shortDate(end) : 'no end'}`;
    }
  }
}

export async function clientActivity(
  input: { clientId: string; tenantId: string; canSeeMoney: boolean; canSeeRelay: boolean; limit?: number },
  db: Db = defaultPrisma,
): Promise<ClientActivityItem[]> {
  const { clientId, tenantId, canSeeMoney } = input;
  const limit = input.limit ?? ACTIVITY_LIMIT;
  const base = `/clients/${clientId}`;
  const actions = (Object.keys(AUDIT_ACTIONS) as AuditAction[]).filter((a) => canSeeMoney || !AUDIT_ACTIONS[a].money);

  const [finalized, paid, notes, opened, answered, audits] = await Promise.all([
    canSeeMoney
      ? db.clientStatement.findMany({
          where: { tenantId, clientId, status: 'FINAL', finalizedAt: { not: null } },
          select: { id: true, number: true, periodEnd: true, finalizedAt: true, finalizedById: true, snapshot: true },
          orderBy: { finalizedAt: 'desc' },
          take: limit,
        })
      : Promise.resolve([]),
    canSeeMoney
      ? db.clientStatement.findMany({
          where: { tenantId, clientId, paidAt: { not: null } },
          select: { id: true, number: true, periodEnd: true, paidAt: true, paidById: true, paymentRef: true },
          orderBy: { paidAt: 'desc' },
          take: limit,
        })
      : Promise.resolve([]),
    canSeeMoney
      ? db.clientCollectionNote.findMany({
          where: { tenantId, clientId },
          select: { id: true, kind: true, note: true, promisedOn: true, promisedAmount: true, createdById: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: limit,
        })
      : Promise.resolve([]),
    db.clientRequest.findMany({
      where: { tenantId, clientId },
      select: { id: true, subject: true, createdAt: true, createdByUserId: true },
      orderBy: { createdAt: 'desc' },
      take: limit,
    }),
    db.clientRequest.findMany({
      where: { tenantId, clientId, resolvedAt: { not: null } },
      select: { id: true, subject: true, resolvedAt: true, resolvedById: true },
      orderBy: { resolvedAt: 'desc' },
      take: limit,
    }),
    db.auditLog.findMany({
      where: { tenantId, clientId, action: { in: actions } },
      select: { id: true, action: true, actorUserId: true, metadata: true, createdAt: true, entityId: true },
      orderBy: { createdAt: 'desc' },
      take: limit * 2,
    }),
  ]);

  type Draft = Omit<ClientActivityItem, 'actor'> & { actorId: string | null };
  const drafts: Draft[] = [];
  const requestsHref = input.canSeeRelay ? '/relay#client-requests' : null;

  for (const s of finalized) {
    const total = statementAmounts(s.snapshot).total / 100;
    drafts.push({ id: `st-final-${s.id}`, kind: 'statement_finalized', at: s.finalizedAt!.toISOString(), actorId: s.finalizedById, text: `${statementName(s.number, s.periodEnd)} finalized: ${money(total)}`, href: `${base}?section=statements` });
  }
  for (const s of paid) {
    drafts.push({ id: `st-paid-${s.id}`, kind: 'statement_paid', at: s.paidAt!.toISOString(), actorId: s.paidById, text: `${statementName(s.number, s.periodEnd)} marked paid${s.paymentRef ? ` (ref ${clip(s.paymentRef, 40)})` : ''}`, href: `${base}?section=statements` });
  }
  for (const n of notes) {
    const text =
      n.kind === 'PROMISE'
        ? `Promise to pay${n.promisedAmount !== null ? ` ${money(Number(n.promisedAmount))}` : ''}${n.promisedOn ? ` by ${shortDate(n.promisedOn.toISOString())}` : ''}`
        : n.kind === 'CALL'
          ? `Collections call: ${clip(n.note)}`
          : `Collections note: ${clip(n.note)}`;
    drafts.push({ id: `note-${n.id}`, kind: 'collection_note', at: n.createdAt.toISOString(), actorId: n.createdById, text, href: `${base}?section=statements` });
  }
  for (const r of opened) {
    drafts.push({ id: `req-open-${r.id}`, kind: 'request_opened', at: r.createdAt.toISOString(), actorId: r.createdByUserId, text: `Request from the client: ${clip(r.subject)}`, href: requestsHref });
  }
  for (const r of answered) {
    drafts.push({ id: `req-done-${r.id}`, kind: 'request_answered', at: r.resolvedAt!.toISOString(), actorId: r.resolvedById, text: `Request answered: ${clip(r.subject)}`, href: requestsHref });
  }

  // A pulled login's audit row names the account by id only: read the emails.
  const disabledIds = audits.filter((a) => a.action === 'client.portal_user_disabled').map((a) => a.entityId);
  const disabledEmails = disabledIds.length
    ? new Map((await db.user.findMany({ where: { id: { in: disabledIds } }, select: { id: true, email: true } })).map((u) => [u.id, u.email]))
    : new Map<string, string>();
  for (const a of audits) {
    const action = a.action as AuditAction;
    const spec = AUDIT_ACTIONS[action];
    if (!spec) continue;
    const meta: Meta = { ...((a.metadata ?? {}) as Meta) };
    if (action === 'client.portal_user_disabled') meta.email = disabledEmails.get(a.entityId) ?? null;
    const href =
      action === 'client.portal_user_invited' || action === 'client.portal_user_disabled'
        ? `${base}?section=portal`
        : action === 'pay.bill_rate_changed'
          ? `${base}?section=rates`
          : action === 'client.billing_terms_updated'
            ? `${base}?section=settings`
            : `${base}?section=overview`;
    drafts.push({ id: `audit-${a.id}`, kind: spec.kind, at: a.createdAt.toISOString(), actorId: a.actorUserId, text: auditText(action, meta), href });
  }

  drafts.sort((x, y) => y.at.localeCompare(x.at) || x.id.localeCompare(y.id));
  const top = drafts.slice(0, limit);

  // People by name, never by address (F500 2026-10-26: "Account owner set to
  // manager@altohr.com"): the actors, and the owner an owner change names —
  // read now, so a name added since reads too.
  const ownerIds = new Map<string, string>();
  for (const a of audits) {
    const to = str(((a.metadata ?? {}) as Meta).to);
    if (a.action === 'client.owner_changed' && to) ownerIds.set(`audit-${a.id}`, to);
  }
  const ids = [...new Set([...top.map((d) => d.actorId), ...top.map((d) => ownerIds.get(d.id) ?? null)].filter((x): x is string => !!x))];
  const users = ids.length
    ? await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, email: true, displayName: true, associate: { select: { firstName: true, lastName: true } } } })
    : [];
  // Who did it keeps the address when there is no name (it identifies the login); the owner reads as a person.
  const actors = new Map(users.map((u) => [u.id, u.displayName?.trim() || (u.associate ? `${u.associate.firstName} ${u.associate.lastName}`.trim() : '') || u.email]));
  const names = new Map(users.map((u) => [u.id, personName(u)]));
  return top.map(({ actorId, ...d }) => {
    const owner = ownerIds.get(d.id);
    const text = owner && names.get(owner) ? `Account owner set to ${names.get(owner)}` : d.text;
    return { ...d, text, actor: actorId ? (actors.get(actorId) ?? null) : null };
  });
}
