import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../db.js';
import { env } from '../config/env.js';
import { enqueueAudit } from './audit.js';
import { ADMIN_EMAIL_HR_ONLY, notifyAllAdmins, notifyAssociate, notifyUser } from './notify.js';
import { ledWindows } from './shiftWindows.js';

/**
 * THE READY-TO-WORK HANDOFF.
 *
 * HR approves an application, then issues the clock-in number. That number
 * is the moment a hire becomes deployable — and until now nothing happened
 * at that moment: the associate got the number by email and did not know
 * who to call; the store did not know anyone was coming; HR became the
 * switchboard. This is the handoff spine applied to that seam:
 *
 *   event    — the number is issued (routes/kiosk99, POST /kiosk-pins)
 *   queue    — the shift supervisors of the associate's store hear, with
 *              the associate's contact card; the associate hears, with the
 *              supervisors' contact card and what happens next
 *   deep link — the supervisor's bell row opens Scheduling on that person
 *   action   — the first shift is assigned (or the first punch lands)
 *   closure  — HR's application page says who was told and when, and
 *              whether a first shift exists; after NUDGE_AFTER_HOURS with
 *              none, the store is nudged once more and Workforce is told
 *
 * The store is the associate's open assignment (created at approval when
 * the application named a store), else the approved application's store.
 * The supervisors are the ones who lead a shift window at that store; when
 * nobody does, every shift supervisor at the client is paged and the row
 * says so, and HR is told nobody leads the store.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export interface StoreCard {
  id: string;
  name: string;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  timezone: string;
}

export interface SupervisorCard {
  userId: string;
  name: string;
  email: string;
  phone: string | null;
  /** Shift-window labels this supervisor leads at the store ("Overnight"). */
  windows: string[];
}

export interface AssociateCard {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  position: string | null;
  hireDate: string | null;
}

export interface HandoffStatus {
  associate: AssociateCard;
  client: { id: string; name: string };
  store: StoreCard | null;
  supervisors: SupervisorCard[];
  fallbackToClient: boolean;
  issuedAt: string;
  supervisorsNotifiedAt: string | null;
  nudgedAt: string | null;
  firstShiftAt: string | null;
  firstPunchAt: string | null;
  /** A first shift is on the books or a punch has landed. */
  closed: boolean;
}

const STORE_SELECT = {
  id: true,
  name: true,
  addressLine1: true,
  addressLine2: true,
  city: true,
  state: true,
  zip: true,
  timezone: true,
} as const;

const SUPERVISOR_USER_SELECT = {
  id: true,
  email: true,
  associate: { select: { firstName: true, lastName: true, phone: true } },
} as const;

function personName(u: { email: string; associate: { firstName: string; lastName: string } | null }): string {
  if (u.associate) return `${u.associate.firstName} ${u.associate.lastName}`.trim();
  return u.email.split('@')[0] ?? u.email;
}

function ymd(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

/** Where this associate works for this client: the open assignment, else the
 *  latest approved application's store. */
export async function resolveStoreForAssociate(
  db: Db,
  associateId: string,
  clientId: string,
): Promise<StoreCard | null> {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const assignment = await db.associateAssignment.findFirst({
    where: {
      associateId,
      location: { clientId },
      OR: [{ endedAt: null }, { endedAt: { gte: today } }],
    },
    orderBy: { startedAt: 'desc' },
    select: { location: { select: STORE_SELECT } },
  });
  if (assignment) return assignment.location;
  const app = await db.application.findFirst({
    where: { associateId, clientId, status: 'APPROVED', deletedAt: null, locationId: { not: null } },
    orderBy: { approvedAt: 'desc' },
    select: { location: { select: STORE_SELECT } },
  });
  return app?.location ?? null;
}

/** The shift supervisors who lead a window at the store; when nobody does,
 *  every active shift supervisor at the client, flagged as a fallback. */
export async function storeSupervisors(
  db: Db,
  clientId: string,
  locationId: string | null,
): Promise<{ supervisors: SupervisorCard[]; fallbackToClient: boolean }> {
  if (locationId) {
    const windows = (await ledWindows(db, { clientId })).filter((w) => w.locationId === locationId);
    if (windows.length > 0) {
      const byUser = new Map<string, string[]>();
      for (const w of windows) {
        const labels = byUser.get(w.userId) ?? [];
        if (!labels.includes(w.label)) labels.push(w.label);
        byUser.set(w.userId, labels);
      }
      const users = await db.user.findMany({
        where: { id: { in: [...byUser.keys()] }, status: 'ACTIVE', deletedAt: null },
        select: SUPERVISOR_USER_SELECT,
      });
      const supervisors = users
        .map((u) => ({
          userId: u.id,
          name: personName(u),
          email: u.email,
          phone: u.associate?.phone ?? null,
          windows: byUser.get(u.id) ?? [],
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      if (supervisors.length > 0) return { supervisors, fallbackToClient: false };
    }
  }
  const users = await db.user.findMany({
    where: { clientId, role: 'SHIFT_SUPERVISOR', status: 'ACTIVE', deletedAt: null },
    select: SUPERVISOR_USER_SELECT,
    orderBy: { email: 'asc' },
  });
  return {
    supervisors: users.map((u) => ({
      userId: u.id,
      name: personName(u),
      email: u.email,
      phone: u.associate?.phone ?? null,
      windows: [],
    })),
    fallbackToClient: true,
  };
}

async function associateCard(db: Db, associateId: string, clientId: string): Promise<AssociateCard | null> {
  const a = await db.associate.findUnique({
    where: { id: associateId },
    select: { id: true, firstName: true, lastName: true, email: true, phone: true, hireDate: true },
  });
  if (!a) return null;
  const app = await db.application.findFirst({
    where: { associateId, clientId, status: 'APPROVED', deletedAt: null },
    orderBy: { approvedAt: 'desc' },
    select: { position: true },
  });
  return {
    id: a.id,
    name: `${a.firstName} ${a.lastName}`.trim(),
    email: a.email,
    phone: a.phone,
    position: app?.position ?? null,
    hireDate: ymd(a.hireDate),
  };
}

function storeLine(store: StoreCard | null): string {
  if (!store) return '';
  const addr = [store.addressLine1, store.addressLine2, [store.city, store.state].filter(Boolean).join(', '), store.zip]
    .filter((s) => s && String(s).trim())
    .join(', ');
  return addr ? `${store.name} — ${addr}` : store.name;
}

function supervisorLines(supervisors: SupervisorCard[]): string {
  return supervisors
    .map((s) => {
      const win = s.windows.length ? ` (${s.windows.join(', ')})` : '';
      const phone = s.phone ? ` · ${s.phone}` : '';
      return `• ${s.name}${win} · ${s.email}${phone}`;
    })
    .join('\n');
}

/**
 * Run the handoff for an associate whose clock-in number was just issued.
 * Idempotent per issue: re-issuing rewrites the row and tells everyone again
 * (a transfer IS a new handoff). Never throws into the caller's response —
 * the number was issued; a notification hiccup is logged, not surfaced.
 */
export async function startReadyToWorkHandoff(input: {
  associateId: string;
  clientId: string;
  issuedById: string | null;
}): Promise<void> {
  const { associateId, clientId, issuedById } = input;
  const [associate, client] = await Promise.all([
    associateCard(prisma, associateId, clientId),
    prisma.client.findUnique({ where: { id: clientId }, select: { id: true, name: true } }),
  ]);
  if (!associate || !client) return;
  const store = await resolveStoreForAssociate(prisma, associateId, clientId);
  const { supervisors, fallbackToClient } = await storeSupervisors(prisma, clientId, store?.id ?? null);
  const now = new Date();

  await prisma.readyToWorkHandoff.upsert({
    where: { associateId },
    create: {
      associateId,
      clientId,
      locationId: store?.id ?? null,
      issuedById,
      issuedAt: now,
      supervisorUserIds: supervisors.map((s) => s.userId),
      fallbackToClient,
      associateNotifiedAt: now,
      supervisorsNotifiedAt: supervisors.length > 0 ? now : null,
      nudgedAt: null,
    },
    update: {
      clientId,
      locationId: store?.id ?? null,
      issuedById,
      issuedAt: now,
      supervisorUserIds: supervisors.map((s) => s.userId),
      fallbackToClient,
      associateNotifiedAt: now,
      supervisorsNotifiedAt: supervisors.length > 0 ? now : null,
      nudgedAt: null,
    },
  });

  const where = store ? `${store.name} (${client.name})` : client.name;
  const hire = associate.hireDate ? ` · hire date ${associate.hireDate}` : '';
  const position = associate.position ? ` · ${associate.position}` : '';

  // The store hears: who is coming, how to reach them, and where to put
  // them on the schedule. The bell row deep-links into Scheduling with the
  // associate's row highlighted.
  const supervisorBody = [
    `${associate.name} is cleared to work at ${where}${position}${hire}. Their clock-in number was issued today, so they can punch in as soon as they have a shift.`,
    '',
    `Phone: ${associate.phone ?? '—'}`,
    `Email: ${associate.email}`,
    '',
    fallbackToClient && store
      ? `Nobody leads a shift window at ${store.name} yet, so every supervisor at ${client.name} is getting this. Whoever picks them up: schedule their first shift and they'll see it in their app.`
      : 'Schedule their first shift and they will see it in their app, with your name on it.',
  ].join('\n');
  await Promise.all(
    supervisors.map((s) =>
      notifyUser(s.userId, {
        subject: `New associate ready to schedule: ${associate.name}`,
        body: supervisorBody,
        category: 'scheduling',
        linkUrl: `/scheduling?associate=${associateId}`,
      }),
    ),
  );

  // The associate hears: where, who, and what happens next. Email falls
  // back to the associate's address so a hire who has not signed in yet
  // still gets the kit. The clock-in number itself stays in its own email.
  const associateBody = [
    `You're cleared to work at ${where}.${store ? `\nAddress: ${storeLine(store)}` : ''}`,
    '',
    supervisors.length > 0
      ? `Your shift supervisors:\n${supervisorLines(supervisors)}`
      : 'Your store’s supervisors will be in touch — HR has your details.',
    '',
    'What happens next: your supervisor schedules your first shift. It will show up in your Alto app and you will get a notification. Bring your clock-in number on day one (it was sent to you separately) and punch in at the kiosk when you arrive.',
  ].join('\n');
  await notifyAssociate(associateId, {
    subject: `You're ready to work at ${store?.name ?? client.name}`,
    body: associateBody,
    category: 'onboarding',
    linkUrl: '/',
    emailFallback: true,
  });

  if (supervisors.length === 0) {
    await notifyAllAdmins({
      subject: `No supervisor to hand ${associate.name} to`,
      body: `${associate.name}'s clock-in number was issued for ${where}, but ${client.name} has no active shift supervisor to tell. Give the store a supervisor (Users & access → shift windows) and re-issue the number, or schedule their first shift yourself.`,
      category: 'onboarding',
      linkUrl: `/scheduling?associate=${associateId}`,
      emailRoles: ADMIN_EMAIL_HR_ONLY,
    });
  }

  enqueueAudit(
    {
      actorUserId: issuedById,
      clientId,
      action: 'associate.ready_to_work',
      entityType: 'Associate',
      entityId: associateId,
      metadata: {
        locationId: store?.id ?? null,
        supervisorUserIds: supervisors.map((s) => s.userId),
        fallbackToClient,
      },
    },
    'readyToWork.start',
  );
}

async function closure(
  db: Db,
  associateId: string,
  issuedAt: Date,
): Promise<{ firstShiftAt: Date | null; firstPunchAt: Date | null }> {
  const [shift, punch] = await Promise.all([
    db.shift.findFirst({
      where: {
        assignedAssociateId: associateId,
        cancelledAt: null,
        status: { not: 'CANCELLED' },
        startsAt: { gte: issuedAt },
      },
      orderBy: { startsAt: 'asc' },
      select: { startsAt: true },
    }),
    db.kioskPunch.findFirst({
      where: { associateId, createdAt: { gte: issuedAt } },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    }),
  ]);
  return { firstShiftAt: shift?.startsAt ?? null, firstPunchAt: punch?.createdAt ?? null };
}

/** Everything HR and the associate need to know about one handoff. */
export async function readyToWorkStatus(db: Db, associateId: string): Promise<HandoffStatus | null> {
  const row = await db.readyToWorkHandoff.findUnique({
    where: { associateId },
    include: { client: { select: { id: true, name: true } }, location: { select: STORE_SELECT } },
  });
  if (!row) return null;
  const associate = await associateCard(db, associateId, row.clientId);
  if (!associate) return null;
  // Supervisors are resolved live: a supervisor who joined the store after
  // the handoff is still the person to call today.
  const live = await storeSupervisors(db, row.clientId, row.locationId);
  const supervisors =
    live.supervisors.length > 0
      ? live.supervisors
      : (
          await db.user.findMany({
            where: { id: { in: row.supervisorUserIds } },
            select: SUPERVISOR_USER_SELECT,
          })
        ).map((u) => ({
          userId: u.id,
          name: personName(u),
          email: u.email,
          phone: u.associate?.phone ?? null,
          windows: [],
        }));
  const { firstShiftAt, firstPunchAt } = await closure(db, associateId, row.issuedAt);
  return {
    associate,
    client: row.client,
    store: row.location,
    supervisors,
    fallbackToClient: live.supervisors.length > 0 ? live.fallbackToClient : row.fallbackToClient,
    issuedAt: row.issuedAt.toISOString(),
    supervisorsNotifiedAt: row.supervisorsNotifiedAt?.toISOString() ?? null,
    nudgedAt: row.nudgedAt?.toISOString() ?? null,
    firstShiftAt: firstShiftAt?.toISOString() ?? null,
    firstPunchAt: firstPunchAt?.toISOString() ?? null,
    closed: Boolean(firstShiftAt || firstPunchAt),
  };
}

/** The associate's own kit — null once they have punched in for the first
 *  time (they have met the floor; the card has done its job). */
export async function readyToWorkForAssociate(associateId: string): Promise<HandoffStatus | null> {
  const status = await readyToWorkStatus(prisma, associateId);
  if (!status || status.firstPunchAt) return null;
  return status;
}

export interface ReadyToScheduleItem {
  associate: AssociateCard;
  store: { id: string; name: string } | null;
  issuedAt: string;
  nudgedAt: string | null;
  fallbackToClient: boolean;
}

/** A supervisor's queue: hires handed to them (or to their whole client)
 *  who still have no first shift and have not punched in. Oldest first. */
export async function readyToScheduleForSupervisor(userId: string): Promise<ReadyToScheduleItem[]> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { clientId: true } });
  const rows = await prisma.readyToWorkHandoff.findMany({
    where: {
      OR: [
        { supervisorUserIds: { has: userId } },
        ...(user?.clientId ? [{ fallbackToClient: true, clientId: user.clientId }] : []),
      ],
    },
    orderBy: { issuedAt: 'asc' },
    include: { location: { select: { id: true, name: true } } },
  });
  const out: ReadyToScheduleItem[] = [];
  for (const row of rows) {
    const { firstShiftAt, firstPunchAt } = await closure(prisma, row.associateId, row.issuedAt);
    if (firstShiftAt || firstPunchAt) continue;
    const associate = await associateCard(prisma, row.associateId, row.clientId);
    if (!associate) continue;
    out.push({
      associate,
      store: row.location,
      issuedAt: row.issuedAt.toISOString(),
      nudgedAt: row.nudgedAt?.toISOString() ?? null,
      fallbackToClient: row.fallbackToClient,
    });
  }
  return out;
}

/**
 * Hires still without a first shift NUDGE_AFTER_HOURS after the store was
 * told: the store hears once more and Workforce is told, once per handoff.
 * Returns how many were nudged.
 */
export async function runReadyToWorkNudgeSweep(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - env.READY_TO_WORK_NUDGE_AFTER_HOURS * 3600_000);
  const rows = await prisma.readyToWorkHandoff.findMany({
    where: { nudgedAt: null, supervisorsNotifiedAt: { not: null, lte: cutoff } },
    include: { client: { select: { name: true } }, location: { select: { id: true, name: true } } },
  });
  if (rows.length === 0) return 0;
  const workforce = await prisma.user.findMany({
    where: { role: 'WORKFORCE_MANAGER', status: 'ACTIVE', deletedAt: null },
    select: { id: true },
  });
  let nudged = 0;
  for (const row of rows) {
    const { firstShiftAt, firstPunchAt } = await closure(prisma, row.associateId, row.issuedAt);
    if (firstShiftAt || firstPunchAt) {
      // Closed on its own — nothing to nudge, and never again.
      await prisma.readyToWorkHandoff.update({ where: { id: row.id }, data: { nudgedAt: now } });
      continue;
    }
    const associate = await associateCard(prisma, row.associateId, row.clientId);
    if (!associate) continue;
    const where = row.location ? `${row.location.name} (${row.client.name})` : row.client.name;
    const hours = env.READY_TO_WORK_NUDGE_AFTER_HOURS;
    const body = `${associate.name} was cleared to work at ${where} ${hours} hours ago and still has no first shift. Phone ${associate.phone ?? '—'} · ${associate.email}. Put them on the schedule so they are not waiting on a call.`;
    const link = `/scheduling?associate=${row.associateId}`;
    await Promise.all([
      ...row.supervisorUserIds.map((id) =>
        notifyUser(id, { subject: `Still waiting for a first shift: ${associate.name}`, body, category: 'scheduling', linkUrl: link }),
      ),
      ...workforce.map((u) =>
        notifyUser(u.id, {
          subject: `No first shift yet: ${associate.name}`,
          body: `${body}\n\nThe store was told when the clock-in number was issued and again just now.`,
          category: 'scheduling',
          linkUrl: link,
        }),
      ),
    ]);
    await prisma.readyToWorkHandoff.update({ where: { id: row.id }, data: { nudgedAt: now } });
    enqueueAudit(
      {
        actorUserId: null,
        clientId: row.clientId,
        action: 'associate.ready_to_work_nudged',
        entityType: 'Associate',
        entityId: row.associateId,
        metadata: { locationId: row.location?.id ?? null, supervisorUserIds: row.supervisorUserIds, workforceUserIds: workforce.map((u) => u.id) },
      },
      'readyToWork.nudge',
    );
    nudged++;
  }
  return nudged;
}

let timer: NodeJS.Timeout | null = null;
export function startReadyToWorkNudgeCron(): void {
  if (timer) return;
  const seconds = env.READY_TO_WORK_NUDGE_INTERVAL_SECONDS;
  if (seconds <= 0) return;
  const run = () => {
    void runReadyToWorkNudgeSweep().catch((err) => {
      console.error('[alto-people/api] ready-to-work nudge sweep failed:', err);
    });
  };
  run();
  timer = setInterval(run, seconds * 1000);
  timer.unref();
}
