import { Router } from 'express';
import type { Request } from 'express';
import {
  can,
  ClientContactInputSchema,
  ClientContactUpdateInputSchema,
  type ClientContact,
  type ClientOverview,
  type ClientOverviewLocation,
  type ClientOwnerOption,
} from '@alto-people/shared';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { scopeClients } from '../lib/scope.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { enqueueAudit } from '../lib/audit.js';
import { activeBreakdown, placements } from '../lib/activeDefinition.js';
import { clientMetrics } from '../lib/clientMetrics.js';
import { clientNeedsYou, daysUntil } from '../lib/clientNeedsYou.js';
import { clientActivity } from '../lib/clientActivity.js';
import { canOwnAccounts, OWNER_SELECT, ownerName } from '../lib/clientAccountFields.js';
import { orgDateKey } from '../lib/timeAnomalies.js';

/**
 * The client's account (CL-A, 2026-10-22), mounted under /clients beside
 * routes/clients.ts and behind the same gate (view:clients):
 *
 *   GET    /clients/:id/overview            how the account is doing and what needs you
 *   GET    /clients/:id/contacts            the people at the client
 *   POST   /clients/:id/contacts            manage:clients
 *   PATCH  /clients/:id/contacts/:cid       manage:clients
 *   DELETE /clients/:id/contacts/:cid       manage:clients (soft)
 *   GET    /clients/:id/owner-options       manage:clients — who may own the account
 *
 * Every read loads the client through scopeClients AND the tenant (never a
 * spread), so a site-limited account reads only clients with a site in its
 * reach and anything else is a 404. Money (outstanding, aging, billed,
 * margin) rides only for statements readers (process:payroll or
 * view:executive), omitted — never zero — for everyone else.
 */
export const clientAccountRouter = Router();

const MANAGE = requireCapability('manage:clients');
const DAY_MS = 86_400_000;
const TOP_LOCATIONS = 5;

const canSeeMoney = (req: Request) => can(req.user!, 'process:payroll') || can(req.user!, 'view:executive');

async function loadClient<S extends Prisma.ClientSelect>(req: Request, select: S) {
  const client = await prisma.client.findFirst({
    where: { AND: [scopeClients(req.user!), { id: req.params.id, tenantId: tenantIdForWrite() }] },
    select,
  });
  if (!client) throw new HttpError(404, 'client_not_found', 'Client not found');
  return client;
}

function auditContact(req: Request, action: string, clientId: string, contactId: string, metadata: Record<string, unknown>) {
  enqueueAudit(
    {
      actorUserId: req.user!.id,
      clientId,
      action,
      entityType: 'ClientContact',
      entityId: contactId,
      metadata: { ip: req.ip ?? null, ...metadata },
    },
    `clientAccount.${action}`,
  );
}

type ContactRow = Prisma.ClientContactGetPayload<object>;
export const contactRow = (c: ContactRow): ClientContact => ({
  id: c.id,
  clientId: c.clientId,
  name: c.name,
  title: c.title,
  email: c.email,
  phone: c.phone,
  role: c.role,
  isPrimary: c.isPrimary,
  notes: c.notes,
  createdAt: c.createdAt.toISOString(),
  updatedAt: c.updatedAt.toISOString(),
});

/** Primary first, then by name. */
const CONTACT_ORDER: Prisma.ClientContactOrderByWithRelationInput[] = [{ isPrimary: 'desc' }, { name: 'asc' }, { id: 'asc' }];

async function liveContacts(clientId: string) {
  return prisma.clientContact.findMany({
    where: { tenantId: tenantIdForWrite(), clientId, deletedAt: null },
    orderBy: CONTACT_ORDER,
    take: 200,
  });
}

/* ----- Contacts ------------------------------------------------------------ */

clientAccountRouter.get('/:id/contacts', async (req, res, next) => {
  try {
    const client = await loadClient(req, { id: true });
    res.json({ contacts: (await liveContacts(client.id)).map(contactRow) });
  } catch (err) {
    next(err);
  }
});

clientAccountRouter.post('/:id/contacts', MANAGE, async (req, res, next) => {
  try {
    const input = ClientContactInputSchema.parse(req.body ?? {});
    const client = await loadClient(req, { id: true });
    const tenantId = tenantIdForWrite();
    const row = await prisma.$transaction(async (tx) => {
      // The first contact is the primary unless told otherwise; one primary per client.
      const others = await tx.clientContact.count({ where: { tenantId, clientId: client.id, deletedAt: null } });
      const isPrimary = input.isPrimary ?? others === 0;
      if (isPrimary) await tx.clientContact.updateMany({ where: { tenantId, clientId: client.id, isPrimary: true }, data: { isPrimary: false } });
      return tx.clientContact.create({
        data: {
          tenantId,
          clientId: client.id,
          name: input.name,
          title: input.title ?? null,
          email: input.email ?? null,
          phone: input.phone ?? null,
          role: input.role ?? 'OTHER',
          isPrimary,
          notes: input.notes ?? null,
        },
      });
    });
    auditContact(req, 'client.contact_added', client.id, row.id, { name: row.name, title: row.title, role: row.role, isPrimary: row.isPrimary });
    res.status(201).json({ contact: contactRow(row) });
  } catch (err) {
    next(err);
  }
});

clientAccountRouter.patch('/:id/contacts/:cid', MANAGE, async (req, res, next) => {
  try {
    const input = ClientContactUpdateInputSchema.parse(req.body ?? {});
    const client = await loadClient(req, { id: true });
    const tenantId = tenantIdForWrite();
    const existing = await prisma.clientContact.findFirst({ where: { id: req.params.cid, tenantId, clientId: client.id, deletedAt: null } });
    if (!existing) throw new HttpError(404, 'contact_not_found', 'Contact not found');
    const data: Prisma.ClientContactUncheckedUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.title !== undefined) data.title = input.title;
    if (input.email !== undefined) data.email = input.email;
    if (input.phone !== undefined) data.phone = input.phone;
    if (input.role !== undefined) data.role = input.role;
    if (input.notes !== undefined) data.notes = input.notes;
    if (input.isPrimary !== undefined) data.isPrimary = input.isPrimary;
    const row = await prisma.$transaction(async (tx) => {
      if (input.isPrimary === true && !existing.isPrimary) {
        await tx.clientContact.updateMany({ where: { tenantId, clientId: client.id, isPrimary: true, id: { not: existing.id } }, data: { isPrimary: false } });
      }
      return tx.clientContact.update({ where: { id: existing.id }, data });
    });
    auditContact(req, input.isPrimary === true && !existing.isPrimary ? 'client.contact_made_primary' : 'client.contact_updated', client.id, row.id, { name: row.name, changed: Object.keys(data) });
    res.json({ contact: contactRow(row) });
  } catch (err) {
    next(err);
  }
});

clientAccountRouter.delete('/:id/contacts/:cid', MANAGE, async (req, res, next) => {
  try {
    const client = await loadClient(req, { id: true });
    const existing = await prisma.clientContact.findFirst({ where: { id: req.params.cid, tenantId: tenantIdForWrite(), clientId: client.id, deletedAt: null } });
    if (!existing) throw new HttpError(404, 'contact_not_found', 'Contact not found');
    // A removed primary stops being one, so the client can name the next.
    await prisma.clientContact.update({ where: { id: existing.id }, data: { deletedAt: new Date(), isPrimary: false } });
    auditContact(req, 'client.contact_removed', client.id, existing.id, { name: existing.name, wasPrimary: existing.isPrimary });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/* ----- Owner options -------------------------------------------------------- */

clientAccountRouter.get('/:id/owner-options', MANAGE, async (req, res, next) => {
  try {
    await loadClient(req, { id: true });
    const users = await prisma.user.findMany({
      where: { tenantId: tenantIdForWrite(), deletedAt: null, status: 'ACTIVE', role: { notIn: ['CLIENT_PORTAL', 'ASSOCIATE', 'LIVE_ASN', 'DRIVER', 'SHIFT_SUPERVISOR', 'FLOOR_SUPERVISOR'] } },
      select: OWNER_SELECT,
      take: 1000,
    });
    const options: ClientOwnerOption[] = users
      .filter(canOwnAccounts)
      .map((u) => ({ id: u.id, name: ownerName(u), email: u.email, role: u.role }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ options });
  } catch (err) {
    next(err);
  }
});

/* ----- Overview ------------------------------------------------------------- */

/** On assignment per store, by the one definition (lib/activeDefinition), placed as the clients list places them. */
async function onAssignmentByLocation(clientId: string, tenantId: string, now: Date): Promise<Map<string, number>> {
  const placed = await placements({ clientId, tenantId });
  if (placed.size === 0) return new Map();
  const breakdown = await activeBreakdown(now, prisma, undefined, { tenantId, associateIds: [...placed.keys()] });
  const out = new Map<string, number>();
  for (const [, p] of breakdown.placements) {
    if (p.clientId === clientId && p.locationId) out.set(p.locationId, (out.get(p.locationId) ?? 0) + 1);
  }
  return out;
}

clientAccountRouter.get('/:id/overview', async (req, res, next) => {
  try {
    const now = new Date();
    const tenantId = tenantIdForWrite();
    const money = canSeeMoney(req);
    const client = await loadClient(req, {
      id: true,
      name: true,
      accountOwnerUserId: true,
      contractStartDate: true,
      contractEndDate: true,
      paymentTermsDays: true,
      targetMarginPct: true,
    });

    // This calendar month on the company's clock, for "billed this month".
    const today = orgDateKey(now);
    const range = { from: new Date(`${today.slice(0, 8)}01T00:00:00.000Z`), to: new Date(`${today}T00:00:00.000Z`) };

    const [contacts, metricsNow, metricsWeekAgo, sites, byLocation, owner] = await Promise.all([
      liveContacts(client.id),
      clientMetrics([client.id], { range, includeMoney: money, now }),
      // The same moment of last week: what "this week so far" is compared with.
      clientMetrics([client.id], { range, includeMoney: false, now: new Date(now.getTime() - 7 * DAY_MS) }),
      prisma.site.findMany({
        where: { tenantId, clientId: client.id, deletedAt: null, isActive: true },
        select: { id: true, name: true, city: true, state: true },
        orderBy: { name: 'asc' },
        take: 2000,
      }),
      onAssignmentByLocation(client.id, tenantId, now),
      client.accountOwnerUserId
        ? prisma.user.findFirst({ where: { id: client.accountOwnerUserId, tenantId }, select: OWNER_SELECT })
        : Promise.resolve(null),
    ]);

    const m = metricsNow.get(client.id) ?? null;
    const lastWeekToDate = metricsWeekAgo.get(client.id)?.hoursThisWeek ?? null;
    const kpis: ClientOverview['kpis'] = m
      ? {
          onAssignment: m.onAssignment,
          hoursThisWeek: m.hoursThisWeek,
          hoursLastWeek: m.hoursLastWeek,
          hoursLastWeekToDate: lastWeekToDate,
          hoursChangePct: lastWeekToDate && lastWeekToDate > 0 ? Math.round(((m.hoursThisWeek - lastWeekToDate) / lastWeekToDate) * 1000) / 10 : null,
          shiftsNext7: m.shiftsNext7,
          fillRatePct: m.fillRatePct,
          overtimePct: m.overtimePct,
          health: m.health,
          healthReasons: m.healthReasons,
          ...(money && m.money
            ? {
                money: {
                  outstanding: m.money.outstanding,
                  aging: m.money.aging,
                  billedThisMonth: m.money.billedInRange,
                  lastStatementTotal: m.money.lastStatementTotal,
                  lastStatementAt: m.money.lastStatementAt,
                  marginPct: m.money.marginPct,
                  targetMarginPct: client.targetMarginPct === null ? null : Number(client.targetMarginPct),
                },
              }
            : {}),
        }
      : null;

    // The stores with the most people on assignment first.
    const locationItems: ClientOverviewLocation[] = sites
      .map((s) => ({ id: s.id, name: s.name, city: s.city, state: s.state, onAssignment: byLocation.get(s.id) ?? 0 }))
      .sort((a, b) => b.onAssignment - a.onAssignment || a.name.localeCompare(b.name))
      .slice(0, TOP_LOCATIONS);

    const hasPrimaryContact = contacts.some((c) => c.isPrimary);
    const canSeeRelay = can(req.user!, 'view:org');
    const [needsYou, recentActivity] = await Promise.all([
      clientNeedsYou({
        client: { id: client.id, name: client.name, contractEndDate: client.contractEndDate, accountOwnerUserId: client.accountOwnerUserId },
        tenantId,
        now,
        canSeeMoney: money,
        canManage: can(req.user!, 'manage:clients'),
        canSeeNps: can(req.user!, 'view:executive') || can(req.user!, 'view:marketing'),
        canSeeRelay,
        hasPrimaryContact,
      }),
      clientActivity({ clientId: client.id, tenantId, canSeeMoney: money, canSeeRelay }),
    ]);

    const end = client.contractEndDate ? client.contractEndDate.toISOString().slice(0, 10) : null;
    const body: ClientOverview = {
      clientId: client.id,
      asOf: now.toISOString(),
      canSeeMoney: money,
      kpis,
      needsYou,
      contacts: contacts.map(contactRow),
      locations: { count: sites.length, items: locationItems },
      owner: owner ? { id: owner.id, name: ownerName(owner), email: owner.email } : null,
      contract: {
        start: client.contractStartDate ? client.contractStartDate.toISOString().slice(0, 10) : null,
        end,
        daysLeft: end ? daysUntil(end, now) : null,
      },
      paymentTermsDays: client.paymentTermsDays,
      recentActivity,
    };
    res.json(body);
  } catch (err) {
    next(err);
  }
});
