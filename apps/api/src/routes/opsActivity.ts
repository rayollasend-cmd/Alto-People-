import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAnyCapability } from '../middleware/auth.js';
import { scopeShifts, scopeWhere } from '../lib/scope.js';

/**
 * GET /ops-activity?days=7 — what happened on the floor, newest first:
 * call-outs, weeks published, swaps decided, incidents reported. The admin
 * home's "Recent activity" used to be the audit log, which on most days is
 * a list of sign-ins. This is the operational record, each row linking to
 * where it's worked. Everything is read through the caller's shift reach.
 */
export const opsActivityRouter = Router();

const READ = requireAnyCapability('manage:scheduling', 'manage:time', 'view:executive', 'view:analytics');

export type OpsActivityKind = 'call_out' | 'published' | 'swap' | 'incident';
export interface OpsActivityItem {
  id: string;
  kind: OpsActivityKind;
  at: string;
  title: string;
  detail: string | null;
  href: string;
}

const name = (a: { firstName: string; lastName: string } | null | undefined) => (a ? `${a.firstName} ${a.lastName}` : 'Someone');
const SWAP_DONE = ['MANAGER_APPROVED', 'MANAGER_REJECTED'] as const;

opsActivityRouter.get('/', READ, async (req, res, next) => {
  try {
    const days = z.coerce.number().int().min(1).max(31).default(7).parse(req.query.days ?? 7);
    const since = new Date(Date.now() - days * 86_400_000);
    const shiftScope = scopeShifts(req.user!);
    const shiftIn = (extra: Prisma.ShiftWhereInput = {}) => scopeWhere<Prisma.ShiftWhereInput>(shiftScope, extra);
    // Incidents carry no shift: read them only where the reach is the
    // whole company or one client — never guessed for a site-bound office.
    const keys = Object.keys(shiftScope);
    const incidentScope: Prisma.OshaIncidentWhereInput | null =
      keys.length === 0
        ? {}
        : keys.every((k) => k === 'tenantId' || k === 'clientId') && 'clientId' in shiftScope && typeof shiftScope.clientId === 'string'
          ? { clientId: shiftScope.clientId }
          : null;

    const [callOuts, swaps, published, incidents] = await Promise.all([
      prisma.callOut.findMany({
        where: { createdAt: { gte: since }, shift: { is: shiftIn() } },
        orderBy: { createdAt: 'desc' },
        take: 25,
        select: {
          id: true,
          createdAt: true,
          status: true,
          minutesBeforeStart: true,
          associate: { select: { firstName: true, lastName: true } },
          shift: { select: { id: true, position: true, startsAt: true, assignedAssociateId: true, location: true } },
        },
      }),
      prisma.shiftSwapRequest.findMany({
        where: { decidedAt: { gte: since }, status: { in: [...SWAP_DONE] }, shift: { is: shiftIn() } },
        orderBy: { decidedAt: 'desc' },
        take: 25,
        select: {
          id: true,
          decidedAt: true,
          status: true,
          requester: { select: { firstName: true, lastName: true } },
          counterparty: { select: { firstName: true, lastName: true } },
          shift: { select: { position: true, startsAt: true } },
        },
      }),
      // A publish writes one timestamp across its batch: one row per batch.
      prisma.shift.groupBy({
        by: ['clientId', 'publishedAt'],
        where: shiftIn({ publishedAt: { gte: since } }),
        _count: { _all: true },
        _min: { startsAt: true },
        orderBy: { publishedAt: 'desc' },
        take: 25,
      }),
      incidentScope
        ? prisma.oshaIncident.findMany({
            where: { ...incidentScope, reportedAt: { gte: since } },
            orderBy: { reportedAt: 'desc' },
            take: 25,
            select: { id: true, reportedAt: true, severity: true, description: true, location: true },
          })
        : Promise.resolve([]),
    ]);
    const clientIds = [...new Set(published.map((p) => p.clientId).filter((x): x is string => !!x))];
    const clients = clientIds.length
      ? await prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, name: true } })
      : [];
    const clientName = new Map(clients.map((c) => [c.id, c.name]));

    const items: OpsActivityItem[] = [
      ...callOuts.map((c) => ({
        id: `callout:${c.id}`,
        kind: 'call_out' as const,
        at: c.createdAt.toISOString(),
        title: `${name(c.associate)} called out`,
        detail: `${c.shift.position}${c.shift.location ? ` · ${c.shift.location}` : ''} · ${c.shift.assignedAssociateId ? 'covered' : 'needs cover'}`,
        href: `/call-outs?callout=${c.id}`,
      })),
      ...swaps.map((s) => ({
        id: `swap:${s.id}`,
        kind: 'swap' as const,
        at: (s.decidedAt ?? new Date()).toISOString(),
        title: `Swap ${s.status === 'MANAGER_APPROVED' ? 'approved' : 'declined'}: ${name(s.requester)} → ${name(s.counterparty)}`,
        detail: s.shift.position,
        href: '/approvals?tab=swaps',
      })),
      ...published
        .filter((p) => p.publishedAt !== null)
        .map((p) => ({
          id: `published:${p.clientId ?? 'company'}:${p.publishedAt!.toISOString()}`,
          kind: 'published' as const,
          at: p.publishedAt!.toISOString(),
          title: `${p._count._all} ${p._count._all === 1 ? 'shift' : 'shifts'} published`,
          detail: p.clientId ? (clientName.get(p.clientId) ?? null) : null,
          href: p._min.startsAt ? `/scheduling?view=week&date=${p._min.startsAt.toISOString().slice(0, 10)}` : '/scheduling',
        })),
      ...incidents.map((i) => ({
        id: `incident:${i.id}`,
        kind: 'incident' as const,
        at: i.reportedAt.toISOString(),
        title: `Incident reported · ${i.severity.toLowerCase().replace(/_/g, ' ')}`,
        detail: [i.location, i.description.slice(0, 80)].filter(Boolean).join(' · ') || null,
        href: '/compliance/osha',
      })),
    ]
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, 30);
    res.json({ days, items });
  } catch (err) {
    next(err);
  }
});
