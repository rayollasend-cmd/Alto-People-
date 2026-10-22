import type { Prisma, PrismaClient } from '@prisma/client';
import type {
  EmergencyBoard,
  EmergencyBoardRow,
  EmergencyCheckInInput,
  EmergencyDeclareInput,
  EmergencySiteRef,
  EmergencySummary,
  MyEmergencyResponse,
} from '@alto-people/shared';
import { prisma as defaultPrisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { enqueueAudit, recordCriticalAudit } from './audit.js';
import { toEmailLang, type EmailLang } from './emailLayout.js';
import {
  emergencyDeclaredBody,
  emergencyPushLine,
  emergencySubject,
  standDownBody,
  standDownSubject,
} from './emergencyContent.js';
import { geocode } from './geocode.js';
import { send, statusForSendError } from './notifications.js';
import { smsAvailability } from './sms.js';
import { notifyAssociate, notifyClientSupervisors, notifyUser } from './notify.js';
import { moduleOn } from './tenantProfile.js';
import { repairSoon } from './scheduleRepair.js';
import { dateKeyInZone } from './timeAnomalies.js';
import { DEFAULT_TIMEZONE } from './timezone.js';

/**
 * EMERGENCY MODE — one switch that protects the workforce.
 *
 * Declare: the shifts in scope are suspended (CANCELLED with reason
 * EMERGENCY, prior status kept), every associate in scope hears in their
 * language — bell, email, push, and SMS when a provider is wired — the
 * supervisors and the store managers' portal accounts hear in English,
 * and one critical audit row records who, when, and the scope.
 *
 * Check in: one tap from the associate app — safe, or needs help — and
 * optionally a seat on an evacuation van, booked from the address on file
 * (the rider's saved Home, else the associate record) with fare zero, so
 * dispatch and the driver app need nothing new.
 *
 * Stand down: shifts from the next one on go back to what they were;
 * everyone hears again; another audit row.
 *
 * Scope is "who works at these sites": an open assignment there, or an
 * assigned shift there that ends after the emergency starts. There is no
 * housing system to read from (no Helios link exists), so "where they
 * live" is the address on file.
 */

type Db = PrismaClient;

const EMERGENCY_REASON = 'EMERGENCY';
const EVACUATION_LABEL = 'Evacuation';
const SHIFT_LOOKAHEAD_MS = 14 * 24 * 60 * 60 * 1000;
export const EMERGENCY_CATEGORY = 'emergency';

interface Scope {
  allSites: boolean;
  locationIds: string[];
  clientIds: string[];
}

type EmergencyRow = Prisma.EmergencyGetPayload<{
  include: {
    sites: { include: { location: { select: { id: true; name: true; clientId: true; client: { select: { name: true } } } } } };
    destinationLocation: { select: { id: true; name: true } };
    declaredBy: { select: { email: true; associate: { select: { firstName: true; lastName: true } } } };
    stoodDownBy: { select: { email: true; associate: { select: { firstName: true; lastName: true } } } };
  };
}>;

const EMERGENCY_INCLUDE = {
  sites: { include: { location: { select: { id: true, name: true, clientId: true, client: { select: { name: true } } } } } },
  destinationLocation: { select: { id: true, name: true } },
  declaredBy: { select: { email: true, associate: { select: { firstName: true, lastName: true } } } },
  stoodDownBy: { select: { email: true, associate: { select: { firstName: true, lastName: true } } } },
} satisfies Prisma.EmergencyInclude;

const personName = (
  u: { email: string; associate: { firstName: string; lastName: string } | null } | null,
): string | null => (u ? (u.associate ? `${u.associate.firstName} ${u.associate.lastName}`.trim() : u.email) : null);

function scopeOf(e: EmergencyRow): Scope {
  return {
    allSites: e.allSites,
    locationIds: e.sites.map((s) => s.locationId),
    // Client-less sites (a direct employer) reach by locationId alone.
    clientIds: [...new Set(e.sites.map((s) => s.location.clientId).filter((id): id is string => id !== null))],
  };
}

/** Shifts the emergency reaches: at its sites (or a site-less shift of those clients), ending after it starts. */
function shiftScope(scope: Scope, startsAt: Date): Prisma.ShiftWhereInput {
  const base: Prisma.ShiftWhereInput = {
    endsAt: { gt: startsAt },
    startsAt: { lt: new Date(startsAt.getTime() + SHIFT_LOOKAHEAD_MS) },
  };
  if (scope.allSites) return base;
  return {
    ...base,
    OR: [
      { locationId: { in: scope.locationIds } },
      { locationId: null, clientId: { in: scope.clientIds } },
    ],
  };
}

export interface ScopedAssociate {
  id: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  email: string;
  siteId: string | null;
  siteName: string;
  clientId: string | null;
  timezone: string;
  address: string | null;
  addressPoint: { lat: number; lng: number } | null;
}

/** Everyone the emergency reaches, with the site they belong to and the address on file. */
export async function associatesInScope(db: Db, e: EmergencyRow): Promise<ScopedAssociate[]> {
  const scope = scopeOf(e);
  const siteFilter = scope.allSites ? {} : { locationId: { in: scope.locationIds } };
  const [assignments, shifts] = await Promise.all([
    db.associateAssignment.findMany({
      where: { endedAt: null, ...siteFilter },
      select: {
        associateId: true,
        location: { select: { id: true, name: true, clientId: true, timezone: true } },
      },
      orderBy: { startedAt: 'desc' },
    }),
    db.shift.findMany({
      where: { ...shiftScope(scope, e.startsAt), assignedAssociateId: { not: null }, status: { not: 'DRAFT' } },
      select: {
        assignedAssociateId: true,
        clientId: true,
        locationRel: { select: { id: true, name: true, clientId: true, timezone: true } },
        client: { select: { name: true } },
      },
    }),
  ]);
  type Site = { id: string | null; name: string; clientId: string | null; timezone: string };
  const siteByAssociate = new Map<string, Site>();
  for (const a of assignments) {
    if (!siteByAssociate.has(a.associateId)) siteByAssociate.set(a.associateId, { ...a.location });
  }
  for (const s of shifts) {
    const id = s.assignedAssociateId!;
    if (siteByAssociate.has(id)) continue;
    siteByAssociate.set(
      id,
      s.locationRel
        ? { ...s.locationRel }
        : { id: null, name: s.client?.name ?? 'Unknown site', clientId: s.clientId, timezone: DEFAULT_TIMEZONE },
    );
  }
  const ids = [...siteByAssociate.keys()];
  if (ids.length === 0) return [];
  const people = await db.associate.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      phone: true,
      email: true,
      addressLine1: true,
      addressLine2: true,
      city: true,
      state: true,
      zip: true,
      ridePlaces: { orderBy: { createdAt: 'asc' }, select: { label: true, address: true, lat: true, lng: true } },
    },
  });
  return people
    .map((p) => {
      const site = siteByAssociate.get(p.id)!;
      const home = p.ridePlaces.find((r) => /home|casa|ev\b/i.test(r.label)) ?? p.ridePlaces[0] ?? null;
      const onFile = [p.addressLine1, p.addressLine2, [p.city, p.state].filter(Boolean).join(', '), p.zip]
        .filter((x) => x && String(x).trim())
        .join(', ');
      return {
        id: p.id,
        firstName: p.firstName,
        lastName: p.lastName,
        phone: p.phone,
        email: p.email,
        siteId: site.id,
        siteName: site.name,
        clientId: site.clientId,
        timezone: site.timezone,
        address: home?.address ?? (onFile || null),
        addressPoint: home && home.lat !== null && home.lng !== null ? { lat: Number(home.lat), lng: Number(home.lng) } : null,
      };
    })
    .sort((a, b) => a.siteName.localeCompare(b.siteName) || a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName));
}

function messageFor(e: EmergencyRow, lang: EmailLang): string {
  return lang === 'es' ? e.messageEs : lang === 'tr' ? e.messageTr : e.messageEn;
}

export function summarize(e: EmergencyRow, checkIns: EmergencySummary['checkIns']): EmergencySummary {
  // The site reference names a client; a client-less site (a direct employer) is listed once step 5 gives it an org unit.
  const sites: EmergencySiteRef[] = e.sites.flatMap((s) =>
    s.location.clientId && s.location.client
      ? [{ id: s.location.id, name: s.location.name, clientId: s.location.clientId, clientName: s.location.client.name }]
      : [],
  );
  return {
    id: e.id,
    title: e.title,
    status: e.status,
    allSites: e.allSites,
    sites,
    startsAt: e.startsAt.toISOString(),
    pickupAt: e.pickupAt?.toISOString() ?? null,
    destination: e.destinationLocation ? { id: e.destinationLocation.id, name: e.destinationLocation.name } : null,
    escalationMinutes: e.escalationMinutes,
    declaredAt: e.declaredAt.toISOString(),
    declaredBy: personName(e.declaredBy),
    stoodDownAt: e.stoodDownAt?.toISOString() ?? null,
    stoodDownBy: personName(e.stoodDownBy),
    shiftsSuspended: e.shiftsSuspended,
    associatesNotified: e.associatesNotified,
    shiftsRestored: e.shiftsRestored,
    checkIns,
    texts: smsAvailability(),
  };
}

async function checkInCounts(db: Db, e: EmergencyRow): Promise<EmergencySummary['checkIns']> {
  const [people, rows] = await Promise.all([
    associatesInScope(db, e),
    db.emergencyCheckIn.findMany({ where: { emergencyId: e.id }, select: { status: true, needsRide: true } }),
  ]);
  return {
    total: people.length,
    responded: rows.length,
    safe: rows.filter((r) => r.status === 'SAFE').length,
    needsHelp: rows.filter((r) => r.status === 'NEEDS_HELP').length,
    needsRide: rows.filter((r) => r.needsRide).length,
  };
}

export async function getEmergency(db: Db, id: string): Promise<EmergencyRow> {
  const e = await db.emergency.findUnique({ where: { id }, include: EMERGENCY_INCLUDE });
  if (!e) throw new HttpError(404, 'emergency_not_found', 'No such emergency.');
  return e;
}

export async function listEmergencies(db: Db = defaultPrisma): Promise<EmergencySummary[]> {
  const rows = await db.emergency.findMany({ include: EMERGENCY_INCLUDE, orderBy: { declaredAt: 'desc' }, take: 50 });
  return Promise.all(rows.map(async (e) => summarize(e, await checkInCounts(db, e))));
}

/** Every active store, for the scope picker. */
export async function emergencySites(db: Db = defaultPrisma, opts: { tenantId?: string } = {}): Promise<EmergencySiteRef[]> {
  const rows = await db.site.findMany({
    where: { isActive: true, deletedAt: null, client: { deletedAt: null, status: 'ACTIVE' }, ...(opts.tenantId ? { tenantId: opts.tenantId } : {}) },
    select: { id: true, name: true, clientId: true, client: { select: { name: true } } },
    orderBy: [{ client: { name: 'asc' } }, { name: 'asc' }],
  });
  // The where above requires a client; the type does not know it.
  return rows.flatMap((r) => (r.clientId && r.client ? [{ id: r.id, name: r.name, clientId: r.clientId, clientName: r.client.name }] : []));
}

type TextOutcome = 'sent' | 'not_sent' | 'no_phone';

/** Tell one associate, in their language, on every channel we have. Returns what the text did. */
async function tellAssociate(
  db: Db,
  a: ScopedAssociate,
  words: { title: string; subject: (l: EmailLang) => string; body: (l: EmailLang) => string; line: (l: EmailLang) => string },
): Promise<TextOutcome> {
  const user = await db.user.findFirst({
    where: { associateId: a.id, status: 'ACTIVE', deletedAt: null },
    select: { id: true, language: true },
  });
  const lang = toEmailLang(user?.language);
  if (user) {
    await notifyUser(user.id, {
      subject: words.subject(lang),
      body: words.body(lang),
      category: EMERGENCY_CATEGORY,
      linkUrl: '/',
      // WhatsApp, when they opted in: the emergency template, in their language.
      wa: { template: 'alto_emergency', params: (l) => [words.title, words.body(l)] },
    });
  } else {
    await notifyAssociate(a.id, {
      subject: words.subject(lang),
      body: words.body(lang),
      category: EMERGENCY_CATEGORY,
      linkUrl: '/',
      emailFallback: true,
    });
  }
  // SMS rides the shared sender (lib/sms): a real text when a provider is
  // connected; otherwise the row says NOT_CONFIGURED and the board says
  // texts are off. Every attempt is its own row on the communications log.
  if (!a.phone) return 'no_phone';
  const body = `${words.line(lang)}\n\n${words.body(lang)}`.slice(0, 1500);
  const row = await db.notification.create({
    data: { channel: 'SMS', status: 'QUEUED', recipientUserId: user?.id ?? null, recipientPhone: a.phone, subject: null, body, category: EMERGENCY_CATEGORY },
  });
  try {
    const { externalRef } = await send({ channel: 'SMS', recipient: { userId: user?.id ?? null, phone: a.phone, email: null }, subject: null, body, category: EMERGENCY_CATEGORY, audit: false });
    await db.notification.update({ where: { id: row.id }, data: { status: 'SENT', sentAt: new Date(), externalRef } });
    return 'sent';
  } catch (err) {
    await db.notification.update({ where: { id: row.id }, data: { status: statusForSendError(err), failureReason: (err instanceof Error ? err.message : String(err)).slice(0, 500) } });
    return 'not_sent';
  }
}

function tallyTexts(outcomes: TextOutcome[]): { sent: number; notSent: number } {
  return { sent: outcomes.filter((o) => o === 'sent').length, notSent: outcomes.filter((o) => o === 'not_sent').length };
}

/** Supervisors of the clients in scope and the store managers' portal accounts. */
async function tellLeadership(db: Db, e: EmergencyRow, subject: string, body: string): Promise<void> {
  const scope = scopeOf(e);
  const clientIds = scope.allSites
    ? (await db.client.findMany({ where: { deletedAt: null, status: 'ACTIVE' }, select: { id: true } })).map((c) => c.id)
    : scope.clientIds;
  for (const clientId of clientIds) {
    await notifyClientSupervisors(clientId, { subject, body, category: EMERGENCY_CATEGORY, linkUrl: '/emergency' });
  }
  const portal = await db.user.findMany({
    where: {
      role: 'CLIENT_PORTAL',
      status: 'ACTIVE',
      deletedAt: null,
      ...(scope.allSites
        ? {}
        : { OR: [{ locationId: { in: scope.locationIds } }, { locationId: null, clientId: { in: scope.clientIds } }] }),
    },
    select: { id: true },
  });
  for (const u of portal) {
    await notifyUser(u.id, { subject, body, category: EMERGENCY_CATEGORY, linkUrl: '/portal' });
  }
}

export interface DeclareContext {
  actorUserId: string;
  ip?: string | null;
  userAgent?: string | null;
}

export async function declareEmergency(
  db: Db,
  input: EmergencyDeclareInput,
  ctx: DeclareContext,
  now: Date = new Date(),
): Promise<EmergencySummary> {
  const startsAt = input.startsAt ? new Date(input.startsAt) : now;
  if (!input.allSites && input.locationIds.length === 0) {
    throw new HttpError(400, 'no_sites', 'Pick at least one site, or every site.');
  }
  const locationIds = input.allSites ? [] : [...new Set(input.locationIds)];
  if (locationIds.length > 0) {
    const found = await db.site.count({ where: { id: { in: locationIds }, deletedAt: null } });
    if (found !== locationIds.length) throw new HttpError(400, 'site_not_found', 'One of those sites does not exist.');
  }
  if (input.destinationLocationId) {
    const dest = await db.site.findFirst({ where: { id: input.destinationLocationId, deletedAt: null }, select: { id: true } });
    if (!dest) throw new HttpError(400, 'destination_not_found', 'That destination does not exist.');
  }

  const created = await db.$transaction(async (tx) => {
    const e = await tx.emergency.create({
      data: {
        title: input.title,
        messageEn: input.message,
        messageEs: input.messageEs?.trim() || input.message,
        messageTr: input.messageTr?.trim() || input.message,
        allSites: input.allSites,
        startsAt,
        pickupAt: input.pickupAt ? new Date(input.pickupAt) : null,
        destinationLocationId: input.destinationLocationId ?? null,
        escalationMinutes: input.escalationMinutes,
        declaredById: ctx.actorUserId,
        declaredAt: now,
        sites: { create: locationIds.map((locationId) => ({ locationId })) },
      },
      include: EMERGENCY_INCLUDE,
    });
    const scope = scopeOf(e);
    // Suspend: CANCELLED with the EMERGENCY reason, prior status kept.
    // Every sweep and roster already treats CANCELLED as "not a shift",
    // which is exactly the penalty exclusion the brief asks for.
    const targets = await tx.shift.findMany({
      where: { ...shiftScope(scope, startsAt), status: { in: ['OPEN', 'ASSIGNED'] } },
      select: { id: true, status: true, clientId: true, assignedAssociateId: true },
    });
    for (const s of targets) {
      await tx.shift.update({
        where: { id: s.id },
        data: {
          status: 'CANCELLED',
          cancelledAt: now,
          cancellationReason: EMERGENCY_REASON,
          emergencyId: e.id,
          emergencyPriorStatus: s.status,
        },
      });
    }
    const updated = await tx.emergency.update({
      where: { id: e.id },
      data: { shiftsSuspended: targets.length },
      include: EMERGENCY_INCLUDE,
    });
    return { emergency: updated, targets };
  });

  const e = created.emergency;
  for (const s of created.targets) {
    enqueueAudit(
      {
        actorUserId: ctx.actorUserId,
        clientId: s.clientId,
        action: 'shift.suspended_emergency',
        entityType: 'Shift',
        entityId: s.id,
        metadata: { emergencyId: e.id, priorStatus: s.status, associateId: s.assignedAssociateId },
      },
      'declareEmergency',
    );
  }

  const people = await associatesInScope(db, e);
  const words = {
    title: e.title,
    subject: (l: EmailLang) => emergencySubject(l, e.title),
    body: (l: EmailLang) =>
      emergencyDeclaredBody(l, { title: e.title, message: messageFor(e, l), startsAt: e.startsAt, pickupAt: e.pickupAt }),
    line: (l: EmailLang) => emergencyPushLine(l, e.title),
  };
  const outcomes: TextOutcome[] = [];
  for (const a of people) outcomes.push(await tellAssociate(db, a, words));
  const texts = tallyTexts(outcomes);
  const scopeLine = e.allSites ? 'every site' : e.sites.map((s) => s.location.name).join(', ');
  await tellLeadership(
    db,
    e,
    `EMERGENCY declared: ${e.title}`,
    `${e.messageEn}\n\nScope: ${scopeLine}. ${created.targets.length} shift${created.targets.length === 1 ? '' : 's'} suspended from ${e.startsAt.toISOString()}. ` +
      `${people.length} associate${people.length === 1 ? '' : 's'} told to check in. The board is at /emergency.`,
  );

  await recordCriticalAudit(
    {
      actorUserId: ctx.actorUserId,
      clientId: null,
      action: 'emergency.declared',
      entityType: 'Emergency',
      entityId: e.id,
      metadata: {
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
        title: e.title,
        allSites: e.allSites,
        locationIds: e.sites.map((s) => s.locationId),
        startsAt: e.startsAt.toISOString(),
        pickupAt: e.pickupAt?.toISOString() ?? null,
        shiftsSuspended: created.targets.length,
        associatesNotified: people.length,
        textsSent: texts.sent,
        textsNotSent: texts.notSent,
        escalationMinutes: e.escalationMinutes,
      },
    },
    'declareEmergency',
  );

  const final = await db.emergency.update({
    where: { id: e.id },
    data: { associatesNotified: people.length },
    include: EMERGENCY_INCLUDE,
  });
  const out = summarize(final, await checkInCounts(db, final));
  return { ...out, texts: { ...out.texts!, ...texts } };
}

export async function standDownEmergency(
  db: Db,
  id: string,
  ctx: DeclareContext,
  now: Date = new Date(),
): Promise<EmergencySummary> {
  const existing = await getEmergency(db, id);
  if (existing.status !== 'ACTIVE') throw new HttpError(409, 'already_stood_down', 'That emergency is already over.');

  const restored = await db.$transaction(async (tx) => {
    // From the next shift on: a shift that already started stays a record
    // of what happened; one still ahead goes back to what it was.
    const targets = await tx.shift.findMany({
      where: { emergencyId: id, status: 'CANCELLED', cancellationReason: EMERGENCY_REASON, startsAt: { gte: now } },
      select: { id: true, emergencyPriorStatus: true, clientId: true },
    });
    for (const s of targets) {
      await tx.shift.update({
        where: { id: s.id },
        data: {
          status: s.emergencyPriorStatus ?? 'OPEN',
          cancelledAt: null,
          cancellationReason: null,
          emergencyPriorStatus: null,
        },
      });
    }
    await tx.emergency.update({
      where: { id },
      data: { status: 'STOOD_DOWN', stoodDownAt: now, stoodDownById: ctx.actorUserId, shiftsRestored: targets.length },
    });
    return targets;
  });
  for (const s of restored) {
    enqueueAudit(
      {
        actorUserId: ctx.actorUserId,
        clientId: s.clientId,
        action: 'shift.restored_emergency',
        entityType: 'Shift',
        entityId: s.id,
        metadata: { emergencyId: id, status: s.emergencyPriorStatus },
      },
      'standDownEmergency',
    );
  }

  const e = await getEmergency(db, id);
  // Back on the schedule: the Workforce agent proposes cover for any that came
  // back open, or held by someone who can no longer work them (fire-and-forget).
  repairSoon(restored.map((s) => s.id), { kind: 'emergency_stand_down', emergencyId: id, title: e.title }, now);
  const people = await associatesInScope(db, e);
  const words = {
    title: e.title,
    subject: (l: EmailLang) => standDownSubject(l, e.title),
    body: (l: EmailLang) => standDownBody(l, e.title, now),
    line: (l: EmailLang) => standDownSubject(l, e.title),
  };
  const outcomes: TextOutcome[] = [];
  for (const a of people) outcomes.push(await tellAssociate(db, a, words));
  const texts = tallyTexts(outcomes);
  await tellLeadership(
    db,
    e,
    `All clear: ${e.title}`,
    `The emergency is over. ${restored.length} shift${restored.length === 1 ? '' : 's'} from ${now.toISOString()} are back on the schedule.`,
  );
  await recordCriticalAudit(
    {
      actorUserId: ctx.actorUserId,
      clientId: null,
      action: 'emergency.stood_down',
      entityType: 'Emergency',
      entityId: e.id,
      metadata: {
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
        title: e.title,
        shiftsRestored: restored.length,
        associatesNotified: people.length,
        textsSent: texts.sent,
        textsNotSent: texts.notSent,
        stoodDownAt: now.toISOString(),
      },
    },
    'standDownEmergency',
  );
  const out = summarize(e, await checkInCounts(db, e));
  return { ...out, texts: { ...out.texts!, ...texts } };
}

/** The active emergency the associate is in, if any, in their language. */
export async function myEmergency(
  db: Db,
  user: { id: string; associateId: string | null; language: string | null },
  now: Date = new Date(),
): Promise<MyEmergencyResponse> {
  if (!user.associateId) return { emergency: null, checkIn: null };
  const active = await db.emergency.findMany({ where: { status: 'ACTIVE' }, include: EMERGENCY_INCLUDE, orderBy: { declaredAt: 'desc' } });
  for (const e of active) {
    const people = await associatesInScope(db, e);
    if (!people.some((p) => p.id === user.associateId)) continue;
    const checkIn = await db.emergencyCheckIn.findUnique({
      where: { emergencyId_associateId: { emergencyId: e.id, associateId: user.associateId } },
      include: { ride: { select: { status: true, pickupAt: true } } },
    });
    const lang = toEmailLang(user.language);
    return {
      emergency: {
        id: e.id,
        title: e.title,
        message: messageFor(e, lang),
        startsAt: e.startsAt.toISOString(),
        pickupAt: e.pickupAt?.toISOString() ?? null,
        declaredAt: e.declaredAt.toISOString(),
        // The evacuation seat is the transportation module's half of an emergency: a tenant without vans is never offered one.
        rideOffered: e.pickupAt !== null && e.pickupAt.getTime() > now.getTime() - 6 * 3_600_000 && (await moduleOn('transportation')),
      },
      checkIn: checkIn
        ? {
            status: checkIn.status,
            needsRide: checkIn.needsRide,
            respondedAt: checkIn.respondedAt.toISOString(),
            ride: checkIn.ride ? { status: checkIn.ride.status, pickupAt: checkIn.ride.pickupAt?.toISOString() ?? null } : null,
          }
        : null,
    };
  }
  return { emergency: null, checkIn: null };
}

/**
 * Book the evacuation seat: pickup at the address on file, bound for the
 * emergency's destination (else the rider's own store), fare zero. No
 * coordinates is not a reason to refuse — the board flags it and the
 * director can pin it — but no address at all is.
 */
async function bookEvacuationRide(
  db: Db,
  e: EmergencyRow,
  a: ScopedAssociate,
  actorUserId: string,
  now: Date,
): Promise<string> {
  const destinationId = e.destinationLocationId ?? a.siteId;
  if (!destinationId) throw new HttpError(409, 'no_destination', 'There is no site to take you to yet; call dispatch.');
  if (!a.address) throw new HttpError(409, 'no_address', 'We have no address on file for you. Add your home in the Rides tab, then try again.');
  const dest = await db.site.findUniqueOrThrow({ where: { id: destinationId }, select: { timezone: true } });
  let point = a.addressPoint;
  if (!point) {
    try {
      point = await geocode(a.address);
    } catch {
      point = null;
    }
  }
  const targetAt = e.pickupAt ?? new Date(now.getTime() + 2 * 3_600_000);
  const ride = await db.ride.create({
    data: {
      associateId: a.id,
      direction: 'TO_WORK',
      locationId: destinationId,
      address: a.address.slice(0, 300),
      lat: point?.lat ?? null,
      lng: point?.lng ?? null,
      targetAt,
      serviceDate: dateKeyInZone(targetAt, dest.timezone),
      status: 'REQUESTED',
      windowLabel: EVACUATION_LABEL,
      note: `Emergency evacuation: ${e.title}`.slice(0, 300),
      fareCents: 0,
      noShowFeeCents: 0,
      chargeCents: 0,
      emergencyId: e.id,
      createdById: actorUserId,
    },
    select: { id: true },
  });
  return ride.id;
}

export async function checkIn(
  db: Db,
  emergencyId: string,
  user: { id: string; associateId: string | null },
  input: EmergencyCheckInInput,
  now: Date = new Date(),
): Promise<MyEmergencyResponse> {
  if (!user.associateId) throw new HttpError(403, 'no_associate', 'Your login is not linked to an associate record.');
  const e = await getEmergency(db, emergencyId);
  if (e.status !== 'ACTIVE') throw new HttpError(409, 'not_active', 'That emergency is over.');
  const people = await associatesInScope(db, e);
  const me = people.find((p) => p.id === user.associateId);
  if (!me) throw new HttpError(403, 'not_in_scope', 'This emergency does not include your site.');

  const existing = await db.emergencyCheckIn.findUnique({
    where: { emergencyId_associateId: { emergencyId, associateId: me.id } },
    include: { ride: { select: { id: true, status: true } } },
  });
  // Without the transportation module there is no van to book: the answer is kept, the seat is not.
  const needsRide = input.needsRide && (await moduleOn('transportation'));
  let rideId = existing?.rideId ?? null;
  if (needsRide && !existing?.ride) {
    rideId = await bookEvacuationRide(db, e, me, user.id, now);
  } else if (!needsRide && existing?.ride && existing.ride.status === 'REQUESTED') {
    await db.ride.update({
      where: { id: existing.ride.id },
      data: { status: 'CANCELLED', cancelledAt: now, cancelledById: user.id, cancelReason: 'Rider no longer needs the evacuation seat' },
    });
    rideId = null;
  }
  await db.emergencyCheckIn.upsert({
    where: { emergencyId_associateId: { emergencyId, associateId: me.id } },
    create: { emergencyId, associateId: me.id, status: input.status, needsRide, note: input.note ?? null, rideId, respondedAt: now },
    update: { status: input.status, needsRide, note: input.note ?? null, rideId, respondedAt: now },
  });
  enqueueAudit(
    {
      actorUserId: user.id,
      clientId: me.clientId,
      action: 'emergency.check_in',
      entityType: 'Emergency',
      entityId: emergencyId,
      metadata: { associateId: me.id, status: input.status, needsRide, rideId },
    },
    'emergencyCheckIn',
  );
  const u = await db.user.findUnique({ where: { id: user.id }, select: { id: true, associateId: true, language: true } });
  return myEmergency(db, u ?? { id: user.id, associateId: me.id, language: null }, now);
}

export async function emergencyBoard(
  db: Db,
  id: string,
  viewer: { role: string; clientId: string | null },
  now: Date = new Date(),
): Promise<EmergencyBoard> {
  const e = await getEmergency(db, id);
  let people = await associatesInScope(db, e);
  // A supervisor sees their own client's floor, not the whole company.
  if ((viewer.role === 'SHIFT_SUPERVISOR' || viewer.role === 'FLOOR_SUPERVISOR' || viewer.role === 'CLIENT_PORTAL') && viewer.clientId) {
    people = people.filter((p) => p.clientId === viewer.clientId);
  }
  const checkIns = await db.emergencyCheckIn.findMany({
    where: { emergencyId: id },
    include: { ride: { select: { id: true, status: true, lat: true, lng: true } } },
  });
  const byAssociate = new Map(checkIns.map((c) => [c.associateId, c]));
  const escalateAt = new Date(e.declaredAt.getTime() + e.escalationMinutes * 60_000);
  const lapsed = now.getTime() >= escalateAt.getTime();
  const rows: EmergencyBoardRow[] = people.map((p) => {
    const c = byAssociate.get(p.id);
    return {
      associateId: p.id,
      name: `${p.firstName} ${p.lastName}`.trim(),
      siteId: p.siteId,
      siteName: p.siteName,
      clientId: p.clientId,
      phone: p.phone,
      address: p.address,
      status: c?.status ?? null,
      needsRide: c?.needsRide ?? false,
      note: c?.note ?? null,
      respondedAt: c?.respondedAt.toISOString() ?? null,
      ride: c?.ride ? { id: c.ride.id, status: c.ride.status, located: c.ride.lat !== null && c.ride.lng !== null } : null,
      overdue: !c && lapsed && e.status === 'ACTIVE',
    };
  });
  const siteMap = new Map<string, EmergencyBoard['bySite'][number]>();
  for (const r of rows) {
    const key = r.siteId ?? `client:${r.clientId ?? 'none'}`;
    let s = siteMap.get(key);
    if (!s) {
      s = { siteId: r.siteId, siteName: r.siteName, total: 0, responded: 0, safe: 0, needsHelp: 0 };
      siteMap.set(key, s);
    }
    s.total += 1;
    if (r.status) s.responded += 1;
    if (r.status === 'SAFE') s.safe += 1;
    if (r.status === 'NEEDS_HELP') s.needsHelp += 1;
  }
  const counts = {
    total: rows.length,
    responded: rows.filter((r) => r.status !== null).length,
    safe: rows.filter((r) => r.status === 'SAFE').length,
    needsHelp: rows.filter((r) => r.status === 'NEEDS_HELP').length,
    needsRide: rows.filter((r) => r.needsRide).length,
  };
  return {
    emergency: summarize(e, counts),
    rows,
    escalation: rows.filter((r) => r.overdue || r.status === 'NEEDS_HELP'),
    bySite: [...siteMap.values()],
    escalateAt: escalateAt.toISOString(),
  };
}
