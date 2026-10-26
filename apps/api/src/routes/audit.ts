import { Router } from 'express';
import { z } from 'zod';
import type { AuditSearchEntry, AuditSearchResponse } from '@alto-people/shared';
import { AUDIT_CATEGORIES, AUDIT_CATEGORY_DEFS, AUDIT_SYSTEM_ENTITY, AUDIT_SYSTEM_PREFIX, csvCell as sharedCsvCell } from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import type { Prisma } from '@prisma/client';
import { requireCapability } from '../middleware/auth.js';
import { recordCriticalAudit } from '../lib/audit.js';
import { MIN_RETENTION_YEARS, retentionYearsFor, verifyAuditChain } from '../lib/auditChain.js';
import { createAuditSink } from '../lib/auditSink.js';
import { fmtDateSpan } from '../lib/floorLeads.js';

export const auditRouter = Router();

const PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;
const CSV_MAX_ROWS = 50_000;

const FilterSchema = z.object({
  action: z.string().trim().min(1).max(80).optional(),
  entityType: z.string().trim().min(1).max(80).optional(),
  entityId: z.string().trim().min(1).max(80).optional(),
  actorUserId: z.string().uuid().optional(),
  clientId: z.string().uuid().optional(),
  /** ISO datetime — inclusive lower bound. */
  since: z.string().datetime().optional(),
  /** ISO datetime — exclusive upper bound. Drives cursor pagination. */
  before: z.string().datetime().optional(),
  /** Free-text fragment — the action, the record's id or the actor's email contains it. Case-insensitive. */
  q: z.string().trim().min(1).max(80).optional(),
  /** One of the reviewer's categories (shared auditLog.ts): Sign-ins, Data changes, Exports… */
  category: z.enum(AUDIT_CATEGORIES).optional(),
  /** "1": leave out the API's own request trail (http.* on HttpRequest). */
  hideSystem: z.enum(['1', '0', 'true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
});

type Filters = z.infer<typeof FilterSchema>;

function buildWhere(f: Filters): Prisma.AuditLogWhereInput {
  // Brief 2-3 step 1: the viewer and the CSV read only the caller's tenant (explicit while TENANCY_MODE observes).
  const where: Prisma.AuditLogWhereInput = { tenantId: tenantIdForWrite() };
  const and: Prisma.AuditLogWhereInput[] = [];
  if (f.action) where.action = f.action;
  if (f.entityType) where.entityType = f.entityType;
  if (f.entityId) where.entityId = f.entityId;
  if (f.actorUserId) where.actorUserId = f.actorUserId;
  if (f.clientId) where.clientId = f.clientId;
  if (f.q) {
    // One search box (F500 G4): the event, the record's id or email, or who did it.
    and.push({
      OR: [
        { action: { contains: f.q, mode: 'insensitive' } },
        { entityId: { contains: f.q, mode: 'insensitive' } },
        { actorUser: { email: { contains: f.q, mode: 'insensitive' } } },
      ],
    });
  }
  if (f.category) {
    const def = AUDIT_CATEGORY_DEFS[f.category];
    const or: Prisma.AuditLogWhereInput[] = def.prefixes.map((p) => ({ action: { startsWith: p } }));
    if (def.contains) or.push({ action: { contains: def.contains } });
    and.push({ OR: or });
  }
  if (f.hideSystem === '1' || f.hideSystem === 'true') {
    and.push({ NOT: { action: { startsWith: AUDIT_SYSTEM_PREFIX } } }, { NOT: { entityType: AUDIT_SYSTEM_ENTITY } });
    // An assistant's question-and-reply pair is chatter, not a change: it buried the
    // sign-ins under "Hugo asked / Agent app reply" rows. Its tasks stay (they act).
    and.push({ NOT: { action: { in: [...AUDIT_CHATTER_ACTIONS] } } });
  }
  const createdAt: Prisma.DateTimeFilter = {};
  if (f.since) createdAt.gte = new Date(f.since);
  if (f.before) createdAt.lt = new Date(f.before);
  if (Object.keys(createdAt).length > 0) where.createdAt = createdAt;
  if (and.length) where.AND = and;
  return where;
}

type LabelledRow = { entityType: string; entityId: string; metadata: unknown };

/**
 * The records' names, so a row reads "Maria Lopez", not "5f4d1dea-c053…"
 * (F500 G4). One lookup per entity type on the page, each inside the
 * caller's tenant — a row can only ever be named from its own tenant's
 * records, and an id that doesn't resolve stays unnamed.
 */
async function entityLabels(rows: LabelledRow[], tenantId: string): Promise<Map<string, { label: string; href: string | null }>> {
  const out = new Map<string, { label: string; href: string | null }>();
  const key = (t: string, id: string) => `${t}:${id}`;
  const idsOf = (type: string) => [...new Set(rows.filter((r) => r.entityType === type && UUID.test(r.entityId)).map((r) => r.entityId))];
  const personName = (a: { firstName: string; lastName: string } | null | undefined) => (a ? `${a.firstName} ${a.lastName}`.trim() : '');

  const users = idsOf('User');
  const associates = idsOf('Associate');
  const applications = idsOf('Application');
  const clients = idsOf('Client');
  const locations = [...new Set([...idsOf('Location'), ...idsOf('Site')])];
  const orgUnits = idsOf('OrgUnit');
  const prospects = idsOf('ClientProspect');
  const runs = idsOf('PayrollRun');
  const [u, a, ap, c, l, o, pr, rn] = await Promise.all([
    users.length ? prisma.user.findMany({ where: { id: { in: users }, tenantId }, select: { id: true, email: true, displayName: true, associate: { select: { firstName: true, lastName: true } } } }) : [],
    associates.length ? prisma.associate.findMany({ where: { id: { in: associates }, tenantId }, select: { id: true, firstName: true, lastName: true } }) : [],
    applications.length ? prisma.application.findMany({ where: { id: { in: applications }, tenantId }, select: { id: true, associate: { select: { firstName: true, lastName: true } } } }) : [],
    clients.length ? prisma.client.findMany({ where: { id: { in: clients }, tenantId }, select: { id: true, name: true } }) : [],
    locations.length ? prisma.site.findMany({ where: { id: { in: locations }, tenantId }, select: { id: true, name: true } }) : [],
    orgUnits.length ? prisma.orgUnit.findMany({ where: { id: { in: orgUnits }, tenantId }, select: { id: true, name: true } }) : [],
    prospects.length ? prisma.clientProspect.findMany({ where: { id: { in: prospects }, tenantId }, select: { id: true, name: true } }) : [],
    runs.length ? prisma.payrollRun.findMany({ where: { id: { in: runs }, tenantId }, select: { id: true, periodStart: true, periodEnd: true } }) : [],
  ]);
  for (const x of u) out.set(key('User', x.id), { label: x.displayName?.trim() || personName(x.associate) || x.email, href: null });
  for (const x of a) out.set(key('Associate', x.id), { label: personName(x), href: `/people/${x.id}` });
  for (const x of ap) out.set(key('Application', x.id), { label: personName(x.associate) ? `${personName(x.associate)}'s onboarding` : 'Onboarding', href: `/onboarding/applications/${x.id}` });
  for (const x of c) out.set(key('Client', x.id), { label: x.name, href: `/clients/${x.id}` });
  for (const x of l) {
    out.set(key('Location', x.id), { label: x.name, href: null });
    out.set(key('Site', x.id), { label: x.name, href: null });
  }
  for (const x of o) out.set(key('OrgUnit', x.id), { label: x.name, href: null });
  for (const x of pr) out.set(key('ClientProspect', x.id), { label: x.name, href: null });
  for (const x of rn) out.set(key('PayrollRun', x.id), { label: `Payroll run · ${fmtDateSpan(x.periodStart.toISOString().slice(0, 10), x.periodEnd.toISOString().slice(0, 10))}`, href: `/payroll/runs/${x.id}/review` });
  // The organization itself (an operator opening it, a profile change): only ever the caller's own.
  if (rows.some((r) => r.entityType === 'Tenant' && r.entityId === tenantId)) {
    const t = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } });
    if (t) out.set(key('Tenant', tenantId), { label: t.name, href: '/admin/organization' });
  }
  // Hugo's own rows (routes/hugo.ts, lib/hugoTasks, lib/hugoNotes) said in words, never a code
  // ("Hugo TASK_FIN…", "HugoTask 6db1be26…" — F500 audit 2026-10-26). Tasks and notes are their
  // person's own and have no page an auditor can open.
  const hugoTasks = idsOf('HugoTask');
  const hugoNotes = idsOf('HugoNote');
  const [ht, hn] = await Promise.all([
    hugoTasks.length ? prisma.hugoTask.findMany({ where: { id: { in: hugoTasks }, tenantId }, select: { id: true, kind: true } }) : [],
    hugoNotes.length ? prisma.hugoNote.findMany({ where: { id: { in: hugoNotes }, tenantId }, select: { id: true, kind: true } }) : [],
  ]);
  for (const x of ht) out.set(key('HugoTask', x.id), { label: `Hugo task · ${HUGO_KIND_LABEL[x.kind] ?? humanizeCode(x.kind)}`, href: null });
  for (const x of hn) out.set(key('HugoNote', x.id), { label: `Hugo note · ${HUGO_KIND_LABEL[x.kind] ?? humanizeCode(x.kind)}`, href: null });
  for (const r of rows) {
    if (r.entityType === 'Hugo') out.set(key('Hugo', r.entityId), { label: `Hugo · ${r.entityId === 'MODEL' ? 'Open question' : humanizeCode(r.entityId)}`, href: null });
  }
  // The API's own request rows are keyed by the route: "POST /auth/login".
  for (const r of rows) {
    if (r.entityType !== AUDIT_SYSTEM_ENTITY) continue;
    const m = (r.metadata ?? {}) as { method?: unknown };
    out.set(key(r.entityType, r.entityId), { label: `${typeof m.method === 'string' ? `${m.method} ` : ''}${r.entityId}`, href: null });
  }
  return out;
}

/** Assistant conversation rows hidden with the system requests (routes/hugo.ts, lib/agents logBuiltInAgentAction). */
const AUDIT_CHATTER_ACTIONS = ['hugo.asked', 'agent.app.reply', 'agent.whatsapp.reply'] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const HUGO_KIND_LABEL: Record<string, string> = {
  WATCH_TIME_OFF: 'Time-off decision watch',
  WATCH_OPEN_SHIFTS: 'Open-shift watch',
  WATCH_PAYCHECK: 'Paycheck watch',
  WATCH_DOCUMENT: 'Document review watch',
  FIND_COVER: 'Find cover',
  CHASE_CONFIRMATIONS: 'Chase confirmations',
  CREDENTIAL_EXPIRING: 'Credential expiring',
  OPEN_SHIFT_MATCH: 'Open shift that fits',
  DIRECT_DEPOSIT_MISSING: 'Direct deposit missing',
  UNCONFIRMED_TOMORROW: 'Unconfirmed shifts tomorrow',
};

/** "TASK_FIND_COVER" → "Find cover", "HELP_CENTER" → "Help center". */
function humanizeCode(code: string): string {
  const words = code.replace(/^(TASK|DRIVER)_/, '').toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const ACTOR_SELECT = { email: true, displayName: true, associate: { select: { firstName: true, lastName: true } } } as const;
function actorNameOf(u: { email: string; displayName: string | null; associate: { firstName: string; lastName: string } | null } | null): string | null {
  if (!u) return null;
  const fromAssociate = u.associate ? `${u.associate.firstName} ${u.associate.lastName}`.trim() : '';
  return u.displayName?.trim() || fromAssociate || u.email;
}

function parseFilters(req: import('express').Request): Filters {
  const parsed = FilterSchema.safeParse(req.query);
  if (!parsed.success) {
    throw new HttpError(400, 'invalid_query', 'Invalid filters', parsed.error.flatten());
  }
  return parsed.data;
}

/**
 * GET /audit/logs
 * Cursor-paginated by createdAt DESC. Pass the prior page's `nextBefore`
 * back as `?before=…` to walk through older rows. Default page size 100.
 */
auditRouter.get('/logs', async (req, res, next) => {
  try {
    const f = parseFilters(req);
    const take = f.limit ?? PAGE_SIZE;

    const rows = await prisma.auditLog.findMany({
      where: buildWhere(f),
      orderBy: { createdAt: 'desc' },
      take,
      include: { actorUser: { select: ACTOR_SELECT } },
    });
    const labels = await entityLabels(rows, tenantIdForWrite());

    const entries: AuditSearchEntry[] = rows.map((r) => {
      const named = labels.get(`${r.entityType}:${r.entityId}`) ?? null;
      return {
        id: r.id,
        action: r.action,
        actorUserId: r.actorUserId,
        actorEmail: r.actorUser?.email ?? null,
        actorName: actorNameOf(r.actorUser),
        entityType: r.entityType,
        entityId: r.entityId,
        entityLabel: named?.label ?? null,
        entityHref: named?.href ?? null,
        clientId: r.clientId,
        metadata: (r.metadata as Record<string, unknown> | null) ?? null,
        createdAt: r.createdAt.toISOString(),
      };
    });

    const nextBefore =
      rows.length === take ? rows[rows.length - 1]!.createdAt.toISOString() : null;

    const body: AuditSearchResponse = { entries, nextBefore };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /audit/actors?q= — the people-picker behind the Actor filter (F500
 * G4): this tenant's accounts whose name or email matches, so a reviewer
 * picks "Maria Lopez" instead of pasting a user id. view:audit (the
 * router's gate); never another tenant's accounts.
 */
auditRouter.get('/actors', async (req, res, next) => {
  try {
    const { q, id } = z.object({ q: z.string().trim().max(80).optional(), id: z.string().uuid().optional() }).parse(req.query);
    const tenantId = tenantIdForWrite();
    const where: Prisma.UserWhereInput = { tenantId };
    if (id) where.id = id;
    else if (q) {
      where.OR = [
        { email: { contains: q, mode: 'insensitive' } },
        { displayName: { contains: q, mode: 'insensitive' } },
        { associate: { firstName: { contains: q, mode: 'insensitive' } } },
        { associate: { lastName: { contains: q, mode: 'insensitive' } } },
      ];
    }
    const users = await prisma.user.findMany({ where, select: { id: true, ...ACTOR_SELECT }, orderBy: { email: 'asc' }, take: 10 });
    res.json({ actors: users.map((u) => ({ id: u.id, email: u.email, name: actorNameOf(u) ?? u.email })) });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /audit/logs.csv
 * Same filters, no pagination — streams up to CSV_MAX_ROWS to keep the
 * response bounded. Sorted DESC by createdAt to match the table view.
 */
auditRouter.get('/logs.csv', async (req, res, next) => {
  try {
    const f = parseFilters(req);
    const rows = await prisma.auditLog.findMany({
      where: buildWhere(f),
      orderBy: { createdAt: 'desc' },
      take: CSV_MAX_ROWS,
      include: { actorUser: { select: { email: true } } },
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="alto-audit-${new Date().toISOString().slice(0, 10)}.csv"`
    );

    res.write('createdAt,action,actorEmail,entityType,entityId,clientId,metadata\n');
    for (const r of rows) {
      const cols = [
        r.createdAt.toISOString(),
        r.action,
        r.actorUser?.email ?? '',
        r.entityType,
        r.entityId,
        r.clientId ?? '',
        r.metadata ? JSON.stringify(r.metadata) : '',
      ].map(csvEscape);
      res.write(cols.join(',') + '\n');
    }
    res.end();
  } catch (err) {
    next(err);
  }
});

// Delegates to the shared escaper: RFC-4180 quoting PLUS formula-injection
// guarding. This export embeds raw JSON metadata, which is exactly where a
// crafted value would ride into a spreadsheet.
function csvEscape(v: string): string {
  return sharedCsvCell(v);
}

// ---------------------------------------------------------------------------
// Brief 2-3 step 4 — audit depth: the full export, the hash chain, retention,
// archives and the SIEM sink. Reads are view:audit (the router's gate);
// changes are manage:org.
// ---------------------------------------------------------------------------

const MANAGE = requireCapability('manage:org');

/**
 * GET /audit/export.csv — every row matching the filters, uncapped, streamed
 * in batches (an org admin's full extract). The chain columns ride along so
 * the file can be checked against the chain.
 */
auditRouter.get('/export.csv', MANAGE, async (req, res) => {
  const f = parseFilters(req);
  const where = buildWhere(f);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="alto-audit-full-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.write('seq,createdAt,action,actorEmail,entityType,entityId,clientId,metadata,hash\n');
  let cursor: { createdAt: Date; id: string } | null = null;
  for (;;) {
    const batch: Array<{ id: string; seq: bigint | null; createdAt: Date; action: string; entityType: string; entityId: string; clientId: string | null; metadata: unknown; hash: string | null; actorUser: { email: string } | null }> = await prisma.auditLog.findMany({
      where: cursor ? { AND: [where, { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] }] } : where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 5000,
      include: { actorUser: { select: { email: true } } },
    });
    for (const r of batch) {
      const cols = [r.seq === null ? '' : String(r.seq), r.createdAt.toISOString(), r.action, r.actorUser?.email ?? '', r.entityType, r.entityId, r.clientId ?? '', r.metadata ? JSON.stringify(r.metadata) : '', r.hash ?? ''].map(csvEscape);
      if (!res.write(cols.join(',') + '\n')) await new Promise((resolve) => res.once('drain', resolve));
    }
    if (batch.length < 5000) break;
    const last = batch[batch.length - 1]!;
    cursor = { createdAt: last.createdAt, id: last.id };
  }
  res.end();
});

const bigintSafe = <T extends Record<string, unknown>>(r: T) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? String(v) : v]));

/** GET /audit/integrity — the chain's last checks, retention, archives and the sink, for this tenant. */
auditRouter.get('/integrity', async (_req, res) => {
  const tenantId = tenantIdForWrite();
  const [checks, retentionYears, archives, sink] = await Promise.all([
    prisma.auditChainCheck.findMany({ where: { tenantId }, orderBy: { checkedAt: 'desc' }, take: 10 }),
    retentionYearsFor(prisma, tenantId),
    prisma.auditArchive.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' }, take: 20 }),
    prisma.auditSink.findUnique({ where: { tenantId }, include: { deliveries: { orderBy: { createdAt: 'desc' }, take: 10 } } }),
  ]);
  res.json({
    checks: checks.map(bigintSafe),
    retentionYears,
    minRetentionYears: MIN_RETENTION_YEARS,
    archives: archives.map(bigintSafe),
    sink: sink
      ? {
          id: sink.id,
          url: sink.url,
          enabled: sink.enabled,
          cursorSeq: String(sink.cursorSeq),
          failures: sink.failures,
          nextAttemptAt: sink.nextAttemptAt,
          lastDeliveredAt: sink.lastDeliveredAt,
          lastError: sink.lastError,
          deliveries: sink.deliveries.map(bigintSafe),
        }
      : null,
  });
});

/** POST /audit/integrity/verify — check this tenant's chain now. */
auditRouter.post('/integrity/verify', MANAGE, async (_req, res) => {
  const tenantId = tenantIdForWrite();
  const r = await verifyAuditChain(prisma, tenantId);
  await prisma.auditChainCheck.create({ data: { tenantId, rows: r.rows, headSeq: r.headSeq, headHash: r.headHash, ok: r.breaks.length === 0, breaks: r.breaks as unknown as Prisma.InputJsonArray } });
  res.json({ ok: r.breaks.length === 0, rows: r.rows, headSeq: r.headSeq === null ? null : String(r.headSeq), breaks: r.breaks });
});

/** PUT /audit/integrity/retention — { years }: never below the legal floor. */
auditRouter.put('/integrity/retention', MANAGE, async (req, res) => {
  const { years } = z.object({ years: z.number().int().min(MIN_RETENTION_YEARS).max(50) }).parse(req.body);
  const tenantId = tenantIdForWrite();
  const before = await retentionYearsFor(prisma, tenantId);
  await prisma.tenant.update({ where: { id: tenantId }, data: { auditRetentionYears: years } });
  await recordCriticalAudit({ actorUserId: req.user!.id, tenantId, action: 'audit.retention_changed', entityType: 'Tenant', entityId: tenantId, metadata: { before: { years: before }, after: { years } } }, 'audit.retention_changed');
  res.json({ retentionYears: years });
});

/** PUT /audit/integrity/sink — { url }: start (or re-key) the SIEM stream; the signing secret is shown once. */
auditRouter.put('/integrity/sink', MANAGE, async (req, res) => {
  const { url } = z.object({ url: z.string().url().max(500).startsWith('https://') }).parse(req.body);
  const tenantId = tenantIdForWrite();
  let made: { id: string; secret: string };
  try {
    made = await createAuditSink(prisma, tenantId, url, req.user!.id);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, 'unsafe_url', err instanceof Error ? err.message : 'That address cannot receive the stream.');
  }
  await recordCriticalAudit({ actorUserId: req.user!.id, tenantId, action: 'audit.sink_configured', entityType: 'AuditSink', entityId: made.id, metadata: { url } }, 'audit.sink_configured');
  res.json({ id: made.id, secret: made.secret });
});

/** POST /audit/integrity/sink/disable — stop the stream (the cursor is kept). */
auditRouter.post('/integrity/sink/disable', MANAGE, async (req, res) => {
  const tenantId = tenantIdForWrite();
  const sink = await prisma.auditSink.findUnique({ where: { tenantId } });
  if (!sink) throw new HttpError(404, 'not_found', 'No sink is configured.');
  await prisma.auditSink.update({ where: { id: sink.id }, data: { enabled: false } });
  await recordCriticalAudit({ actorUserId: req.user!.id, tenantId, action: 'audit.sink_disabled', entityType: 'AuditSink', entityId: sink.id, metadata: { url: sink.url } }, 'audit.sink_disabled');
  res.json({ ok: true });
});
