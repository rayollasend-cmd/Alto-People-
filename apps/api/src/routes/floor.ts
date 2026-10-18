import { Router } from 'express';
import multer from 'multer';
import { createHash, randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { z } from 'zod';
import { UPLOAD_MAX_BYTES, can, hasCapability, rolesWithCapability } from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireAnyCapability, requireAuth, requireCapability } from '../middleware/auth.js';
import type { SessionUser } from '../types/express.js';
import { enqueueAudit } from '../lib/audit.js';
import { getBlobStore } from '../lib/blobStore.js';
import { sanitizeUploadFilename, verifyFileMagic } from '../lib/uploads.js';
import { notifyAllAdmins, notifyClientSupervisors, notifyUser, trackNotificationWork } from '../lib/notify.js';
import { sendStubbed } from '../lib/notifications.js';
import { effectiveClientIdFilter } from '../lib/scope.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { ledWindows } from '../lib/shiftWindows.js';
import { dateKeyInZone } from '../lib/timeAnomalies.js';
import { runCoverFlow } from '../lib/coverShift.js';

/**
 * The floor — what a store's supervisors need in the moment, from a phone.
 *
 *   POST /floor/incidents            file an injury or incident at my own store, with a photo
 *   GET  /floor/incidents/:id/photo  the photo (HR, or the person who filed it)
 *   POST /floor/flags                a watch-only lead raises a no-show or a hazard — two taps
 *   GET  /floor/flags                the open flags at my store (the shift supervisor's Needs you)
 *   POST /floor/flags/:id/ack        acknowledged — the word reached the person who decides
 *   GET  /floor/week                 the next seven days at my store, as counts (watch-only sees past tomorrow)
 *   POST /floor/crew-text            one text to everyone on a shift at my store
 *   GET  /floor/handover             the last shift's handover notes, undecided, for the lead coming on
 *   POST /floor/cover/:shiftId       "Cover this shift": post it → ask the bench → the agent fills — one tap, with progress
 *
 * Every read and write is clamped to the caller's client when their role is
 * bounded (effectiveClientIdFilter); an org role names the client. None of
 * this reads money.
 */
export const floorRouter = Router();

const NO_CLIENT = '00000000-0000-0000-0000-000000000000';
const DAY_MS = 86_400_000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: UPLOAD_MAX_BYTES } });
const PHOTO_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);

/** The client this call is about: the bounded caller's own, else the one named. */
async function clientFor(user: SessionUser, requested: string | undefined): Promise<{ id: string; name: string }> {
  const clamped = effectiveClientIdFilter(user, requested);
  const id = clamped === null ? NO_CLIENT : clamped;
  if (!id) throw new HttpError(400, 'client_required', 'Name the client this is about.');
  const client = await prisma.client.findFirst({ where: { id, deletedAt: null }, select: { id: true, name: true } });
  if (!client) throw new HttpError(404, 'client_not_found', 'Client not found.');
  return client;
}

/** A person on the floor at this client, or 404 — never another store's. */
async function associateAtClient(associateId: string, clientId: string) {
  const a = await prisma.associate.findFirst({
    where: {
      id: associateId,
      deletedAt: null,
      OR: [
        { assignments: { some: { endedAt: null, location: { clientId } } } },
        { applications: { some: { clientId, status: 'APPROVED', deletedAt: null } } },
        { assignedShifts: { some: { clientId, startsAt: { gte: new Date(Date.now() - 30 * DAY_MS) } } } },
      ],
    },
    select: { id: true, firstName: true, lastName: true, phone: true },
  });
  if (!a) throw new HttpError(404, 'associate_not_found', 'That person is not on this floor.');
  return a;
}

/* ---- Incidents ----------------------------------------------------------- */

const IncidentBody = z.object({
  clientId: z.string().uuid().optional(),
  locationId: z.string().uuid().optional(),
  associateId: z.string().uuid().optional(),
  description: z.string().trim().min(5).max(2000),
  /** Where in the building, in the supervisor's words. */
  location: z.string().trim().max(200).optional(),
  occurredAt: z.string().datetime().optional(),
  /** The floor files what it saw; HR grades days away and restricted duty. */
  severity: z.enum(['FIRST_AID', 'MEDICAL_TREATMENT', 'RESTRICTED_DUTY', 'DAYS_AWAY']).default('FIRST_AID'),
  /** No one was hurt — a hazard, a near miss. Kept in the log, not recordable. */
  nearMiss: z.coerce.boolean().optional(),
});

floorRouter.post('/floor/incidents', requireCapability('report:incident'), upload.single('photo'), async (req, res, next) => {
  try {
    const user = req.user!;
    const parsed = IncidentBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    const i = parsed.data;
    const client = await clientFor(user, i.clientId);
    const associate = i.associateId ? await associateAtClient(i.associateId, client.id) : null;
    const site = i.locationId
      ? await prisma.site.findFirst({ where: { id: i.locationId, clientId: client.id, deletedAt: null }, select: { id: true } })
      : await prisma.site.findFirst({ where: { clientId: client.id, deletedAt: null, isActive: true }, select: { id: true }, take: 1 });

    let photoKey: string | null = null;
    if (req.file) {
      if (!PHOTO_MIMES.has(req.file.mimetype)) throw new HttpError(400, 'invalid_type', 'Photos must be PNG, JPEG, or WebP.');
      const magicError = verifyFileMagic(req.file.buffer, req.file.mimetype);
      if (magicError) throw new HttpError(400, 'invalid_file_contents', magicError);
      const cleanName = sanitizeUploadFilename(req.file.originalname);
      const sha = createHash('sha256').update(req.file.buffer).digest('hex').slice(0, 16);
      photoKey = `incidents/${randomUUID()}-${sha}${extname(cleanName).toLowerCase() || '.jpg'}`;
      await getBlobStore().put(photoKey, req.file.buffer, req.file.mimetype);
    }

    const created = await prisma.oshaIncident.create({
      data: {
        clientId: client.id,
        locationId: site?.id ?? null,
        associateId: associate?.id ?? null,
        occurredAt: i.occurredAt ? new Date(i.occurredAt) : new Date(),
        location: i.location ?? null,
        description: i.description,
        severity: i.severity,
        // 29 CFR 1904.7: first-aid-only and near misses are kept, not recorded.
        isRecordable: !i.nearMiss && i.severity !== 'FIRST_AID',
        reportedById: user.id,
        photoKey,
        tenantId: tenantIdForWrite(),
      },
      select: { id: true, severity: true, occurredAt: true, isRecordable: true },
    });
    enqueueAudit(
      { actorUserId: user.id, clientId: client.id, action: 'incident.reported_from_floor', entityType: 'OshaIncident', entityId: created.id, metadata: { severity: created.severity, nearMiss: !!i.nearMiss, photo: !!photoKey, associateId: associate?.id ?? null } },
      'floor.incident',
    );
    // HR hears at once — a recordable loudly, a hazard as a note in the log.
    const who = associate ? `${associate.firstName} ${associate.lastName}` : i.nearMiss ? 'No one hurt' : 'Unnamed worker';
    const roles = rolesWithCapability('manage:compliance');
    void trackNotificationWork(
      notifyAllAdmins({
        subject: `${i.nearMiss ? 'Hazard reported' : 'Incident reported'} from the floor — ${client.name}`,
        body: `${who}. ${i.description.slice(0, 240)}${i.description.length > 240 ? '…' : ''}${i.location ? `\nWhere: ${i.location}` : ''}${photoKey ? '\nA photo is attached in the log.' : ''}`,
        category: 'compliance',
        linkUrl: '/compliance/osha',
        emailRoles: created.isRecordable ? roles : [],
        excludeUserId: user.id,
      }),
    );
    res.status(201).json({ id: created.id, isRecordable: created.isRecordable, photo: !!photoKey });
  } catch (err) {
    next(err);
  }
});

floorRouter.get('/floor/incidents/:id/photo', requireAuth, async (req, res, next) => {
  try {
    const user = req.user!;
    const row = await prisma.oshaIncident.findFirst({
      where: { id: req.params.id, ...(can(user, 'view:compliance') ? {} : { reportedById: user.id }) },
      select: { photoKey: true },
    });
    if (!row?.photoKey) throw new HttpError(404, 'not_found', 'No photo on this incident.');
    const buf = await getBlobStore().get(row.photoKey);
    if (!buf) throw new HttpError(404, 'not_found', 'No photo on this incident.');
    const ext = extname(row.photoKey).toLowerCase();
    res.setHeader('Content-Type', ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(buf);
  } catch (err) {
    next(err);
  }
});

/* ---- Flags: what the watch-only lead saw ----------------------------------- */

const FlagBody = z.object({
  clientId: z.string().uuid().optional(),
  kind: z.enum(['NO_SHOW', 'HAZARD', 'OTHER']),
  associateId: z.string().uuid().optional(),
  shiftId: z.string().uuid().optional(),
  note: z.string().trim().min(1).max(500),
});

const FLAG_LABEL: Record<'NO_SHOW' | 'HAZARD' | 'OTHER', string> = { NO_SHOW: 'No-show', HAZARD: 'Hazard', OTHER: 'Flag' };

floorRouter.post('/floor/flags', requireCapability('report:incident'), async (req, res, next) => {
  try {
    const user = req.user!;
    const parsed = FlagBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    const i = parsed.data;
    const client = await clientFor(user, i.clientId);
    const associate = i.associateId ? await associateAtClient(i.associateId, client.id) : null;
    const shift = i.shiftId
      ? await prisma.shift.findFirst({ where: { id: i.shiftId, clientId: client.id }, select: { id: true, locationId: true, startsAt: true, position: true } })
      : null;
    if (i.shiftId && !shift) throw new HttpError(404, 'shift_not_found', 'That shift is not at this store.');
    const flag = await prisma.floorFlag.create({
      data: {
        tenantId: tenantIdForWrite(),
        clientId: client.id,
        locationId: shift?.locationId ?? user.locationId ?? null,
        kind: i.kind,
        associateId: associate?.id ?? null,
        shiftId: shift?.id ?? null,
        note: i.note,
        raisedById: user.id,
      },
    });
    enqueueAudit(
      { actorUserId: user.id, clientId: client.id, action: 'floor.flag_raised', entityType: 'FloorFlag', entityId: flag.id, metadata: { kind: i.kind, associateId: associate?.id ?? null, shiftId: shift?.id ?? null } },
      'floor.flag',
    );
    const who = associate ? ` — ${associate.firstName} ${associate.lastName}` : '';
    const subject = `${FLAG_LABEL[i.kind]}${who} · ${client.name}`;
    // The shift supervisors of this store hear first; a hazard also reaches HR.
    void trackNotificationWork(
      notifyClientSupervisors(client.id, {
        subject,
        body: `${i.note}\n\nRaised from the floor by ${user.email}. Acknowledge it on My floor.`,
        category: 'floor',
        linkUrl: '/',
        excludeUserId: user.id,
        at: shift ? { locationId: shift.locationId, startsAt: shift.startsAt } : null,
        aboutAssociateId: associate?.id ?? null,
      }),
    );
    if (i.kind === 'HAZARD') {
      void trackNotificationWork(
        notifyAllAdmins({ subject, body: `${i.note}\n\nRaised from the floor by ${user.email}.`, category: 'compliance', linkUrl: '/compliance', emailRoles: [], excludeUserId: user.id }),
      );
    }
    res.status(201).json({ id: flag.id });
  } catch (err) {
    next(err);
  }
});

const flagSelect = { id: true, kind: true, note: true, status: true, createdAt: true, associateId: true, shiftId: true, raisedById: true, acknowledgedAt: true } as const;

async function flagView(rows: Array<{ id: string; kind: string; note: string; status: string; createdAt: Date; associateId: string | null; shiftId: string | null; raisedById: string; acknowledgedAt: Date | null }>) {
  const associateIds = [...new Set(rows.map((r) => r.associateId).filter((x): x is string => !!x))];
  const userIds = [...new Set(rows.map((r) => r.raisedById))];
  const [associates, users] = await Promise.all([
    associateIds.length ? prisma.associate.findMany({ where: { id: { in: associateIds } }, select: { id: true, firstName: true, lastName: true } }) : [],
    prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true, associate: { select: { firstName: true, lastName: true } } } }),
  ]);
  const aName = new Map(associates.map((a) => [a.id, `${a.firstName} ${a.lastName}`.trim()]));
  const uName = new Map(users.map((u) => [u.id, u.associate ? `${u.associate.firstName} ${u.associate.lastName}`.trim() : u.email.split('@')[0]!]));
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    note: r.note,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    acknowledgedAt: r.acknowledgedAt?.toISOString() ?? null,
    associate: r.associateId ? { id: r.associateId, name: aName.get(r.associateId) ?? '' } : null,
    shiftId: r.shiftId,
    raisedBy: uName.get(r.raisedById) ?? '',
  }));
}

/** Open flags at my store — the shift supervisor's; an org role may name the client. */
floorRouter.get('/floor/flags', requireAnyCapability('manage:scheduling', 'manage:time'), async (req, res, next) => {
  try {
    const user = req.user!;
    const clamped = effectiveClientIdFilter(user, req.query.clientId?.toString());
    const clientId = clamped === null ? NO_CLIENT : clamped;
    const status = req.query.status === 'all' ? undefined : ('OPEN' as const);
    const rows = await prisma.floorFlag.findMany({
      where: { tenantId: tenantIdForWrite(), ...(clientId ? { clientId } : {}), ...(status ? { status } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: flagSelect,
    });
    res.json({ flags: await flagView(rows) });
  } catch (err) {
    next(err);
  }
});

floorRouter.post('/floor/flags/:id/ack', requireAnyCapability('manage:scheduling', 'manage:time'), async (req, res, next) => {
  try {
    const user = req.user!;
    const clamped = effectiveClientIdFilter(user, undefined);
    const flag = await prisma.floorFlag.findFirst({
      where: { id: req.params.id, tenantId: tenantIdForWrite(), ...(clamped === null ? { clientId: NO_CLIENT } : clamped ? { clientId: clamped } : {}) },
      select: { id: true, status: true, raisedById: true, kind: true },
    });
    if (!flag) throw new HttpError(404, 'not_found', 'Flag not found.');
    if (flag.status === 'ACKNOWLEDGED') {
      res.json({ ok: true });
      return;
    }
    await prisma.floorFlag.update({ where: { id: flag.id }, data: { status: 'ACKNOWLEDGED', acknowledgedById: user.id, acknowledgedAt: new Date() } });
    enqueueAudit({ actorUserId: user.id, action: 'floor.flag_acknowledged', entityType: 'FloorFlag', entityId: flag.id, metadata: { kind: flag.kind } }, 'floor.flag');
    // The person who raised it hears that it landed.
    void trackNotificationWork(
      notifyUser(flag.raisedById, { subject: `${FLAG_LABEL[flag.kind as keyof typeof FLAG_LABEL] ?? 'Flag'} acknowledged`, body: 'Your shift supervisor has it.', category: 'floor', quiet: true }),
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ---- The week: watch-only sees beyond tomorrow ----------------------------- */

floorRouter.get('/floor/week', requireAnyCapability('view:time-live', 'view:scheduling'), async (req, res, next) => {
  try {
    const user = req.user!;
    const clamped = effectiveClientIdFilter(user, req.query.clientId?.toString());
    const clientId = clamped === null ? NO_CLIENT : clamped;
    if (!clientId) throw new HttpError(400, 'client_required', 'Name the client.');
    const site = await prisma.site.findFirst({ where: { clientId, deletedAt: null, isActive: true }, select: { timezone: true }, orderBy: { createdAt: 'asc' } });
    const tz = site?.timezone ?? 'America/New_York';
    const now = new Date();
    const todayKey = dateKeyInZone(now, tz);
    const from = new Date(now.getTime() - DAY_MS);
    const to = new Date(now.getTime() + 8 * DAY_MS);
    const shifts = await prisma.shift.findMany({
      where: { clientId, publishedAt: { not: null }, status: { in: ['OPEN', 'ASSIGNED', 'COMPLETED'] }, startsAt: { gte: from, lt: to } },
      select: { startsAt: true, status: true, acknowledgedAt: true, locationRel: { select: { timezone: true } } },
      take: 3000,
    });
    const days = Array.from({ length: 7 }, (_, i) => {
      const key = dateKeyInZone(new Date(now.getTime() + i * DAY_MS), tz);
      return { date: key, scheduled: 0, open: 0, confirmed: 0 };
    });
    const byKey = new Map(days.map((d) => [d.date, d]));
    for (const s of shifts) {
      const d = byKey.get(dateKeyInZone(s.startsAt, s.locationRel?.timezone ?? tz));
      if (!d) continue;
      d.scheduled += 1;
      if (s.status === 'OPEN') d.open += 1;
      else if (s.acknowledgedAt || s.status === 'COMPLETED') d.confirmed += 1;
    }
    res.json({ today: todayKey, timezone: tz, days });
  } catch (err) {
    next(err);
  }
});

/* ---- One text to the crew on a shift --------------------------------------- */

const CrewTextBody = z.object({
  clientId: z.string().uuid().optional(),
  /** The shifts whose people get the text — a wave on the face wall. */
  shiftIds: z.array(z.string().uuid()).min(1).max(200),
  body: z.string().trim().min(1).max(600),
});

floorRouter.post('/floor/crew-text', requireCapability('message:crew'), async (req, res, next) => {
  try {
    const user = req.user!;
    const parsed = CrewTextBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    const i = parsed.data;
    const client = await clientFor(user, i.clientId);
    const shifts = await prisma.shift.findMany({
      where: { id: { in: i.shiftIds }, clientId: client.id, assignedAssociateId: { not: null } },
      select: { assignedAssociate: { select: { id: true, firstName: true, lastName: true, phone: true } } },
    });
    const people = new Map<string, { id: string; name: string; phone: string | null }>();
    for (const s of shifts) {
      const a = s.assignedAssociate;
      if (a) people.set(a.id, { id: a.id, name: `${a.firstName} ${a.lastName}`.trim(), phone: a.phone });
    }
    if (people.size === 0) throw new HttpError(404, 'nobody_on_shift', 'Nobody is assigned to those shifts.');
    const from = user.email.split('@')[0]!;
    let sent = 0;
    const noPhone: string[] = [];
    for (const p of people.values()) {
      if (!p.phone) {
        noPhone.push(p.name);
        continue;
      }
      // Kept in the communications log like every text to that person
      // (the same row the desk's Text writes), sender named.
      const row = await prisma.notification.create({
        data: { channel: 'SMS', status: 'QUEUED', recipientPhone: p.phone, body: i.body, subject: null, category: 'crew-text', senderUserId: user.id },
      });
      try {
        const { externalRef } = await sendStubbed('SMS', { userId: null, phone: p.phone, email: null });
        await prisma.notification.update({ where: { id: row.id }, data: { status: 'SENT', sentAt: new Date(), externalRef } });
        sent += 1;
      } catch (err) {
        await prisma.notification.update({ where: { id: row.id }, data: { status: 'FAILED', failureReason: err instanceof Error ? err.message : 'unknown error' } });
      }
    }
    enqueueAudit(
      { actorUserId: user.id, clientId: client.id, action: 'floor.crew_text', entityType: 'Client', entityId: client.id, metadata: { shifts: i.shiftIds.length, people: people.size, sent, from } },
      'floor.crew_text',
    );
    res.json({ sent, noPhone });
  } catch (err) {
    next(err);
  }
});

/* ---- The handover: the last shift's notes for the lead coming on ----------- */

floorRouter.get('/floor/handover', requireAnyCapability('run:ops-shifts', 'assist:ops-shifts'), async (req, res, next) => {
  try {
    const user = req.user!;
    const clamped = effectiveClientIdFilter(user, req.query.clientId?.toString());
    const clientId = clamped === null ? NO_CLIENT : clamped;
    if (!clientId) {
      res.json({ items: [] });
      return;
    }
    // A supervisor with a shift sees their own stores' notes; one without sees the client's.
    const mine = hasCapability(user.role, 'manage:scheduling') || user.role === 'FLOOR_SUPERVISOR' ? await ledWindows(prisma, { userId: user.id }) : [];
    const locationIds = [...new Set(mine.map((w) => w.locationId))];
    const since = new Date(Date.now() - 36 * 3_600_000);
    const rows = await prisma.opsHandoverItem.findMany({
      where: {
        status: 'PENDING',
        createdAt: { gte: since },
        fromShift: { clientId, ...(locationIds.length ? { locationId: { in: locationIds } } : {}) },
      },
      orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
      take: 20,
      select: {
        id: true, kind: true, body: true, priority: true, createdAt: true,
        fromShift: { select: { id: true, position: true, period: true, dateKey: true, department: true, openedBy: { select: { email: true, associate: { select: { firstName: true, lastName: true } } } } } },
      },
    });
    res.json({
      items: rows.map((h) => ({
        id: h.id,
        kind: h.kind,
        body: h.body,
        priority: h.priority,
        createdAt: h.createdAt.toISOString(),
        from: {
          shiftId: h.fromShift.id,
          position: h.fromShift.position,
          period: h.fromShift.period,
          dateKey: h.fromShift.dateKey,
          department: h.fromShift.department,
          by: h.fromShift.openedBy.associate ? `${h.fromShift.openedBy.associate.firstName} ${h.fromShift.openedBy.associate.lastName}`.trim() : h.fromShift.openedBy.email.split('@')[0] ?? null,
        },
      })),
    });
  } catch (err) {
    next(err);
  }
});

/* ---- Cover this shift: one tap, three moves ------------------------------- */

const CoverBody = z.object({
  /** The assigned person called out: release them and run the flow. */
  release: z.boolean().optional(),
  reason: z.string().trim().max(300).optional(),
});

export type { CoverStep } from '../lib/coverShift.js';

floorRouter.post('/floor/cover/:shiftId', requireCapability('manage:scheduling'), async (req, res, next) => {
  try {
    const user = req.user!;
    const parsed = CoverBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    const clamped = effectiveClientIdFilter(user, undefined);
    const shift = await prisma.shift.findFirst({
      where: { id: req.params.shiftId, ...(clamped === null ? { clientId: NO_CLIENT } : clamped ? { clientId: clamped } : {}) },
      select: { id: true, clientId: true, status: true, assignedAssociateId: true, publishedAt: true, startsAt: true, position: true, notes: true },
    });
    if (!shift) throw new HttpError(404, 'shift_not_found', 'Shift not found.');
    if (shift.startsAt.getTime() < Date.now()) throw new HttpError(409, 'shift_started', 'This shift has already started.');
    if (shift.status === 'CANCELLED' || shift.status === 'COMPLETED') throw new HttpError(409, 'shift_closed', 'This shift is closed.');
    if (shift.status === 'ASSIGNED' && shift.assignedAssociateId && !parsed.data.release) {
      throw new HttpError(409, 'shift_assigned', 'Someone holds this shift. Release them to cover it.', { assignedAssociateId: shift.assignedAssociateId });
    }
    // The three moves (lib/coverShift): post it, ask the bench, the agent.
    const { released, steps } = await runCoverFlow(prisma, shift, { reason: parsed.data.reason ?? null });
    if (released && shift.assignedAssociateId) {
      void trackNotificationWork(
        notifyUser(user.id, { subject: `Released from ${shift.position}`, body: `The ${shift.position} shift was released and is being covered.`, category: 'scheduling', quiet: true }),
      );
    }

    enqueueAudit(
      { actorUserId: user.id, clientId: shift.clientId, action: 'shift.cover_requested', entityType: 'Shift', entityId: shift.id, metadata: { released, steps: steps.map((s) => `${s.key}:${s.status}`) } },
      'floor.cover',
    );
    res.json({ shiftId: shift.id, steps });
  } catch (err) {
    next(err);
  }
});
