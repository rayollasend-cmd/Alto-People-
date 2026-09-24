import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { hasCapability, type Capability, type Role, type SearchGroup, type SearchHit, type SearchKind } from '@alto-people/shared';
import { prisma } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

export const searchRouter = Router();

/**
 * UNIVERSAL SEARCH — one query, every record it could mean.
 *
 * ⌘K used to reach pages, people and clients. A store manager's name, a
 * pallet-of-dairy handover, "the Destin statement", a filename someone
 * uploaded last week — each lived behind a different list with its own
 * search box. This answers all of them at once, grouped by kind, each
 * group gated by the same capability that gates its page, so a hit can
 * never reveal a record the person could not open.
 *
 * Every group is a bounded, indexed-prefix-friendly query with its own
 * limit; the groups run in parallel and the response is the union. It is
 * deliberately not full-text: a two-character prefix on a name is what
 * people type into a palette, and a `contains` over a few thousand rows
 * per kind is cheap. Nothing here paginates — a palette shows five.
 */

const MIN_QUERY = 2;
const MAX_LIMIT = 10;
const SHIFT_LOOKBACK_DAYS = 7;

const ci = (q: string): Prisma.StringFilter => ({ contains: q, mode: 'insensitive' });
const ymd = (d: Date) => d.toISOString().slice(0, 10);

type Finder = (q: string, limit: number) => Promise<SearchHit[]>;

const FINDERS: { kind: SearchKind; cap: Capability | null; find: Finder }[] = [
  {
    kind: 'people',
    cap: 'view:org',
    find: async (q, limit) => {
      const rows = await prisma.associate.findMany({
        where: { deletedAt: null, OR: [{ firstName: ci(q) }, { lastName: ci(q) }, { email: ci(q) }] },
        select: { id: true, firstName: true, lastName: true, email: true },
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
        take: limit,
      });
      return rows.map((r) => ({ id: r.id, title: `${r.firstName} ${r.lastName}`.trim(), hint: r.email, href: `/people?associateId=${r.id}` }));
    },
  },
  {
    kind: 'clients',
    cap: 'view:clients',
    find: async (q, limit) => {
      const rows = await prisma.client.findMany({
        where: { deletedAt: null, name: ci(q) },
        select: { id: true, name: true, status: true },
        orderBy: { name: 'asc' },
        take: limit,
      });
      return rows.map((r) => ({ id: r.id, title: r.name, hint: r.status === 'ACTIVE' ? null : r.status.toLowerCase(), href: `/clients/${r.id}` }));
    },
  },
  {
    kind: 'locations',
    cap: 'view:clients',
    find: async (q, limit) => {
      const rows = await prisma.location.findMany({
        where: { deletedAt: null, name: ci(q), client: { deletedAt: null } },
        select: { id: true, name: true, clientId: true, client: { select: { name: true } } },
        orderBy: { name: 'asc' },
        take: limit,
      });
      return rows.map((r) => ({ id: r.id, title: r.name, hint: r.client.name, href: `/clients/${r.clientId}?section=locations` }));
    },
  },
  {
    kind: 'applications',
    cap: 'view:onboarding',
    find: async (q, limit) => {
      const rows = await prisma.application.findMany({
        where: {
          deletedAt: null,
          OR: [
            { position: ci(q) },
            { associate: { firstName: ci(q) } },
            { associate: { lastName: ci(q) } },
            { associate: { email: ci(q) } },
          ],
        },
        select: {
          id: true,
          status: true,
          position: true,
          associate: { select: { firstName: true, lastName: true } },
          client: { select: { name: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      });
      return rows.map((r) => ({
        id: r.id,
        title: `${r.associate.firstName} ${r.associate.lastName}`.trim(),
        hint: [r.client.name, r.position, r.status.toLowerCase().replace('_', ' ')].filter(Boolean).join(' · '),
        href: `/onboarding/applications/${r.id}`,
      }));
    },
  },
  {
    kind: 'shifts',
    cap: 'view:scheduling',
    find: async (q, limit) => {
      const since = new Date(Date.now() - SHIFT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
      const rows = await prisma.shift.findMany({
        where: { startsAt: { gte: since }, OR: [{ position: ci(q) }, { client: { name: ci(q) } }, { assignedAssociate: { lastName: ci(q) } }] },
        select: { id: true, position: true, startsAt: true, status: true, clientId: true, client: { select: { name: true } } },
        orderBy: { startsAt: 'asc' },
        take: limit,
      });
      return rows.map((r) => ({
        id: r.id,
        title: `${r.position} — ${r.client.name}`,
        hint: `${ymd(r.startsAt)} · ${r.status.toLowerCase()}`,
        href: `/scheduling?view=week&week=${ymd(r.startsAt)}&client=${r.clientId}`,
      }));
    },
  },
  {
    kind: 'documents',
    cap: 'view:documents',
    find: async (q, limit) => {
      const rows = await prisma.documentRecord.findMany({
        where: { OR: [{ filename: ci(q) }, { associate: { lastName: ci(q) } }, { associate: { firstName: ci(q) } }] },
        select: { id: true, filename: true, kind: true, status: true, associateId: true, associate: { select: { firstName: true, lastName: true } } },
        orderBy: { createdAt: 'desc' },
        take: limit,
      });
      return rows.map((r) => ({
        id: r.id,
        title: r.filename,
        hint: `${r.associate.firstName} ${r.associate.lastName} · ${r.kind.toLowerCase().replace(/_/g, ' ')} · ${r.status.toLowerCase()}`,
        href: `/people?associateId=${r.associateId}&tab=documents`,
      }));
    },
  },
  {
    kind: 'statements',
    cap: 'view:clients',
    find: async (q, limit) => {
      const rows = await prisma.clientStatement.findMany({
        where: { client: { name: ci(q), deletedAt: null } },
        select: { id: true, periodStart: true, periodEnd: true, status: true, number: true, client: { select: { name: true } } },
        orderBy: { periodStart: 'desc' },
        take: limit,
      });
      return rows.map((r) => ({
        id: r.id,
        title: `${r.client.name} — ${ymd(r.periodStart)} to ${ymd(r.periodEnd)}`,
        hint: r.status === 'FINAL' && r.number != null ? `No. ${String(r.number).padStart(4, '0')}` : 'draft',
        href: `/clients/statements?statement=${r.id}`,
      }));
    },
  },
  {
    kind: 'help',
    cap: null,
    find: async (q, limit) => {
      const rows = await prisma.kbArticle.findMany({
        where: { status: 'PUBLISHED', title: ci(q) },
        select: { id: true, title: true, slug: true, category: true },
        orderBy: { title: 'asc' },
        take: limit,
      });
      return rows.map((r) => ({ id: r.id, title: r.title, hint: r.category, href: `/help-center?article=${encodeURIComponent(r.slug)}` }));
    },
  },
];

/** GET /search?q=&limit=5 — grouped hits for what the caller may see. */
searchRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const q = String(req.query.q ?? '').trim();
    if (q.length < MIN_QUERY) {
      res.status(400).json({ error: 'query_too_short', minLength: MIN_QUERY });
      return;
    }
    const limit = Math.min(Math.max(Number(req.query.limit) || 5, 1), MAX_LIMIT);
    const role = req.user!.role as Role;
    const allowed = FINDERS.filter((f) => f.cap === null || hasCapability(role, f.cap));
    const results = await Promise.all(allowed.map((f) => f.find(q, limit)));
    const groups: SearchGroup[] = allowed
      .map((f, i) => ({ kind: f.kind, hits: results[i]! }))
      .filter((g) => g.hits.length > 0);
    res.json({ groups });
  } catch (err) {
    next(err);
  }
});
