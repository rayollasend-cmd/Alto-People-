import type { Prisma, PrismaClient } from '@prisma/client';
import {
  PROGRAM_ALERT_LABELS,
  type ProgramAlert,
  type ProgramAlertKind,
  type ProgramAlertSettings,
  type ProgramInput,
  type ProgramSummary,
  type ProgramType,
  type ProgramUpdate,
  type Sponsor,
  type SponsorInput,
  type SponsorReportResponse,
  type SponsorReportRow,
  type TransitionCalendarCell,
  type TransitionCalendarResponse,
} from '@alto-people/shared';
import { prisma as defaultPrisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { tenantIdForWrite } from './tenant.js';
import { netWorkedMinutes, orgDateKey } from './timeAnomalies.js';
import { addDaysToKey, dateColumnKey } from './timezone.js';

/**
 * PROGRAM LIFECYCLE — the J-1 and H-2B record and the dates it turns on.
 *
 * A program is one season for one person: the type, the sponsor, the
 * DS-2019 or the petition, start and end, the grace period, and the
 * client an H-2B petition was certified for. From those dates the module
 * computes every alert the brief asks for — program end, grace end, visa
 * and DS-2019 expiry, I-9 reverification (from the I-9 record), sponsor
 * check-ins (from the sponsor's cadence), petition end — against lead
 * times HR configures once.
 *
 * Dates are calendar dates (Postgres DATE); "today" is the org date, so
 * an alert that fires 30 days out fires 30 days out in Florida, not UTC.
 */

type Db = PrismaClient;

const DAY_MS = 86_400_000;
const ymd = dateColumnKey;
const atUtcMidnight = (s: string) => new Date(`${s}T00:00:00.000Z`);
const daysBetween = (fromYmd: string, toYmd: string) => Math.round((atUtcMidnight(toYmd).getTime() - atUtcMidnight(fromYmd).getTime()) / DAY_MS);
const addDays = addDaysToKey;

export const DEFAULT_ALERT_SETTINGS: ProgramAlertSettings = {
  programEndDays: [60, 30, 14, 7],
  visaExpiryDays: [60, 30],
  i9ReverifyDays: [90, 30, 7],
  sponsorCheckInDays: [7, 0],
  petitionEndDays: [60, 30],
};

export async function getAlertSettings(db: Db = defaultPrisma): Promise<ProgramAlertSettings> {
  const row = await db.programAlertSetting.findUnique({ where: { tenantId: tenantIdForWrite() } });
  if (!row) return DEFAULT_ALERT_SETTINGS;
  return {
    programEndDays: row.programEndDays,
    visaExpiryDays: row.visaExpiryDays,
    i9ReverifyDays: row.i9ReverifyDays,
    sponsorCheckInDays: row.sponsorCheckInDays,
    petitionEndDays: row.petitionEndDays,
  };
}

export async function saveAlertSettings(db: Db, input: ProgramAlertSettings, actorUserId: string): Promise<ProgramAlertSettings> {
  const norm = (xs: number[]) => [...new Set(xs)].sort((a, b) => b - a);
  const data = {
    programEndDays: norm(input.programEndDays),
    visaExpiryDays: norm(input.visaExpiryDays),
    i9ReverifyDays: norm(input.i9ReverifyDays),
    sponsorCheckInDays: norm(input.sponsorCheckInDays),
    petitionEndDays: norm(input.petitionEndDays),
    updatedById: actorUserId,
  };
  await db.programAlertSetting.upsert({ where: { tenantId: tenantIdForWrite() }, create: { tenantId: tenantIdForWrite(), ...data }, update: data });
  return getAlertSettings(db);
}

/* ----------------------------------------------------------------- sites */

interface SiteRef {
  siteId: string | null;
  siteName: string | null;
  clientId: string | null;
  clientName: string | null;
}

/** Where each associate works today: the open assignment, else the approved application's client. */
export async function sitesOf(db: Db, associateIds: string[]): Promise<Map<string, SiteRef>> {
  const out = new Map<string, SiteRef>();
  if (associateIds.length === 0) return out;
  const apps = await db.application.findMany({
    where: { associateId: { in: associateIds }, status: 'APPROVED' },
    select: { associateId: true, client: { select: { id: true, name: true } }, location: { select: { id: true, name: true } } },
    orderBy: { approvedAt: 'desc' },
  });
  for (const a of apps) {
    // Programs place at clients; a client-less application (a direct employer) is not a placement here.
    if (!out.has(a.associateId) && a.client) {
      out.set(a.associateId, { siteId: a.location?.id ?? null, siteName: a.location?.name ?? null, clientId: a.client.id, clientName: a.client.name });
    }
  }
  const assignments = await db.associateAssignment.findMany({
    where: { associateId: { in: associateIds }, endedAt: null },
    select: { associateId: true, location: { select: { id: true, name: true, client: { select: { id: true, name: true } } } } },
    orderBy: { startedAt: 'desc' },
  });
  const seen = new Set<string>();
  for (const a of assignments) {
    if (seen.has(a.associateId)) continue;
    seen.add(a.associateId);
    if (!a.location.client) continue;
    out.set(a.associateId, { siteId: a.location.id, siteName: a.location.name, clientId: a.location.client.id, clientName: a.location.client.name });
  }
  return out;
}

/* ---------------------------------------------------------------- shapes */

const PROGRAM_INCLUDE = {
  associate: { select: { id: true, firstName: true, lastName: true, email: true } },
  sponsor: { select: { id: true, name: true, checkInCadenceDays: true } },
  petitionClient: { select: { id: true, name: true } },
  documents: { include: { document: { select: { id: true, kind: true, filename: true, expiresAt: true } } } },
} satisfies Prisma.ProgramInclude;

type ProgramRow = Prisma.ProgramGetPayload<{ include: typeof PROGRAM_INCLUDE }>;

function statusOf(p: ProgramRow, today: string): ProgramSummary['status'] {
  if (p.closedAt) return 'CLOSED';
  const start = ymd(p.programStart);
  const end = ymd(p.programEnd);
  const grace = addDays(end, p.gracePeriodDays);
  if (today < start) return 'UPCOMING';
  if (today <= end) return 'ACTIVE';
  if (today <= grace) return 'GRACE';
  return 'ENDED';
}

function nextCheckIn(p: ProgramRow): string | null {
  if (!p.sponsor) return null;
  const base = p.lastSponsorCheckInOn ? ymd(p.lastSponsorCheckInOn) : ymd(p.programStart);
  return addDays(base, p.sponsor.checkInCadenceDays);
}

/** Every alert one program fires today, given the lead times. */
export function alertsForProgram(
  p: ProgramRow,
  site: SiteRef | undefined,
  i9WorkAuthExpiresOn: string | null,
  settings: ProgramAlertSettings,
  today: string,
): ProgramAlert[] {
  const status = statusOf(p, today);
  if (status === 'CLOSED') return [];
  // An ended program is still worth a word for a month, then it is history.
  if (status === 'ENDED' && daysBetween(ymd(p.programEnd), today) > p.gracePeriodDays + 30) return [];
  const out: ProgramAlert[] = [];
  const fire = (kind: ProgramAlertKind, dueOn: string | null, leads: number[]) => {
    if (!dueOn || leads.length === 0) return;
    const daysUntil = daysBetween(today, dueOn);
    const sorted = [...leads].sort((a, b) => a - b);
    const max = sorted[sorted.length - 1]!;
    if (daysUntil > max) return;
    const lead = sorted.find((l) => daysUntil <= l) ?? max;
    out.push({
      kind,
      label: PROGRAM_ALERT_LABELS[kind],
      dueOn,
      daysUntil,
      lead,
      severity: daysUntil < 0 || daysUntil <= sorted[0]! ? 'critical' : 'warn',
      programId: p.id,
      associateId: p.associateId,
      associateName: `${p.associate.firstName} ${p.associate.lastName}`.trim(),
      siteName: site?.siteName ?? null,
      clientId: site?.clientId ?? null,
      programType: p.type,
    });
  };
  const end = ymd(p.programEnd);
  fire('PROGRAM_END', end, settings.programEndDays);
  if (p.gracePeriodDays > 0 && status !== 'UPCOMING') fire('GRACE_END', addDays(end, p.gracePeriodDays), settings.programEndDays);
  fire('VISA_EXPIRY', p.visaExpiresOn ? ymd(p.visaExpiresOn) : null, settings.visaExpiryDays);
  fire('DS2019_EXPIRY', p.ds2019ExpiresOn ? ymd(p.ds2019ExpiresOn) : null, settings.visaExpiryDays);
  fire('I9_REVERIFY', i9WorkAuthExpiresOn, settings.i9ReverifyDays);
  if (status === 'ACTIVE') fire('SPONSOR_CHECKIN', nextCheckIn(p), settings.sponsorCheckInDays);
  if (p.type === 'H2B') fire('PETITION_END', p.petitionValidTo ? ymd(p.petitionValidTo) : null, settings.petitionEndDays);
  return out;
}

function toSummary(
  p: ProgramRow,
  site: SiteRef | undefined,
  i9: string | null,
  settings: ProgramAlertSettings,
  today: string,
): ProgramSummary {
  const end = ymd(p.programEnd);
  return {
    id: p.id,
    associateId: p.associateId,
    associateName: `${p.associate.firstName} ${p.associate.lastName}`.trim(),
    associateEmail: p.associate.email,
    siteId: site?.siteId ?? null,
    siteName: site?.siteName ?? null,
    clientId: site?.clientId ?? null,
    clientName: site?.clientName ?? null,
    type: p.type,
    sponsorId: p.sponsor?.id ?? null,
    sponsorName: p.sponsor?.name ?? null,
    ds2019Number: p.ds2019Number,
    ds2019IssuedOn: p.ds2019IssuedOn ? ymd(p.ds2019IssuedOn) : null,
    ds2019ExpiresOn: p.ds2019ExpiresOn ? ymd(p.ds2019ExpiresOn) : null,
    visaExpiresOn: p.visaExpiresOn ? ymd(p.visaExpiresOn) : null,
    sevisId: p.sevisId,
    country: p.country,
    programStart: ymd(p.programStart),
    programEnd: end,
    gracePeriodDays: p.gracePeriodDays,
    graceEndsOn: addDays(end, p.gracePeriodDays),
    secondJobStatus: p.secondJobStatus,
    h2bPetitionNumber: p.h2bPetitionNumber,
    petitionClientId: p.petitionClient?.id ?? null,
    petitionClientName: p.petitionClient?.name ?? null,
    petitionValidFrom: p.petitionValidFrom ? ymd(p.petitionValidFrom) : null,
    petitionValidTo: p.petitionValidTo ? ymd(p.petitionValidTo) : null,
    worksiteArea: p.worksiteArea,
    lastSponsorCheckInOn: p.lastSponsorCheckInOn ? ymd(p.lastSponsorCheckInOn) : null,
    nextSponsorCheckInOn: nextCheckIn(p),
    i9WorkAuthExpiresOn: i9,
    notes: p.notes,
    closedAt: p.closedAt?.toISOString() ?? null,
    closedReason: p.closedReason,
    daysUntilEnd: daysBetween(today, end),
    status: statusOf(p, today),
    documents: p.documents.map((d) => ({
      id: d.document.id,
      kind: d.document.kind,
      filename: d.document.filename,
      expiresAt: d.document.expiresAt?.toISOString() ?? null,
    })),
    alerts: alertsForProgram(p, site, i9, settings, today),
  };
}

async function i9Expiries(db: Db, associateIds: string[]): Promise<Map<string, string | null>> {
  if (associateIds.length === 0) return new Map();
  const rows = await db.i9Verification.findMany({
    where: { associateId: { in: associateIds } },
    select: { associateId: true, workAuthExpiresAt: true },
  });
  return new Map(rows.map((r) => [r.associateId, r.workAuthExpiresAt ? ymd(r.workAuthExpiresAt) : null]));
}

async function summarize(db: Db, rows: ProgramRow[], now: Date): Promise<ProgramSummary[]> {
  const ids = [...new Set(rows.map((r) => r.associateId))];
  const [sites, i9, settings] = await Promise.all([sitesOf(db, ids), i9Expiries(db, ids), getAlertSettings(db)]);
  const today = orgDateKey(now);
  return rows.map((r) => toSummary(r, sites.get(r.associateId), i9.get(r.associateId) ?? null, settings, today));
}

/* ------------------------------------------------------------------ reads */

export interface ProgramFilters {
  type?: ProgramType;
  sponsorId?: string;
  clientId?: string;
  associateId?: string;
  /** Default: everything not ended more than 60 days ago. */
  includeHistory?: boolean;
}

export async function listPrograms(db: Db, f: ProgramFilters = {}, now: Date = new Date()): Promise<ProgramSummary[]> {
  const where: Prisma.ProgramWhereInput = {
    ...(f.type ? { type: f.type } : {}),
    ...(f.sponsorId ? { sponsorId: f.sponsorId } : {}),
    ...(f.associateId ? { associateId: f.associateId } : {}),
    ...(f.includeHistory ? {} : { programEnd: { gte: new Date(now.getTime() - 60 * DAY_MS) } }),
  };
  const rows = await db.program.findMany({ where, include: PROGRAM_INCLUDE, orderBy: [{ programEnd: 'asc' }, { associate: { lastName: 'asc' } }], take: 2000 });
  const all = await summarize(db, rows, now);
  return f.clientId ? all.filter((p) => p.clientId === f.clientId || p.petitionClientId === f.clientId) : all;
}

export async function getProgram(db: Db, id: string, now: Date = new Date()): Promise<ProgramSummary> {
  const row = await db.program.findUnique({ where: { id }, include: PROGRAM_INCLUDE });
  if (!row) throw new HttpError(404, 'program_not_found', 'No such program.');
  return (await summarize(db, [row], now))[0]!;
}

/** The current (or most recent) program for one associate, for the people record. */
export async function currentProgramFor(db: Db, associateId: string, now: Date = new Date()): Promise<ProgramSummary | null> {
  const rows = await db.program.findMany({ where: { associateId }, include: PROGRAM_INCLUDE, orderBy: { programEnd: 'desc' }, take: 5 });
  if (rows.length === 0) return null;
  const all = await summarize(db, rows, now);
  return all.find((p) => p.status === 'ACTIVE' || p.status === 'GRACE' || p.status === 'UPCOMING') ?? all[0]!;
}

/** Every alert firing today, optionally for one client's people only. */
export async function currentAlerts(db: Db, opts: { clientId?: string | null } = {}, now: Date = new Date()): Promise<ProgramAlert[]> {
  const programs = await listPrograms(db, {}, now);
  const alerts = programs.flatMap((p) => p.alerts);
  const scoped = opts.clientId ? alerts.filter((a) => a.clientId === opts.clientId) : alerts;
  return scoped.sort((a, b) => a.daysUntil - b.daysUntil || a.associateName.localeCompare(b.associateName));
}

/* ----------------------------------------------------------------- writes */

function dateOrNull(s: string | null | undefined): Date | null | undefined {
  if (s === undefined) return undefined;
  return s === null ? null : atUtcMidnight(s);
}

async function assertDocumentsBelong(db: Db, associateId: string, documentIds: string[]): Promise<void> {
  if (documentIds.length === 0) return;
  const n = await db.documentRecord.count({ where: { id: { in: documentIds }, associateId } });
  if (n !== documentIds.length) throw new HttpError(400, 'document_not_found', "One of those documents is not in this associate's vault.");
}

export async function createProgram(db: Db, input: ProgramInput, actorUserId: string, now: Date = new Date()): Promise<ProgramSummary> {
  const associate = await db.associate.findFirst({ where: { id: input.associateId, deletedAt: null }, select: { id: true } });
  if (!associate) throw new HttpError(404, 'associate_not_found', 'Associate not found');
  if (input.sponsorId && !(await db.sponsor.findUnique({ where: { id: input.sponsorId }, select: { id: true } }))) {
    throw new HttpError(400, 'sponsor_not_found', 'No such sponsor.');
  }
  if (input.petitionClientId && !(await db.client.findFirst({ where: { id: input.petitionClientId, deletedAt: null }, select: { id: true } }))) {
    throw new HttpError(400, 'client_not_found', 'No such client.');
  }
  await assertDocumentsBelong(db, input.associateId, input.documentIds);
  const row = await db.program.create({
    data: {
      associateId: input.associateId,
      type: input.type,
      sponsorId: input.sponsorId ?? null,
      ds2019Number: input.ds2019Number ?? null,
      ds2019IssuedOn: dateOrNull(input.ds2019IssuedOn) ?? null,
      ds2019ExpiresOn: dateOrNull(input.ds2019ExpiresOn) ?? null,
      visaExpiresOn: dateOrNull(input.visaExpiresOn) ?? null,
      sevisId: input.sevisId ?? null,
      country: input.country ?? null,
      programStart: atUtcMidnight(input.programStart),
      programEnd: atUtcMidnight(input.programEnd),
      gracePeriodDays: input.gracePeriodDays,
      secondJobStatus: input.secondJobStatus,
      h2bPetitionNumber: input.h2bPetitionNumber ?? null,
      petitionClientId: input.petitionClientId ?? null,
      petitionValidFrom: dateOrNull(input.petitionValidFrom) ?? null,
      petitionValidTo: dateOrNull(input.petitionValidTo) ?? null,
      worksiteArea: input.worksiteArea ?? null,
      lastSponsorCheckInOn: dateOrNull(input.lastSponsorCheckInOn) ?? null,
      notes: input.notes ?? null,
      createdById: actorUserId,
      documents: { create: input.documentIds.map((documentId) => ({ documentId })) },
    },
    include: PROGRAM_INCLUDE,
  });
  if (input.type === 'J1_SWT') await db.associate.update({ where: { id: input.associateId }, data: { j1Status: true } });
  return (await summarize(db, [row], now))[0]!;
}

export async function updateProgram(db: Db, id: string, input: ProgramUpdate, now: Date = new Date()): Promise<ProgramSummary> {
  const existing = await db.program.findUnique({ where: { id }, select: { associateId: true, type: true, programStart: true, programEnd: true, petitionClientId: true } });
  if (!existing) throw new HttpError(404, 'program_not_found', 'No such program.');
  const start = input.programStart ?? ymd(existing.programStart);
  const end = input.programEnd ?? ymd(existing.programEnd);
  if (end < start) throw new HttpError(400, 'invalid_dates', 'programEnd must be on or after programStart');
  if (existing.type === 'H2B' && input.petitionClientId === null) {
    throw new HttpError(400, 'petition_client_required', 'An H-2B program names the client the petition was certified for');
  }
  if (input.documentIds) await assertDocumentsBelong(db, existing.associateId, input.documentIds);
  const row = await db.program.update({
    where: { id },
    data: {
      sponsorId: input.sponsorId,
      ds2019Number: input.ds2019Number,
      ds2019IssuedOn: dateOrNull(input.ds2019IssuedOn),
      ds2019ExpiresOn: dateOrNull(input.ds2019ExpiresOn),
      visaExpiresOn: dateOrNull(input.visaExpiresOn),
      sevisId: input.sevisId,
      country: input.country,
      programStart: input.programStart ? atUtcMidnight(input.programStart) : undefined,
      programEnd: input.programEnd ? atUtcMidnight(input.programEnd) : undefined,
      gracePeriodDays: input.gracePeriodDays,
      secondJobStatus: input.secondJobStatus,
      h2bPetitionNumber: input.h2bPetitionNumber,
      petitionClientId: input.petitionClientId,
      petitionValidFrom: dateOrNull(input.petitionValidFrom),
      petitionValidTo: dateOrNull(input.petitionValidTo),
      worksiteArea: input.worksiteArea,
      lastSponsorCheckInOn: dateOrNull(input.lastSponsorCheckInOn),
      notes: input.notes,
      ...(input.closedReason !== undefined
        ? input.closedReason === null
          ? { closedAt: null, closedReason: null }
          : { closedAt: now, closedReason: input.closedReason }
        : {}),
      ...(input.documentIds
        ? { documents: { deleteMany: {}, create: input.documentIds.map((documentId) => ({ documentId })) } }
        : {}),
    },
    include: PROGRAM_INCLUDE,
  });
  return (await summarize(db, [row], now))[0]!;
}

/** The J-1 compliance tab still writes J1Profile; keep its Program in step. */
export async function syncProgramFromJ1(
  db: Db,
  j1: { associateId: string; programStartDate: Date; programEndDate: Date; ds2019Number: string; sponsorAgency: string; sevisId: string | null; country: string },
  actorUserId: string | null,
): Promise<void> {
  const name = j1.sponsorAgency.trim();
  const sponsor = name
    ? await db.sponsor.upsert({ where: { tenantId_name: { tenantId: tenantIdForWrite(), name } }, create: { tenantId: tenantIdForWrite(), name, programType: 'J1_SWT' }, update: {}, select: { id: true } })
    : null;
  const current = await db.program.findFirst({
    where: { associateId: j1.associateId, type: 'J1_SWT', closedAt: null },
    orderBy: { programEnd: 'desc' },
    select: { id: true },
  });
  const data = {
    sponsorId: sponsor?.id ?? null,
    ds2019Number: j1.ds2019Number,
    sevisId: j1.sevisId,
    country: j1.country,
    programStart: j1.programStartDate,
    programEnd: j1.programEndDate,
  };
  if (current) await db.program.update({ where: { id: current.id }, data });
  else await db.program.create({ data: { associateId: j1.associateId, type: 'J1_SWT', createdById: actorUserId, ...data } });
}

/* --------------------------------------------------------------- sponsors */

const sponsorShape = (s: Prisma.SponsorGetPayload<{ include: { _count: { select: { programs: true } } } }>, active: number): Sponsor => ({
  id: s.id,
  name: s.name,
  programType: s.programType,
  contactName: s.contactName,
  contactEmail: s.contactEmail,
  contactPhone: s.contactPhone,
  website: s.website,
  checkInCadenceDays: s.checkInCadenceDays,
  checkInRequirements: s.checkInRequirements,
  reportingCadence: s.reportingCadence,
  notes: s.notes,
  isActive: s.isActive,
  activeParticipants: active,
});

export async function listSponsors(db: Db, now: Date = new Date()): Promise<Sponsor[]> {
  const rows = await db.sponsor.findMany({ include: { _count: { select: { programs: true } } }, orderBy: { name: 'asc' } });
  const active = await db.program.groupBy({
    by: ['sponsorId'],
    where: { sponsorId: { not: null }, closedAt: null, programEnd: { gte: atUtcMidnight(orgDateKey(now)) } },
    _count: { _all: true },
  });
  const activeBy = new Map(active.map((a) => [a.sponsorId, a._count._all]));
  return rows.map((r) => sponsorShape(r, activeBy.get(r.id) ?? 0));
}

export async function getSponsor(db: Db, id: string, now: Date = new Date()): Promise<Sponsor> {
  const s = (await listSponsors(db, now)).find((x) => x.id === id);
  if (!s) throw new HttpError(404, 'sponsor_not_found', 'No such sponsor.');
  return s;
}

export async function createSponsor(db: Db, input: SponsorInput): Promise<Sponsor> {
  const dupe = await db.sponsor.findUnique({ where: { tenantId_name: { tenantId: tenantIdForWrite(), name: input.name } }, select: { id: true } });
  if (dupe) throw new HttpError(409, 'sponsor_exists', 'A sponsor with that name already exists.');
  const row = await db.sponsor.create({ data: { ...input }, include: { _count: { select: { programs: true } } } });
  return sponsorShape(row, 0);
}

export async function updateSponsor(db: Db, id: string, input: Partial<SponsorInput>): Promise<Sponsor> {
  if (input.name) {
    const dupe = await db.sponsor.findFirst({ where: { name: input.name, NOT: { id } }, select: { id: true } });
    if (dupe) throw new HttpError(409, 'sponsor_exists', 'A sponsor with that name already exists.');
  }
  await db.sponsor.update({ where: { id }, data: { ...input } });
  return getSponsor(db, id);
}

/* ------------------------------------------------------------- calendar */

export interface CalendarFilters {
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD, inclusive
  locationId?: string;
  clientId?: string;
}

function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.slice(0, 7).split('-').map(Number) as [number, number];
  const end = to.slice(0, 7);
  for (let i = 0; i < 36; i++) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    out.push(key);
    if (key >= end) break;
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/**
 * Arrivals (program starts), program ends, and departures (separations)
 * by month, site and channel. Counts and dates only — nothing a client
 * should not see.
 */
export async function transitionCalendar(db: Db, f: CalendarFilters): Promise<TransitionCalendarResponse> {
  const from = atUtcMidnight(f.from);
  const to = atUtcMidnight(f.to);
  const rows = await db.program.findMany({
    where: {
      closedAt: null,
      OR: [{ programStart: { gte: from, lte: to } }, { programEnd: { gte: from, lte: to } }],
    },
    select: { associateId: true, type: true, programStart: true, programEnd: true },
  });
  const ids = [...new Set(rows.map((r) => r.associateId))];
  const sites = await sitesOf(db, ids);
  const departures = await db.separation.findMany({
    where: { associateId: { in: ids }, lastDayWorked: { gte: from, lte: to } },
    select: { associateId: true, lastDayWorked: true },
  });
  const typeOf = new Map(rows.map((r) => [r.associateId, r.type]));
  const keep = (associateId: string) => {
    const s = sites.get(associateId);
    if (f.locationId && s?.siteId !== f.locationId) return false;
    if (f.clientId && s?.clientId !== f.clientId) return false;
    return true;
  };
  const cells = new Map<string, TransitionCalendarCell>();
  const bump = (associateId: string, month: string, field: 'arrivals' | 'programEnds' | 'departures', channel: ProgramType) => {
    if (!keep(associateId)) return;
    const s = sites.get(associateId);
    const key = `${month}|${s?.siteId ?? 'none'}|${channel}`;
    let c = cells.get(key);
    if (!c) {
      c = {
        month,
        siteId: s?.siteId ?? null,
        siteName: s?.siteName ?? 'Unplaced',
        clientId: s?.clientId ?? null,
        clientName: s?.clientName ?? '—',
        channel,
        arrivals: 0,
        programEnds: 0,
        departures: 0,
      };
      cells.set(key, c);
    }
    c[field] += 1;
  };
  for (const r of rows) {
    const start = ymd(r.programStart);
    const end = ymd(r.programEnd);
    if (start >= f.from && start <= f.to) bump(r.associateId, start.slice(0, 7), 'arrivals', r.type);
    if (end >= f.from && end <= f.to) bump(r.associateId, end.slice(0, 7), 'programEnds', r.type);
  }
  for (const d of departures) {
    bump(d.associateId, ymd(d.lastDayWorked).slice(0, 7), 'departures', typeOf.get(d.associateId) ?? 'DOMESTIC');
  }
  const list = [...cells.values()].sort((a, b) => a.month.localeCompare(b.month) || a.siteName.localeCompare(b.siteName) || a.channel.localeCompare(b.channel));
  return {
    from: f.from,
    to: f.to,
    months: monthsBetween(f.from, f.to),
    cells: list,
    totals: {
      arrivals: list.reduce((s, c) => s + c.arrivals, 0),
      programEnds: list.reduce((s, c) => s + c.programEnds, 0),
      departures: list.reduce((s, c) => s + c.departures, 0),
    },
  };
}

/* ---------------------------------------------------------------- report */

/** Per sponsor: who was placed where, hours, housing, incidents, departures. */
export async function sponsorReport(db: Db, sponsorId: string, from: string, to: string, now: Date = new Date()): Promise<SponsorReportResponse> {
  const sponsor = await getSponsor(db, sponsorId, now);
  const fromD = atUtcMidnight(from);
  const toD = new Date(atUtcMidnight(to).getTime() + DAY_MS);
  const programs = await db.program.findMany({
    where: { sponsorId, programStart: { lt: toD }, programEnd: { gte: fromD } },
    include: PROGRAM_INCLUDE,
    orderBy: [{ associate: { lastName: 'asc' } }],
  });
  const ids = programs.map((p) => p.associateId);
  const [sites, people, entries, incidents, separations] = await Promise.all([
    sitesOf(db, ids),
    db.associate.findMany({
      where: { id: { in: ids } },
      select: { id: true, addressLine1: true, city: true, state: true, ridePlaces: { select: { label: true, address: true }, take: 5 } },
    }),
    db.timeEntry.findMany({
      where: { associateId: { in: ids }, clockInAt: { gte: fromD, lt: toD }, clockOutAt: { not: null }, status: { not: 'REJECTED' } },
      select: { associateId: true, clockInAt: true, clockOutAt: true, breaks: { select: { type: true, startedAt: true, endedAt: true } } },
    }),
    db.oshaIncident.groupBy({ by: ['associateId'], where: { associateId: { in: ids }, occurredAt: { gte: fromD, lt: toD } }, _count: { _all: true } }),
    db.separation.findMany({ where: { associateId: { in: ids }, lastDayWorked: { gte: fromD, lt: toD } }, select: { associateId: true, lastDayWorked: true, reason: true } }),
  ]);
  const minutes = new Map<string, number>();
  for (const e of entries) {
    minutes.set(e.associateId, (minutes.get(e.associateId) ?? 0) + netWorkedMinutes(e, e.breaks.map((b) => ({ type: b.type as 'MEAL' | 'REST', startedAt: b.startedAt, endedAt: b.endedAt }))));
  }
  const incidentsBy = new Map(incidents.map((i) => [i.associateId, i._count._all]));
  const departureBy = new Map(separations.map((s) => [s.associateId, s]));
  const personBy = new Map(people.map((p) => [p.id, p]));
  const rows: SponsorReportRow[] = programs.map((p) => {
    const person = personBy.get(p.associateId);
    const home = person?.ridePlaces.find((r) => /home|casa/i.test(r.label))?.address ?? null;
    const onFile = person ? [person.addressLine1, [person.city, person.state].filter(Boolean).join(', ')].filter((x) => x && String(x).trim()).join(', ') : '';
    const dep = departureBy.get(p.associateId);
    const site = sites.get(p.associateId);
    return {
      associateId: p.associateId,
      associateName: `${p.associate.firstName} ${p.associate.lastName}`.trim(),
      country: p.country,
      programStart: ymd(p.programStart),
      programEnd: ymd(p.programEnd),
      siteName: site?.siteName ?? null,
      clientName: site?.clientName ?? null,
      hours: Math.round(((minutes.get(p.associateId) ?? 0) / 60) * 10) / 10,
      housing: home ?? (onFile || null),
      incidents: incidentsBy.get(p.associateId) ?? 0,
      lastSponsorCheckInOn: p.lastSponsorCheckInOn ? ymd(p.lastSponsorCheckInOn) : null,
      departure: dep ? { lastDayWorked: ymd(dep.lastDayWorked), reason: dep.reason } : null,
    };
  });
  return {
    sponsor,
    from,
    to,
    rows,
    totals: {
      participants: rows.length,
      hours: Math.round(rows.reduce((s, r) => s + r.hours, 0) * 10) / 10,
      incidents: rows.reduce((s, r) => s + r.incidents, 0),
      departures: rows.filter((r) => r.departure).length,
    },
  };
}
