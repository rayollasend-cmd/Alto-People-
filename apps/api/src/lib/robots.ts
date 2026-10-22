import type { Prisma, PrismaClient, RobotConnectorStatus as DbRobotStatus } from '@prisma/client';
import type {
  ChecklistAnswer,
  ChecklistItem,
  ChecklistRunInput,
  ChecklistTemplateInput,
  CommissioningInput,
  FleetProvider,
  MaintenanceInput,
  RobotChecklistRunSummary,
  RobotChecklistTemplateSummary,
  RobotCommissioningSummary,
  RobotDetail,
  RobotEventSummary,
  RobotIncidentDetail,
  RobotIncidentInput,
  RobotIncidentSummary,
  RobotMaintenanceSummary,
  RobotProfileInput,
  RobotProfileSummary,
  RobotRow,
  RobotsResponse,
  RobotStatusSampleSummary,
  SafetyZoneInput,
  SiteSafetyZoneSummary,
  ZoneShape,
} from '@alto-people/shared';
import { prisma as defaultPrisma } from '../db.js';
import { policyFor } from './tasks/engine.js';
import { spanOfControlAt } from './tasks/spanOfControl.js';
import { HttpError } from '../middleware/error.js';
import { enqueueAudit } from './audit.js';
import { fleetConnector, fleetProviderFromEnv, registerSimulatedRobot, type FleetRobotStatus } from './fleet/index.js';
import { displayName } from './messaging.js';
import { shiftTimezone } from './shiftZone.js';

/**
 * Brief 3-1 — the robot registry behind /robots.
 *
 * A robot is a Worker of type ROBOT (owner, status, capabilities from
 * Brief 1D-1). This module owns what a fleet needs beyond that: the
 * profile, the connector's status time series, the site commissioning
 * and its safety zones, the pre-shift checklist, the event log, the
 * maintenance history and incident evidence. The two safety rules live
 * here and nowhere else: a robot's shift starts only after a passing
 * checklist for it, and never inside a zone guests occupy.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export const SAMPLE_RETENTION_DAYS = 90;
export const EVIDENCE_RETENTION_YEARS = 5;
/** A checklist counts for a shift when it was completed inside this window before the start. */
export const CHECKLIST_WINDOW_HOURS = 12;

const nameOf = (u: { id: string; email: string; associate?: { firstName: string; lastName: string } | null } | null | undefined) =>
  u ? { id: u.id, name: displayName(u) } : null;

const userSelect = { select: { id: true, email: true, associate: { select: { firstName: true, lastName: true } } } } as const;

/* ------------------------------------------------------------ profile -- */

function profileSummary(p: {
  manufacturer: string;
  model: string;
  serial: string;
  firmware: string | null;
  ownership: 'OWNED' | 'LEASED';
  leaseEndsOn: Date | null;
  connectorProvider: string;
  connectorExternalId: string | null;
  certifications: unknown;
  notes: string | null;
}): RobotProfileSummary {
  return {
    manufacturer: p.manufacturer,
    model: p.model,
    serial: p.serial,
    firmware: p.firmware,
    ownership: p.ownership,
    leaseEndsOn: p.leaseEndsOn ? p.leaseEndsOn.toISOString().slice(0, 10) : null,
    connectorProvider: (['SIMULATED', 'BEAR', 'PUDU'].includes(p.connectorProvider) ? p.connectorProvider : 'SIMULATED') as FleetProvider,
    connectorExternalId: p.connectorExternalId,
    certifications: Array.isArray(p.certifications) ? (p.certifications as RobotProfileSummary['certifications']) : [],
    notes: p.notes,
  };
}

async function robotWorker(db: Db, id: string) {
  const w = await db.worker.findUnique({
    where: { id },
    select: { id: true, type: true, name: true, status: true, tenantId: true, capabilities: true, notes: true, createdAt: true, owner: userSelect, robot: true },
  });
  if (!w || w.type !== 'ROBOT') throw new HttpError(404, 'robot_not_found', 'No such robot.');
  return w;
}

/** A ROBOT worker gets a profile the first time anything asks for it. */
export async function ensureRobotProfile(db: Db, workerId: string, tenantId: string | null) {
  const existing = await db.robotProfile.findUnique({ where: { workerId } });
  if (existing) return existing;
  const w = await db.worker.findUnique({ where: { id: workerId }, select: { type: true, name: true } });
  if (!w || w.type !== 'ROBOT') throw new HttpError(404, 'robot_not_found', 'No such robot.');
  const externalId = `sim-${workerId.slice(0, 8)}`;
  registerSimulatedRobot(externalId);
  return db.robotProfile.create({
    data: { workerId, tenantId: tenantId ?? undefined, manufacturer: 'Unknown', model: w.name, serial: `pending-${workerId.slice(0, 8)}`, connectorProvider: 'SIMULATED', connectorExternalId: externalId },
  });
}

export async function updateRobotProfile(db: Db, workerId: string, input: RobotProfileInput, actorUserId: string): Promise<RobotDetail> {
  const w = await robotWorker(db, workerId);
  await ensureRobotProfile(db, workerId, w.tenantId);
  const data: Prisma.RobotProfileUpdateInput = {
    manufacturer: input.manufacturer,
    model: input.model,
    serial: input.serial,
    firmware: input.firmware ?? null,
    ...(input.ownership ? { ownership: input.ownership } : {}),
    leaseEndsOn: input.leaseEndsOn ? new Date(`${input.leaseEndsOn}T12:00:00Z`) : null,
    ...(input.connectorProvider ? { connectorProvider: input.connectorProvider } : {}),
    connectorExternalId: input.connectorExternalId ?? null,
    ...(input.certifications ? { certifications: input.certifications as Prisma.InputJsonValue } : {}),
    notes: input.notes ?? null,
  };
  await db.robotProfile.update({ where: { workerId }, data });
  if ((input.connectorProvider ?? 'SIMULATED') === 'SIMULATED' && input.connectorExternalId) registerSimulatedRobot(input.connectorExternalId);
  enqueueAudit({ actorUserId, clientId: null, workerId, action: 'robot.profile_updated', entityType: 'RobotProfile', entityId: workerId, metadata: { serial: input.serial, manufacturer: input.manufacturer, model: input.model } }, 'robots');
  return getRobot(db, workerId);
}

/* ------------------------------------------------------------ samples -- */

function sampleSummary(s: { at: Date; status: DbRobotStatus; batteryPct: number | null; x: number | null; y: number | null; currentTask: string | null; errorCode: string | null }): RobotStatusSampleSummary {
  return { at: s.at.toISOString(), status: s.status, batteryPct: s.batteryPct, x: s.x, y: s.y, currentTask: s.currentTask, errorCode: s.errorCode };
}

/**
 * One sampling pass for a tenant: every ACTIVE or SUSPENDED robot with a
 * profile is read from its fleet and a sample stored. A fresh ERROR is
 * also an event. Samples older than the retention window are dropped.
 */
export async function sampleRobots(db: PrismaClient = defaultPrisma, tenantId: string | null = null, now: Date = new Date()): Promise<{ sampled: number; errors: number }> {
  const robots = await db.worker.findMany({
    where: { type: 'ROBOT', status: { in: ['ACTIVE', 'SUSPENDED', 'ONBOARDING'] }, ...(tenantId ? { tenantId } : {}) },
    select: { id: true, tenantId: true, robot: { select: { connectorProvider: true, connectorExternalId: true } } },
  });
  let sampled = 0;
  let errors = 0;
  for (const r of robots) {
    const profile = r.robot ?? (await ensureRobotProfile(db, r.id, r.tenantId));
    const externalId = profile.connectorExternalId;
    if (!externalId) continue;
    const provider = profile.connectorProvider as FleetProvider;
    const connector = fleetConnector(provider === fleetProviderFromEnv() ? provider : 'SIMULATED');
    const reading = (await connector.getStatus(externalId, now)) ?? null;
    if (!reading) continue;
    await storeSample(db, r.id, r.tenantId, reading);
    sampled++;
    if (reading.status === 'ERROR') errors++;
  }
  const cutoff = new Date(now.getTime() - SAMPLE_RETENTION_DAYS * 86_400_000);
  await db.robotStatusSample.deleteMany({ where: { at: { lt: cutoff }, ...(tenantId ? { tenantId } : {}) } });
  return { sampled, errors };
}

export async function storeSample(db: Db, workerId: string, tenantId: string | null, reading: FleetRobotStatus): Promise<void> {
  const previous = await db.robotStatusSample.findFirst({ where: { workerId }, orderBy: { at: 'desc' }, select: { status: true } });
  await db.robotStatusSample.create({
    data: {
      workerId,
      tenantId: tenantId ?? undefined,
      at: reading.at,
      status: reading.status,
      batteryPct: reading.batteryPct,
      x: reading.x,
      y: reading.y,
      currentTask: reading.currentTask,
      errorCode: reading.errorCode,
      raw: (reading.raw ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
  if (reading.status === 'ERROR' && previous?.status !== 'ERROR') {
    await db.robotEvent.create({ data: { workerId, tenantId: tenantId ?? undefined, kind: 'ERROR', at: reading.at, note: reading.errorCode ?? 'The fleet reported an error.', metadata: { errorCode: reading.errorCode } } });
  }
}

export async function listSamples(db: Db, workerId: string, hours = 24, now: Date = new Date()): Promise<RobotStatusSampleSummary[]> {
  await robotWorker(db, workerId);
  const rows = await db.robotStatusSample.findMany({
    where: { workerId, at: { gte: new Date(now.getTime() - hours * 3_600_000) } },
    orderBy: { at: 'asc' },
    take: 2000,
  });
  return rows.map(sampleSummary);
}

/* -------------------------------------------------------------- zones -- */

export function pointInZone(shape: ZoneShape, x: number, y: number): boolean {
  if (shape.type === 'rect') return x >= shape.x && x <= shape.x + shape.w && y >= shape.y && y <= shape.y + shape.h;
  // Ray casting over the polygon.
  let inside = false;
  const pts = shape.points;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]!;
    const [xj, yj] = pts[j]!;
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function zoneSummary(z: { id: string; locationId: string; name: string; shape: unknown; guestOccupied: boolean; robotsAllowedWhenOccupied: boolean; occupiedSince: Date | null }): SiteSafetyZoneSummary {
  return { id: z.id, locationId: z.locationId, name: z.name, shape: z.shape as unknown as ZoneShape, guestOccupied: z.guestOccupied, robotsAllowedWhenOccupied: z.robotsAllowedWhenOccupied, occupiedSince: z.occupiedSince?.toISOString() ?? null };
}

export async function listZones(db: Db, locationId: string, tenantId: string | null): Promise<SiteSafetyZoneSummary[]> {
  const site = await db.site.findFirst({ where: { id: locationId, ...(tenantId ? { tenantId } : {}) }, select: { id: true } });
  if (!site) throw new HttpError(404, 'site_not_found', 'No such site.');
  const rows = await db.siteSafetyZone.findMany({ where: { locationId }, orderBy: { name: 'asc' } });
  return rows.map(zoneSummary);
}

export async function createZone(db: Db, locationId: string, input: SafetyZoneInput, tenantId: string | null, actorUserId: string): Promise<SiteSafetyZoneSummary> {
  const site = await db.site.findUnique({ where: { id: locationId }, select: { id: true } });
  if (!site) throw new HttpError(404, 'site_not_found', 'No such site.');
  const z = await db.siteSafetyZone.create({ data: { locationId, tenantId: tenantId ?? undefined, name: input.name, shape: input.shape as Prisma.InputJsonValue, robotsAllowedWhenOccupied: input.robotsAllowedWhenOccupied ?? false } });
  enqueueAudit({ actorUserId, clientId: null, action: 'robot.zone_created', entityType: 'SiteSafetyZone', entityId: z.id, metadata: { locationId, name: input.name } }, 'robots');
  return zoneSummary(z);
}

export async function updateZone(db: Db, zoneId: string, input: Partial<SafetyZoneInput>, actorUserId: string): Promise<SiteSafetyZoneSummary> {
  const z = await db.siteSafetyZone.update({
    where: { id: zoneId },
    data: { ...(input.name ? { name: input.name } : {}), ...(input.shape ? { shape: input.shape as Prisma.InputJsonValue } : {}), ...(input.robotsAllowedWhenOccupied !== undefined ? { robotsAllowedWhenOccupied: input.robotsAllowedWhenOccupied } : {}) },
  });
  enqueueAudit({ actorUserId, clientId: null, action: 'robot.zone_updated', entityType: 'SiteSafetyZone', entityId: z.id, metadata: input as Prisma.InputJsonValue }, 'robots');
  return zoneSummary(z);
}

export async function setZoneOccupied(db: Db, zoneId: string, occupied: boolean, actorUserId: string, now: Date = new Date()): Promise<SiteSafetyZoneSummary> {
  const z = await db.siteSafetyZone.update({
    where: { id: zoneId },
    data: { guestOccupied: occupied, occupiedSince: occupied ? now : null, occupiedByUserId: occupied ? actorUserId : null },
  });
  enqueueAudit({ actorUserId, clientId: null, action: occupied ? 'robot.zone_occupied' : 'robot.zone_cleared', entityType: 'SiteSafetyZone', entityId: z.id, metadata: { name: z.name } }, 'robots');
  return zoneSummary(z);
}

/**
 * The zone rule: a robot at (x, y) on a site may not operate inside a
 * zone guests occupy unless that zone allows it. Returns the blocking
 * zone, or null. A robot with no known position is not blocked (nothing
 * to place it in) — the checklist still gates its shift.
 */
export async function blockingZone(db: Db, locationId: string, x: number | null, y: number | null): Promise<SiteSafetyZoneSummary | null> {
  if (x === null || y === null) return null;
  const zones = await db.siteSafetyZone.findMany({ where: { locationId, guestOccupied: true, robotsAllowedWhenOccupied: false } });
  for (const z of zones) if (pointInZone(z.shape as unknown as ZoneShape, x, y)) return zoneSummary(z);
  return null;
}

/* --------------------------------------------------------- checklists -- */

function templateSummary(t: { id: string; locationId: string | null; name: string; items: unknown; active: boolean }): RobotChecklistTemplateSummary {
  return { id: t.id, locationId: t.locationId, name: t.name, items: (t.items as unknown as ChecklistItem[]) ?? [], active: t.active };
}

/** The templates a robot at `locationId` may use (active, tenant-wide or that site's); `all` lists every template for the editor. */
export async function listChecklistTemplates(db: Db, locationId: string | null, tenantId: string | null, opts: { all?: boolean } = {}): Promise<RobotChecklistTemplateSummary[]> {
  const rows = await db.robotChecklistTemplate.findMany({
    where: opts.all
      ? { ...(tenantId ? { tenantId } : {}) }
      : { active: true, OR: [{ locationId: null }, ...(locationId ? [{ locationId }] : [])], ...(tenantId ? { tenantId } : {}) },
    orderBy: [{ active: 'desc' }, { locationId: 'desc' }, { name: 'asc' }],
  });
  return rows.map(templateSummary);
}

export async function upsertChecklistTemplate(db: Db, input: ChecklistTemplateInput, tenantId: string | null, actorUserId: string, id?: string): Promise<RobotChecklistTemplateSummary> {
  const data = { locationId: input.locationId ?? null, name: input.name, items: input.items as Prisma.InputJsonValue, active: input.active ?? true };
  const t = id ? await db.robotChecklistTemplate.update({ where: { id }, data }) : await db.robotChecklistTemplate.create({ data: { ...data, tenantId: tenantId ?? undefined } });
  enqueueAudit({ actorUserId, clientId: null, action: id ? 'robot.checklist_template_updated' : 'robot.checklist_template_created', entityType: 'RobotChecklistTemplate', entityId: t.id, metadata: { name: input.name, items: input.items.length } }, 'robots');
  return templateSummary(t);
}

function runSummary(r: { id: string; shiftId: string | null; templateId: string; template: { name: string }; completedBy: { id: string; email: string; associate: { firstName: string; lastName: string } | null }; completedAt: Date; answers: unknown; allPassed: boolean }): RobotChecklistRunSummary {
  return { id: r.id, shiftId: r.shiftId, templateId: r.templateId, templateName: r.template.name, completedBy: nameOf(r.completedBy)!, completedAt: r.completedAt.toISOString(), answers: (r.answers as unknown as ChecklistAnswer[]) ?? [], allPassed: r.allPassed };
}

const runInclude = { template: { select: { name: true } }, completedBy: userSelect } as const;

export async function completeChecklist(db: Db, workerId: string, input: ChecklistRunInput, actorUserId: string, now: Date = new Date()): Promise<RobotChecklistRunSummary> {
  const w = await robotWorker(db, workerId);
  const template = await db.robotChecklistTemplate.findUnique({ where: { id: input.templateId } });
  if (!template || !template.active) throw new HttpError(404, 'checklist_template_not_found', 'No such checklist.');
  const items = (template.items as unknown as ChecklistItem[]) ?? [];
  const byKey = new Map(input.answers.map((a) => [a.key, a]));
  const missingRequired = items.filter((i) => i.required && !byKey.has(i.key)).map((i) => i.key);
  if (missingRequired.length) throw new HttpError(400, 'checklist_incomplete', `Every required item needs an answer: ${missingRequired.join(', ')}.`, { missing: missingRequired });
  const allPassed = items.every((i) => !i.required || byKey.get(i.key)?.ok === true);
  if (input.shiftId) {
    const shift = await db.shift.findUnique({ where: { id: input.shiftId }, select: { id: true, workerId: true } });
    if (!shift) throw new HttpError(404, 'shift_not_found', 'No such shift.');
    if (shift.workerId !== workerId) throw new HttpError(409, 'shift_not_this_robot', 'That shift is not this robot’s.');
  }
  const run = await db.robotChecklistRun.create({
    data: { workerId, tenantId: w.tenantId, shiftId: input.shiftId ?? null, templateId: template.id, completedByUserId: actorUserId, completedAt: now, answers: input.answers as Prisma.InputJsonValue, allPassed },
    include: runInclude,
  });
  await db.robotEvent.create({ data: { workerId, tenantId: w.tenantId, kind: 'CHECKLIST_COMPLETED', at: now, byUserId: actorUserId, shiftId: input.shiftId ?? null, note: allPassed ? `${template.name}: all clear` : `${template.name}: a required item failed`, metadata: { runId: run.id, allPassed } } });
  enqueueAudit({ actorUserId, clientId: null, workerId, action: 'robot.checklist_completed', entityType: 'RobotChecklistRun', entityId: run.id, metadata: { allPassed, shiftId: input.shiftId ?? null } }, 'robots');
  return runSummary(run);
}

export async function listChecklistRuns(db: Db, workerId: string, limit = 50): Promise<RobotChecklistRunSummary[]> {
  await robotWorker(db, workerId);
  const rows = await db.robotChecklistRun.findMany({ where: { workerId }, orderBy: { completedAt: 'desc' }, take: limit, include: runInclude });
  return rows.map(runSummary);
}

/** A passing run for this shift, or any passing run inside the window before `at`. */
async function passingChecklistFor(db: Db, workerId: string, shiftId: string | null, at: Date): Promise<boolean> {
  const since = new Date(at.getTime() - CHECKLIST_WINDOW_HOURS * 3_600_000);
  const run = await db.robotChecklistRun.findFirst({
    where: { workerId, allPassed: true, OR: [...(shiftId ? [{ shiftId }] : []), { completedAt: { gte: since, lte: new Date(at.getTime() + 3_600_000) } }] },
    select: { id: true },
  });
  return !!run;
}

/* ------------------------------------------------------- shift start -- */

/**
 * The gate every robot shift goes through. Refuses without a passing
 * checklist, without a signed-off commissioning at the shift's site, and
 * inside a zone guests occupy. Records the start as an event.
 */
export async function startRobotShift(db: Db, workerId: string, shiftId: string, actorUserId: string, now: Date = new Date()): Promise<{ shiftId: string; startedAt: string; warnings: string[] }> {
  const w = await robotWorker(db, workerId);
  if (w.status === 'SUSPENDED') throw new HttpError(409, 'robot_stopped', `${w.name} is under an emergency stop. Resume it first.`);
  if (w.status === 'OFFBOARDED') throw new HttpError(409, 'robot_offboarded', `${w.name} is offboarded.`);
  const shift = await db.shift.findUnique({ where: { id: shiftId }, select: { id: true, workerId: true, locationId: true, status: true, startsAt: true } });
  if (!shift) throw new HttpError(404, 'shift_not_found', 'No such shift.');
  if (shift.workerId !== workerId) throw new HttpError(409, 'shift_not_this_robot', 'That shift is not this robot’s.');
  if (shift.status === 'CANCELLED' || shift.status === 'COMPLETED') throw new HttpError(409, 'shift_closed', 'That shift is over.');
  if (!(await passingChecklistFor(db, workerId, shiftId, now))) {
    throw new HttpError(409, 'checklist_incomplete', 'The crew lead has not completed the pre-shift checklist for this robot.');
  }
  if (shift.locationId) {
    const commissioning = await db.robotCommissioning.findUnique({ where: { workerId_locationId: { workerId, locationId: shift.locationId } }, select: { signedOffAt: true } });
    if (!commissioning?.signedOffAt) throw new HttpError(409, 'not_commissioned', 'This robot is not commissioned at this site: the safety lead has not signed off.');
    const latest = await db.robotStatusSample.findFirst({ where: { workerId }, orderBy: { at: 'desc' }, select: { x: true, y: true } });
    const zone = await blockingZone(db, shift.locationId, latest?.x ?? null, latest?.y ?? null);
    if (zone) throw new HttpError(409, 'zone_occupied', `${zone.name} is occupied by guests; the robot may not operate there.`, { zoneId: zone.id });
  }
  await db.robotEvent.create({ data: { workerId, tenantId: w.tenantId, kind: 'SHIFT_STARTED', at: now, byUserId: actorUserId, shiftId } });
  enqueueAudit({ actorUserId, clientId: null, workerId, action: 'robot.shift_started', entityType: 'Shift', entityId: shiftId }, 'robots');
  // Brief 3-3: the span of control is a warning on the start, never a block.
  const warnings: string[] = [];
  if (shift.locationId) {
    const policy = await policyFor(db, shift.locationId);
    const span = await spanOfControlAt(db, shift.locationId, policy.maxRobotsPerCrewLead, now);
    if (span.exceeded || span.leads === 0) warnings.push(`Span of control: ${span.text}`);
  }
  return { shiftId, startedAt: now.toISOString(), warnings };
}

/* ----------------------------------------------------- stop / resume -- */

export async function emergencyStop(db: Db, workerId: string, actorUserId: string, note: string | null, now: Date = new Date()): Promise<RobotDetail> {
  const w = await robotWorker(db, workerId);
  const profile = await ensureRobotProfile(db, workerId, w.tenantId);
  if (profile.connectorExternalId) {
    const provider = profile.connectorProvider as FleetProvider;
    await fleetConnector(provider === fleetProviderFromEnv() ? provider : 'SIMULATED').stop(profile.connectorExternalId);
  }
  await db.worker.update({ where: { id: workerId }, data: { status: 'SUSPENDED' } });
  await db.robotEvent.create({ data: { workerId, tenantId: w.tenantId, kind: 'E_STOP', at: now, byUserId: actorUserId, note } });
  await db.robotStatusSample.create({ data: { workerId, tenantId: w.tenantId, at: now, status: 'STOPPED', currentTask: null } });
  enqueueAudit({ actorUserId, clientId: null, workerId, action: 'robot.emergency_stop', entityType: 'Worker', entityId: workerId, metadata: { note } }, 'robots');
  return getRobot(db, workerId, now);
}

export async function resumeRobot(db: Db, workerId: string, actorUserId: string, note: string | null, now: Date = new Date()): Promise<RobotDetail> {
  const w = await robotWorker(db, workerId);
  const profile = await ensureRobotProfile(db, workerId, w.tenantId);
  if (profile.connectorExternalId) {
    const provider = profile.connectorProvider as FleetProvider;
    await fleetConnector(provider === fleetProviderFromEnv() ? provider : 'SIMULATED').resume(profile.connectorExternalId);
  }
  await db.worker.update({ where: { id: workerId }, data: { status: 'ACTIVE' } });
  await db.robotEvent.create({ data: { workerId, tenantId: w.tenantId, kind: 'RESUME', at: now, byUserId: actorUserId, note } });
  enqueueAudit({ actorUserId, clientId: null, workerId, action: 'robot.resumed', entityType: 'Worker', entityId: workerId, metadata: { note } }, 'robots');
  return getRobot(db, workerId, now);
}

/* ------------------------------------------------------ commissioning -- */

function commissioningSummary(c: { id: string; locationId: string; site: { name: string }; mapUrl: string | null; mapNotes: string | null; chargingStations: unknown; safetyLead: { id: string; email: string; associate: { firstName: string; lastName: string } | null } | null; signedOffAt: Date | null; notes: string | null }): RobotCommissioningSummary {
  return { id: c.id, locationId: c.locationId, locationName: c.site.name, mapUrl: c.mapUrl, mapNotes: c.mapNotes, chargingStations: (c.chargingStations as unknown as RobotCommissioningSummary['chargingStations']) ?? [], safetyLead: nameOf(c.safetyLead), signedOffAt: c.signedOffAt?.toISOString() ?? null, notes: c.notes };
}

const commissioningInclude = { site: { select: { name: true } }, safetyLead: userSelect } as const;

export async function upsertCommissioning(db: Db, workerId: string, input: CommissioningInput, actorUserId: string): Promise<RobotCommissioningSummary> {
  const w = await robotWorker(db, workerId);
  const site = await db.site.findUnique({ where: { id: input.locationId }, select: { id: true } });
  if (!site) throw new HttpError(404, 'site_not_found', 'No such site.');
  const data = { mapUrl: input.mapUrl ?? null, mapNotes: input.mapNotes ?? null, chargingStations: (input.chargingStations ?? []) as Prisma.InputJsonValue, safetyLeadUserId: input.safetyLeadUserId ?? null, notes: input.notes ?? null };
  const c = await db.robotCommissioning.upsert({
    where: { workerId_locationId: { workerId, locationId: input.locationId } },
    // A changed map or lead means the sign-off no longer covers it.
    update: { ...data, signedOffAt: null },
    create: { ...data, workerId, locationId: input.locationId, tenantId: w.tenantId },
    include: commissioningInclude,
  });
  enqueueAudit({ actorUserId, clientId: null, workerId, action: 'robot.commissioning_saved', entityType: 'RobotCommissioning', entityId: c.id, metadata: { locationId: input.locationId } }, 'robots');
  return commissioningSummary(c);
}

/** Only the named safety lead signs off, and only after a lead is named. */
export async function signOffCommissioning(db: Db, workerId: string, locationId: string, actorUserId: string, now: Date = new Date()): Promise<RobotCommissioningSummary> {
  const w = await robotWorker(db, workerId);
  const c = await db.robotCommissioning.findUnique({ where: { workerId_locationId: { workerId, locationId } }, include: commissioningInclude });
  if (!c) throw new HttpError(404, 'commissioning_not_found', 'Commission the robot at this site first.');
  if (!c.safetyLeadUserId) throw new HttpError(409, 'no_safety_lead', 'Name the safety lead before signing off.');
  if (c.safetyLeadUserId !== actorUserId) throw new HttpError(403, 'not_safety_lead', 'Only the named safety lead signs the commissioning off.');
  const signed = await db.robotCommissioning.update({ where: { id: c.id }, data: { signedOffAt: now }, include: commissioningInclude });
  await db.robotEvent.create({ data: { workerId, tenantId: w.tenantId, kind: 'COMMISSIONED', at: now, byUserId: actorUserId, note: `Commissioned at ${signed.site.name}`, metadata: { locationId } } });
  enqueueAudit({ actorUserId, clientId: null, workerId, action: 'robot.commissioning_signed_off', entityType: 'RobotCommissioning', entityId: c.id, metadata: { locationId } }, 'robots');
  return commissioningSummary(signed);
}

/* -------------------------------------------------------- maintenance -- */

function maintenanceSummary(m: { id: string; performedOn: Date; kind: string; description: string; performedBy: string | null; costCents: number | null; nextDueOn: Date | null }): RobotMaintenanceSummary {
  return { id: m.id, performedOn: m.performedOn.toISOString().slice(0, 10), kind: m.kind, description: m.description, performedBy: m.performedBy, costCents: m.costCents, nextDueOn: m.nextDueOn?.toISOString().slice(0, 10) ?? null };
}

export async function addMaintenance(db: Db, workerId: string, input: MaintenanceInput, actorUserId: string, now: Date = new Date()): Promise<RobotMaintenanceSummary> {
  const w = await robotWorker(db, workerId);
  const m = await db.robotMaintenance.create({
    data: { workerId, tenantId: w.tenantId, performedOn: new Date(`${input.performedOn}T12:00:00Z`), kind: input.kind, description: input.description, performedBy: input.performedBy ?? null, costCents: input.costCents ?? null, nextDueOn: input.nextDueOn ? new Date(`${input.nextDueOn}T12:00:00Z`) : null },
  });
  await db.robotEvent.create({ data: { workerId, tenantId: w.tenantId, kind: 'MAINTENANCE', at: now, byUserId: actorUserId, note: `${input.kind}: ${input.description.slice(0, 120)}`, metadata: { maintenanceId: m.id } } });
  enqueueAudit({ actorUserId, clientId: null, workerId, action: 'robot.maintenance_logged', entityType: 'RobotMaintenance', entityId: m.id, metadata: { kind: input.kind } }, 'robots');
  return maintenanceSummary(m);
}

export async function listMaintenance(db: Db, workerId: string): Promise<RobotMaintenanceSummary[]> {
  await robotWorker(db, workerId);
  const rows = await db.robotMaintenance.findMany({ where: { workerId }, orderBy: { performedOn: 'desc' }, take: 200 });
  return rows.map(maintenanceSummary);
}

/* ------------------------------------------------------------- events -- */

function eventSummary(e: { id: string; kind: RobotEventSummary['kind']; at: Date; by: { id: string; email: string; associate: { firstName: string; lastName: string } | null } | null; shiftId: string | null; note: string | null }): RobotEventSummary {
  return { id: e.id, kind: e.kind, at: e.at.toISOString(), by: nameOf(e.by), shiftId: e.shiftId, note: e.note };
}

export async function listEvents(db: Db, workerId: string, limit = 100): Promise<RobotEventSummary[]> {
  await robotWorker(db, workerId);
  const rows = await db.robotEvent.findMany({ where: { workerId }, orderBy: { at: 'desc' }, take: limit, include: { by: userSelect } });
  return rows.map(eventSummary);
}

/* ---------------------------------------------------------- incidents -- */

function incidentSummary(i: { id: string; kind: RobotIncidentSummary['kind']; occurredAt: Date; description: string; locationId: string | null; site: { name: string } | null; reportedBy: { id: string; email: string; associate: { firstName: string; lastName: string } | null } | null; oshaIncidentId: string | null; peopleOnShift: unknown; samples: unknown; events: unknown; retainUntil: Date; evidencePurgedAt: Date | null }): RobotIncidentSummary {
  const samples = Array.isArray(i.samples) ? i.samples : [];
  const events = Array.isArray(i.events) ? i.events : [];
  return { id: i.id, kind: i.kind, occurredAt: i.occurredAt.toISOString(), description: i.description, locationId: i.locationId, locationName: i.site?.name ?? null, reportedBy: nameOf(i.reportedBy), oshaIncidentId: i.oshaIncidentId, peopleOnShift: (i.peopleOnShift as unknown as RobotIncidentSummary['peopleOnShift']) ?? [], sampleCount: samples.length, eventCount: events.length, retainUntil: i.retainUntil.toISOString().slice(0, 10), evidencePurgedAt: i.evidencePurgedAt?.toISOString() ?? null };
}

const incidentInclude = { site: { select: { name: true } }, reportedBy: userSelect } as const;

/**
 * Report an incident or near miss. The hour before it is copied into the
 * row as evidence: the robot's samples, its events and the people on
 * shift at the site. An injury or damage at a client site also opens an
 * OshaIncident so the safety log and the compliance desk see it.
 */
export async function reportIncident(db: Db, workerId: string, input: RobotIncidentInput, actorUserId: string): Promise<RobotIncidentDetail> {
  const w = await robotWorker(db, workerId);
  const occurredAt = new Date(input.occurredAt);
  const from = new Date(occurredAt.getTime() - 3_600_000);
  let locationId = input.locationId ?? null;
  if (!locationId) {
    const placement = await db.workerAssignment.findFirst({ where: { workerId, endedAt: null }, orderBy: { startedAt: 'desc' }, select: { locationId: true } });
    locationId = placement?.locationId ?? null;
  }
  const [samples, events, shifts] = await Promise.all([
    db.robotStatusSample.findMany({ where: { workerId, at: { gte: from, lte: occurredAt } }, orderBy: { at: 'asc' }, take: 500 }),
    db.robotEvent.findMany({ where: { workerId, at: { gte: from, lte: occurredAt } }, orderBy: { at: 'asc' }, include: { by: userSelect } }),
    locationId
      ? db.shift.findMany({
          where: { locationId, startsAt: { lte: occurredAt }, endsAt: { gte: from }, assignedAssociateId: { not: null }, status: { in: ['ASSIGNED', 'COMPLETED'] } },
          select: { id: true, assignedAssociateId: true, assignedAssociate: { select: { firstName: true, lastName: true } } },
          take: 200,
        })
      : Promise.resolve([]),
  ]);
  const people = shifts.map((s) => ({ associateId: s.assignedAssociateId!, name: s.assignedAssociate ? `${s.assignedAssociate.firstName} ${s.assignedAssociate.lastName}` : 'Associate', shiftId: s.id }));
  let oshaIncidentId: string | null = null;
  if (locationId && (input.kind === 'INJURY' || input.kind === 'PROPERTY_DAMAGE')) {
    const site = await db.site.findUnique({ where: { id: locationId }, select: { clientId: true, name: true } });
    if (site?.clientId) {
      const osha = await db.oshaIncident.create({
        data: {
          clientId: site.clientId,
          locationId,
          tenantId: w.tenantId,
          occurredAt,
          reportedById: actorUserId,
          location: site.name,
          description: `[Robot ${w.name}] ${input.description}`,
          severity: input.oshaSeverity ?? 'FIRST_AID',
          isRecordable: input.kind === 'INJURY' && (input.oshaSeverity ?? 'FIRST_AID') !== 'FIRST_AID',
        },
        select: { id: true },
      });
      oshaIncidentId = osha.id;
    }
  }
  const retainUntil = new Date(occurredAt);
  retainUntil.setUTCFullYear(retainUntil.getUTCFullYear() + EVIDENCE_RETENTION_YEARS);
  const row = await db.robotIncident.create({
    data: {
      workerId,
      tenantId: w.tenantId,
      locationId,
      kind: input.kind,
      occurredAt,
      description: input.description,
      reportedByUserId: actorUserId,
      oshaIncidentId,
      peopleOnShift: people as unknown as Prisma.InputJsonValue,
      samples: samples.map(sampleSummary) as unknown as Prisma.InputJsonValue,
      events: events.map(eventSummary) as unknown as Prisma.InputJsonValue,
      retainUntil,
    },
    include: incidentInclude,
  });
  enqueueAudit({ actorUserId, clientId: null, workerId, action: 'robot.incident_reported', entityType: 'RobotIncident', entityId: row.id, metadata: { kind: input.kind, samples: samples.length, people: people.length, oshaIncidentId } }, 'robots');
  return { ...incidentSummary(row), samples: samples.map(sampleSummary), events: events.map(eventSummary) };
}

export async function listIncidents(db: Db, workerId: string): Promise<RobotIncidentSummary[]> {
  await robotWorker(db, workerId);
  const rows = await db.robotIncident.findMany({ where: { workerId }, orderBy: { occurredAt: 'desc' }, take: 200, include: incidentInclude });
  return rows.map(incidentSummary);
}

export async function getIncident(db: Db, incidentId: string): Promise<RobotIncidentDetail> {
  const row = await db.robotIncident.findUnique({ where: { id: incidentId }, include: incidentInclude });
  if (!row) throw new HttpError(404, 'incident_not_found', 'No such incident.');
  return { ...incidentSummary(row), samples: (row.samples as unknown as RobotStatusSampleSummary[]) ?? [], events: (row.events as unknown as RobotEventSummary[]) ?? [] };
}

/* ---------------------------------------------------------- list/get -- */

async function rowFor(db: Db, w: { id: string; name: string; status: RobotRow['status']; tenantId: string | null; capabilities: string[]; owner: { id: string; email: string; associate: { firstName: string; lastName: string } | null } | null; robot: Parameters<typeof profileSummary>[0] | null }, now: Date): Promise<RobotRow> {
  const profile = w.robot ?? (await ensureRobotProfile(db, w.id, w.tenantId));
  const [placement, latest, openIncidents] = await Promise.all([
    db.workerAssignment.findFirst({ where: { workerId: w.id, endedAt: null }, orderBy: { startedAt: 'desc' }, select: { locationId: true, location: { select: { name: true } } } }),
    db.robotStatusSample.findFirst({ where: { workerId: w.id }, orderBy: { at: 'desc' } }),
    db.robotIncident.count({ where: { workerId: w.id, occurredAt: { gte: new Date(now.getTime() - 30 * 86_400_000) } } }),
  ]);
  const commissioned = placement
    ? !!(await db.robotCommissioning.findUnique({ where: { workerId_locationId: { workerId: w.id, locationId: placement.locationId } }, select: { signedOffAt: true } }))?.signedOffAt
    : false;
  const checklistReady = await passingChecklistFor(db, w.id, null, now);
  return {
    id: w.id,
    name: w.name,
    status: w.status,
    owner: nameOf(w.owner),
    capabilities: w.capabilities,
    profile: profileSummary(profile),
    site: placement ? { id: placement.locationId, name: placement.location.name } : null,
    latest: latest ? sampleSummary(latest) : null,
    commissioned,
    checklistReady,
    openIncidents,
  };
}

const workerSelect = { id: true, name: true, status: true, tenantId: true, capabilities: true, owner: userSelect, robot: true } as const;

export async function listRobots(db: Db, tenantId: string | null, now: Date = new Date()): Promise<RobotsResponse> {
  const workers = await db.worker.findMany({ where: { type: 'ROBOT', ...(tenantId ? { tenantId } : {}) }, orderBy: { name: 'asc' }, select: workerSelect });
  const robots: RobotRow[] = [];
  for (const w of workers) robots.push(await rowFor(db, w, now));
  const live = robots.filter((r) => r.status !== 'OFFBOARDED');
  const by = (s: RobotRow['latest'] extends infer L ? (L extends { status: infer S } ? S : never) : never) => live.filter((r) => r.latest?.status === s).length;
  const batteries = live.map((r) => r.latest?.batteryPct).filter((b): b is number => typeof b === 'number');
  return {
    robots,
    counts: {
      total: live.length,
      working: by('WORKING'),
      charging: by('CHARGING'),
      idle: by('IDLE'),
      errors: by('ERROR'),
      offline: by('OFFLINE'),
      stopped: by('STOPPED'),
      avgBatteryPct: batteries.length ? Math.round(batteries.reduce((a, b) => a + b, 0) / batteries.length) : null,
    },
    provider: fleetProviderFromEnv(),
  };
}

export async function getRobot(db: Db, id: string, now: Date = new Date()): Promise<RobotDetail> {
  const w = await db.worker.findUnique({ where: { id }, select: { ...workerSelect, type: true, notes: true, createdAt: true } });
  if (!w || w.type !== 'ROBOT') throw new HttpError(404, 'robot_not_found', 'No such robot.');
  const row = await rowFor(db, w, now);
  const [commissionings, recentEvents, shifts] = await Promise.all([
    db.robotCommissioning.findMany({ where: { workerId: id }, include: commissioningInclude, orderBy: { createdAt: 'asc' } }),
    db.robotEvent.findMany({ where: { workerId: id }, orderBy: { at: 'desc' }, take: 20, include: { by: userSelect } }),
    db.shift.findMany({
      where: { workerId: id, endsAt: { gte: now }, status: { in: ['ASSIGNED', 'DRAFT'] } },
      orderBy: { startsAt: 'asc' },
      take: 20,
      select: { id: true, startsAt: true, endsAt: true, position: true, status: true, locationRel: { select: { name: true, timezone: true } } },
    }),
  ]);
  const passedShiftIds = new Set((await db.robotChecklistRun.findMany({ where: { workerId: id, allPassed: true, shiftId: { in: shifts.map((s) => s.id) } }, select: { shiftId: true } })).map((r) => r.shiftId));
  return {
    ...row,
    notes: w.notes,
    createdAt: w.createdAt.toISOString(),
    commissionings: commissionings.map(commissioningSummary),
    recentEvents: recentEvents.map(eventSummary),
    upcomingShifts: shifts.map((s) => ({ id: s.id, startsAt: s.startsAt.toISOString(), endsAt: s.endsAt.toISOString(), position: s.position, locationName: s.locationRel?.name ?? null, timezone: shiftTimezone(s.locationRel), status: s.status, checklistDone: passedShiftIds.has(s.id) })),
  };
}
