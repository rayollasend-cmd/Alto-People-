/**
 * The populated demo tenant.
 *
 * `prisma/seed.ts` creates the personas and one of everything, which is right
 * for tests and leaves every screen at zero. This layer turns the seeded
 * organization into what a real customer looks like after a year: three
 * clients, seven stores, sixty-five people in three languages, a year of
 * shifts with punches, ten disbursed pay periods, decisions waiting on every
 * desk, the agents' trail, store-channel messages, and a store with a grade.
 *
 *   DEMO_DATA=1 npm -w apps/api run seed:demo      (after db:seed)
 *
 * Additive and opt-in: it never changes a row the base seed made, so the E2E
 * suite runs on the base seed unchanged; only the design walk (and a demo
 * database) runs this. Deterministic: one seeded random source, anchored on
 * today's date, so two runs on the same day produce the same rows and ids.
 * Idempotent by refusal: a completed run leaves an audit marker and the
 * script exits early; a half-finished run must be reset with the database
 * (`prisma migrate reset`), since the audit log is append-only.
 *
 * Everything goes through the shared client (`src/db.ts`), so the Shift →
 * Worker sync, the tenant stamp and the audit hooks apply as they do in the
 * app; payroll goes through the same aggregator the Payroll page uses.
 */

import { Prisma, type CandidateStage, type TaskStatus } from '@prisma/client';
import { prisma } from '../src/db.js';
import { hashPassword } from '../src/lib/passwords.js';
import { withMandatoryTasks } from '../src/lib/checklistTasks.js';
import { ensurePersonWorkers } from '../src/lib/workers.js';
import { ensureBuiltInAgents, payloadHash } from '../src/lib/agents.js';
import { ensureStoreChannels } from '../src/lib/messaging.js';
import { getCurrentPeriod } from '../src/lib/payrollSchedule.js';
import { aggregateAndPersistRun } from '../src/routes/payroll.js';
import { orgDateKey, utcInstantOfLocalMidnight } from '../src/lib/timeAnomalies.js';
import { ATTENDANCE_POINTS } from '../src/lib/attendance.js';
import { ALTO_TENANT_ID } from '../src/lib/tenant.js';
import {
  BILL_RATE,
  DEMO_CAST,
  DEMO_CLIENTS,
  DEMO_CREW_TOTAL,
  DEMO_EMAIL_DOMAIN,
  DEMO_STORES,
  LEAD_POSITION,
  PAY_RATE,
  Rng,
  addDaysToKey,
  dayKeys,
  dealCrews,
  drawAttendance,
  emailLocal,
  planDay,
  weekdayOfKey,
  type CrewMember,
  type StoreSpec,
} from '../src/lib/demoSeed.js';

if (process.env.DEMO_DATA !== '1') {
  console.error('[seed-demo] refusing to run: set DEMO_DATA=1 (a dev, CI-walk or demo database only — never production).');
  process.exit(2);
}

const SEED = 20261015;
const rng = new Rng(SEED);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const HISTORY_DAYS = 364;
const FUTURE_DAYS = 14;
const SHIFT_HOURS = 8;
const ASSOCIATE_DEMO_PASSWORD = 'demo-associate-2026!';
const MARKER_ACTION = 'demo.seed.completed';
const CHUNK = 500;

const now = new Date();
const todayKey = orgDateKey(now);
const dateOf = (key: string) => new Date(`${key}T00:00:00.000Z`);
const minutes = (d: Date, n: number) => new Date(d.getTime() + n * MIN);
const daysAgo = (n: number) => new Date(now.getTime() - n * DAY);
const counts: Record<string, number> = {};
const count = (k: string, n = 1) => (counts[k] = (counts[k] ?? 0) + n);

async function createManyChunked<T>(label: string, rows: T[], write: (chunk: T[]) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) await write(rows.slice(i, i + CHUNK));
  count(label, rows.length);
}

interface StoreRow {
  spec: StoreSpec;
  id: string;
  clientId: string;
  tz: string;
}
interface Person {
  member: CrewMember | null;
  castIndex: number;
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  lang: 'en' | 'es' | 'tr';
  store: StoreRow | null;
  position: string;
  rate: number;
  hireKey: string;
  separatedAt: Date | null;
  userId: string | null;
}

async function main() {
  // ---- Guards ---------------------------------------------------------------
  if (await prisma.auditLog.findFirst({ where: { action: MARKER_ACTION }, select: { id: true } })) {
    console.log('[seed-demo] already seeded on this database; nothing to do.');
    return;
  }
  if (await prisma.client.findFirst({ where: { name: DEMO_CLIENTS.gulf.name }, select: { id: true } })) {
    throw new Error('[seed-demo] a previous run stopped half-way (the demo client exists, the marker does not). Reset the database and run again.');
  }

  // ---- The people the base seed made ---------------------------------------
  const admin = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@altohr.com' } });
  const recruiter = (await prisma.user.findUnique({ where: { email: 'recruiter@altohr.com' } })) ?? admin;
  const finance = (await prisma.user.findUnique({ where: { email: 'finance@altohr.com' } })) ?? admin;
  const workforce = (await prisma.user.findUnique({ where: { email: 'workforce@altohr.com' } })) ?? admin;
  const dana = await prisma.user.findUniqueOrThrow({ where: { email: 'dana.reyes@altohr.com' } });
  const portal = await prisma.user.findUniqueOrThrow({ where: { email: 'portal@coastalresort.example' } });
  const template = await prisma.onboardingTemplate.findFirstOrThrow({ where: { clientId: null, track: 'STANDARD' }, include: { tasks: { orderBy: { order: 'asc' } } } });
  const templateTasks = withMandatoryTasks(
    template.tasks.map((t) => ({ kind: t.kind, title: t.title, description: t.description, order: t.order, dueOffsetDays: t.dueOffsetDays ?? undefined })),
  );

  // ---- Clients and stores ---------------------------------------------------
  const coastal = await prisma.client.findFirstOrThrow({ where: { name: DEMO_CLIENTS.coastal.name, deletedAt: null } });
  const seaside = await prisma.client.findFirstOrThrow({ where: { name: DEMO_CLIENTS.seaside.name, deletedAt: null } });
  const gulf = await prisma.client.create({
    data: {
      name: DEMO_CLIENTS.gulf.name,
      industry: DEMO_CLIENTS.gulf.industry,
      status: 'ACTIVE',
      contactEmail: DEMO_CLIENTS.gulf.contactEmail,
      city: 'Panama City',
      state: 'FL',
      zip: '32405',
    },
  });
  count('clients');
  const clientFor = { coastal, seaside, gulf } as const;
  const region = await prisma.region.findFirst({ where: { name: 'Florida Panhandle', deletedAt: null } });

  const stores: StoreRow[] = [];
  for (const spec of DEMO_STORES) {
    const client = clientFor[spec.clientKey];
    let row = await prisma.site.findFirst({ where: { clientId: client.id, name: spec.name, deletedAt: null } });
    if (spec.existing && !row) throw new Error(`[seed-demo] the base seed's store "${spec.name}" is missing — run db:seed first.`);
    if (!row) {
      row = await prisma.site.create({
        data: {
          clientId: client.id,
          name: spec.name,
          addressLine1: spec.addressLine1,
          city: spec.city,
          state: spec.state,
          zip: spec.zip,
          timezone: spec.timezone,
          type: 'STORE',
          ...(region && spec.clientKey === 'coastal' ? { regionId: region.id } : {}),
        },
      });
      count('stores');
      // The contract: a floor target per window (hours outside a window have
      // no target, so they are not graded).
      await prisma.staffingTarget.createMany({
        data: [
          ...spec.windows.map((w) => ({
            locationId: row!.id,
            targetCount: w.target,
            effectiveFrom: dateOf(addDaysToKey(todayKey, -400)),
            label: w.label,
            startMinute: w.startMinute,
            endMinute: w.endMinute,
            createdById: admin.id,
          })),
        ],
      });
    }
    stores.push({ spec, id: row.id, clientId: client.id, tz: row.timezone });
  }
  const storeByKey = new Map(stores.map((s) => [s.spec.key, s]));
  const frontBeach = storeByKey.get('front-beach')!;

  // Positions and the rate cards (pay $15 / $18, SOW bill $21.21 / $24.24), effective 18 months back.
  const positionNames = new Set<string>([LEAD_POSITION]);
  for (const s of DEMO_STORES) for (const w of s.windows) for (const p of w.positions) positionNames.add(p);
  const rateFrom = dateOf(addDaysToKey(todayKey, -540));
  for (const client of [coastal, seaside, gulf]) {
    let order = 1;
    for (const name of positionNames) {
      const isLead = name === LEAD_POSITION;
      if (!(await prisma.shiftPosition.findFirst({ where: { clientId: client.id, name, deletedAt: null } }))) {
        await prisma.shiftPosition.create({ data: { clientId: client.id, name, isLead, sortOrder: isLead ? 0 : order++ } });
      }
    }
    await prisma.shiftRateDefault.createMany({
      data: [...positionNames].map((position) => ({
        clientId: client.id,
        position,
        payRate: position === LEAD_POSITION ? PAY_RATE.lead : PAY_RATE.associate,
        billRate: position === LEAD_POSITION ? BILL_RATE.lead : BILL_RATE.associate,
        effectiveFrom: rateFrom,
        createdById: admin.id,
      })),
      skipDuplicates: true,
    });
    count('rateCards', positionNames.size);
  }

  // ---- The pay schedule: biweekly, Saturday to Friday, paid the Friday after.
  let anchorKey = addDaysToKey(todayKey, -420);
  while (weekdayOfKey(anchorKey) !== 6) anchorKey = addDaysToKey(anchorKey, -1);
  const schedule = await prisma.payrollSchedule.create({
    data: { name: 'Biweekly · Sat–Fri', frequency: 'BIWEEKLY', anchorDate: dateOf(anchorKey), payDateOffsetDays: 7, notes: 'The company workweek, paid the Friday after the period closes.' },
  });
  const current = getCurrentPeriod({ frequency: 'BIWEEKLY', anchorDate: schedule.anchorDate, payDateOffsetDays: 7 }, now);

  // ---- The cast -------------------------------------------------------------
  const crews = dealCrews(rng);
  const separatedIdx = new Set<number>();
  while (separatedIdx.size < 4) {
    const m = rng.pick(crews.filter((c) => !c.isLead));
    separatedIdx.add(m.castIndex);
  }
  const people: Person[] = [];
  const leadByStore = new Map<string, Person>();
  let usersMade = 0;

  for (const member of crews) {
    const cast = DEMO_CAST[member.castIndex]!;
    const store = storeByKey.get(member.storeKey)!;
    const separated = separatedIdx.has(member.castIndex);
    const sepDays = separated ? rng.int(20, 150) : 0;
    const hireDays = member.isLead ? rng.int(400, 530) : Math.max(sepDays + 60, rng.int(30, 520));
    const hireKey = addDaysToKey(todayKey, -hireDays);
    const rate = member.isLead ? PAY_RATE.lead : PAY_RATE.associate;
    const id = rng.uuid();
    const email = `${emailLocal(cast.first, cast.last)}@${DEMO_EMAIL_DOMAIN}`;
    const separatedAt = separated ? daysAgo(sepDays) : null;
    const createdAt = daysAgo(hireDays + 12);
    await prisma.associate.create({
      data: {
        id,
        firstName: cast.first,
        lastName: cast.last,
        email,
        phone: `+1-850-555-${String(1000 + member.castIndex).slice(-4)}`,
        dob: dateOf(`${rng.int(1976, 2004)}-${String(rng.int(1, 12)).padStart(2, '0')}-${String(rng.int(1, 28)).padStart(2, '0')}`),
        addressLine1: `${rng.int(100, 9800)} ${rng.pick(['Beach Blvd', 'Thomas Dr', 'Hutchison Blvd', 'Back Beach Rd', 'Harbor Blvd', 'Gulf Breeze Pkwy'])}`,
        city: store.spec.city,
        state: 'FL',
        zip: store.spec.zip,
        employmentType: 'W2_EMPLOYEE',
        hireDate: dateOf(hireKey),
        payrollScheduleId: schedule.id,
        createdAt,
        ...(separatedAt ? { separatedAt } : {}),
      },
    });
    await prisma.compensationRecord.create({
      data: { associateId: id, effectiveFrom: dateOf(hireKey), payType: 'HOURLY', amount: rate, reason: 'HIRE', actorUserId: admin.id, notes: member.isLead ? 'Shift lead rate' : 'Org standard rate' },
    });
    await prisma.application.create({
      data: {
        associateId: id,
        clientId: store.clientId,
        locationId: store.id,
        onboardingTrack: 'STANDARD',
        status: 'APPROVED',
        position: member.position,
        startDate: dateOf(hireKey),
        invitedAt: daysAgo(hireDays + 12),
        submittedAt: daysAgo(hireDays + 9),
        approvedAt: daysAgo(hireDays + 6),
        createdAt: daysAgo(hireDays + 12),
        checklist: {
          create: {
            tasks: { create: templateTasks.map((t) => ({ ...t, status: 'DONE' as TaskStatus, completedAt: daysAgo(hireDays + 9) })) },
          },
        },
      },
    });
    await prisma.associateAssignment.create({
      data: {
        associateId: id,
        locationId: store.id,
        startedAt: dateOf(hireKey),
        ...(separatedAt ? { endedAt: separatedAt, reason: 'Separated', notes: rng.pick(['Moved out of state', 'Took a full-time job', 'End of season']) } : { reason: 'Placed at hire' }),
        notedById: admin.id,
      },
    });
    const person: Person = {
      member, castIndex: member.castIndex, id, firstName: cast.first, lastName: cast.last, email, lang: cast.lang,
      store, position: member.position, rate, hireKey, separatedAt, userId: null,
    };
    if (member.isLead) leadByStore.set(member.storeKey, person);
    if (!separatedAt && usersMade < 20) {
      const u = await prisma.user.create({
        data: { email, passwordHash: await hashPassword(ASSOCIATE_DEMO_PASSWORD), role: 'ASSOCIATE', status: 'ACTIVE', associateId: id, language: cast.lang, lastSeenAt: daysAgo(rng.int(0, 6)), createdAt },
      });
      person.userId = u.id;
      usersMade += 1;
    }
    people.push(person);
  }
  count('associates', people.length);
  count('associateUsers', usersMade);

  // Managers: the store's lead; at Front Beach, Dana (the supervisor the portal shows as the Alto lead).
  for (const p of people) {
    const lead = leadByStore.get(p.member!.storeKey);
    const managerId = p.store!.spec.key === 'front-beach' ? dana.associateId : lead && lead.id !== p.id ? lead.id : null;
    if (managerId) await prisma.associate.update({ where: { id: p.id }, data: { managerId } });
  }
  if (dana.associateId && !(await prisma.associateAssignment.findFirst({ where: { associateId: dana.associateId, endedAt: null } }))) {
    await prisma.associateAssignment.create({ data: { associateId: dana.associateId, locationId: frontBeach.id, startedAt: dateOf(addDaysToKey(todayKey, -560)), reason: 'Shift supervisor', notedById: admin.id } });
  }

  // Five more still onboarding: the pipeline a recruiter and HR look at every day.
  const inFlight: Array<{ status: 'SUBMITTED' | 'IN_REVIEW' | 'DRAFT'; done: number; daysIn: number }> = [
    { status: 'SUBMITTED', done: templateTasks.length, daysIn: 2 },
    { status: 'SUBMITTED', done: templateTasks.length, daysIn: 4 },
    { status: 'IN_REVIEW', done: templateTasks.length, daysIn: 6 },
    { status: 'DRAFT', done: 3, daysIn: 1 },
    { status: 'DRAFT', done: 0, daysIn: 0 },
  ];
  const pendingPeople: Person[] = [];
  for (let i = 0; i < inFlight.length; i++) {
    const cast = DEMO_CAST[DEMO_CREW_TOTAL + i]!;
    const f = inFlight[i]!;
    const id = rng.uuid();
    const email = `${emailLocal(cast.first, cast.last)}@${DEMO_EMAIL_DOMAIN}`;
    const store = rng.pick(stores.filter((s) => s.clientId === coastal.id));
    await prisma.associate.create({
      data: { id, firstName: cast.first, lastName: cast.last, email, phone: `+1-850-555-${String(1900 + i).slice(-4)}`, city: store.spec.city, state: 'FL', zip: store.spec.zip, createdAt: daysAgo(f.daysIn) },
    });
    await prisma.application.create({
      data: {
        associateId: id,
        clientId: store.clientId,
        locationId: store.id,
        onboardingTrack: 'STANDARD',
        status: f.status,
        position: rng.pick(['Cashier', 'Stocker', 'Deli associate']),
        startDate: dateOf(addDaysToKey(todayKey, rng.int(5, 12))),
        invitedAt: daysAgo(f.daysIn),
        createdAt: daysAgo(f.daysIn),
        ...(f.status !== 'DRAFT' ? { submittedAt: daysAgo(Math.max(0, f.daysIn - 1)) } : {}),
        checklist: {
          create: {
            tasks: {
              create: templateTasks.map((t, n) => ({
                ...t,
                status: (n < f.done ? 'DONE' : n === f.done ? 'IN_PROGRESS' : 'PENDING') as TaskStatus,
                ...(n < f.done ? { completedAt: daysAgo(Math.max(0, f.daysIn - 1)) } : {}),
              })),
            },
          },
        },
      },
    });
    pendingPeople.push({ member: null, castIndex: DEMO_CREW_TOTAL + i, id, firstName: cast.first, lastName: cast.last, email, lang: cast.lang, store, position: 'Cashier', rate: PAY_RATE.associate, hireKey: todayKey, separatedAt: null, userId: null });
  }
  count('applicationsInFlight', pendingPeople.length);

  // Identity documents: verified at hire, two of them expiring within 30 days
  // (the compliance desk and its agent have something to chase).
  const docRows: Prisma.DocumentRecordCreateManyInput[] = [];
  const expiringSoon: Array<{ person: Person; docId: string; expiresAt: Date }> = [];
  people.forEach((p, i) => {
    if (p.separatedAt) return;
    const hireDays = Math.max(1, Math.round((now.getTime() - dateOf(p.hireKey).getTime()) / DAY));
    const soon = i === 3 || i === 17;
    const expiresAt = soon ? daysAgo(-(i === 3 ? 12 : 26)) : daysAgo(-rng.int(400, 1500));
    const docId = rng.uuid();
    docRows.push({ id: docId, associateId: p.id, clientId: p.store!.clientId, kind: 'ID', filename: 'drivers-license.jpg', mimeType: 'image/jpeg', size: rng.int(180_000, 420_000), status: 'VERIFIED', expiresAt, verifiedById: admin.id, verifiedAt: daysAgo(hireDays + 8), createdAt: daysAgo(hireDays + 9) });
    docRows.push({ id: rng.uuid(), associateId: p.id, clientId: p.store!.clientId, kind: 'SSN_CARD', filename: 'ssn-card.jpg', mimeType: 'image/jpeg', size: rng.int(120_000, 260_000), status: 'VERIFIED', verifiedById: admin.id, verifiedAt: daysAgo(hireDays + 8), createdAt: daysAgo(hireDays + 9) });
    if (soon) expiringSoon.push({ person: p, docId, expiresAt });
  });
  await createManyChunked('documents', docRows, (c) => prisma.documentRecord.createMany({ data: c }));

  // Every person is a worker on the roster (the sweep the app runs at boot).
  // The shifts below carry their worker up front, which also spares the
  // client extension one lookup per row across eighteen thousand rows.
  await ensurePersonWorkers(prisma);
  const workerOf = new Map(
    (await prisma.worker.findMany({ where: { associateId: { in: people.map((p) => p.id) } }, select: { id: true, associateId: true } })).map((w) => [w.associateId!, w.id]),
  );

  // ---- A year of shifts, with punches ---------------------------------------
  const shiftRows: Prisma.ShiftCreateManyInput[] = [];
  const entryRows: Prisma.TimeEntryCreateManyInput[] = [];
  const breakRows: Prisma.BreakEntryCreateManyInput[] = [];
  const eventRows: Prisma.AttendanceEventCreateManyInput[] = [];
  const pastShiftsOf = new Map<string, Array<{ id: string; startsAt: Date; endsAt: Date }>>();
  const futureShiftsOf = new Map<string, Array<{ id: string; startsAt: Date; endsAt: Date; window: string }>>();
  const next48FrontBeach: string[] = [];
  let unconfirmedLeft = 6;
  const approvedBefore = new Date(now.getTime() - 3 * DAY);
  const firstKey = addDaysToKey(todayKey, -HISTORY_DAYS);
  const keys = dayKeys(firstKey, HISTORY_DAYS + 1 + FUTURE_DAYS);
  const peopleByCast = new Map(people.map((p) => [p.castIndex, p]));

  for (const store of stores) {
    const crew = crews.filter((c) => c.storeKey === store.spec.key);
    keys.forEach((key, dayIndex) => {
      const weekday = weekdayOfKey(key);
      const midnight = utcInstantOfLocalMidnight(key, store.tz);
      for (const w of store.spec.windows) {
        for (const member of planDay(crew, w, dayIndex, weekday)) {
          const p = peopleByCast.get(member.castIndex)!;
          if (key < addDaysToKey(p.hireKey, 2)) continue;
          const startsAt = minutes(midnight, w.startMinute);
          const endsAt = new Date(startsAt.getTime() + SHIFT_HOURS * HOUR);
          if (p.separatedAt && startsAt > p.separatedAt) continue;
          const id = rng.uuid();
          const publishedAt = new Date(Math.min(startsAt.getTime() - 7 * DAY, now.getTime() - HOUR));
          const base: Prisma.ShiftCreateManyInput = {
            id,
            clientId: store.clientId,
            locationId: store.id,
            position: p.position,
            startsAt,
            endsAt,
            location: rng.pick(w.areas),
            hourlyRate: p.rate,
            payRate: p.rate,
            assignedAssociateId: p.id,
            workerId: workerOf.get(p.id) ?? null,
            assignedAt: publishedAt,
            publishedAt,
            createdById: workforce.id,
            createdAt: new Date(Math.min(startsAt.getTime() - 9 * DAY, now.getTime() - 2 * HOUR)),
          };
          if (endsAt <= now) {
            // History: punched, approved, with the occasional late, early or absent.
            const att = drawAttendance(rng);
            if (att.noShow) {
              shiftRows.push({ ...base, status: 'ASSIGNED', acknowledgedAt: minutes(startsAt, -36 * 60), noShowRecordedAt: endsAt, noShowNotifiedAt: minutes(endsAt, 15) });
              eventRows.push({ associateId: p.id, shiftId: id, clientId: store.clientId, kind: 'NO_CALL_NO_SHOW', points: ATTENDANCE_POINTS.NO_CALL_NO_SHOW!, occurredOn: dateOf(key), source: 'AUTO', createdAt: minutes(endsAt, 15) });
            } else {
              shiftRows.push({ ...base, status: 'COMPLETED', acknowledgedAt: minutes(startsAt, -rng.int(8, 40) * 60) });
              const clockInAt = minutes(startsAt, att.lateMinutes);
              const clockOutAt = minutes(endsAt, -att.earlyOutMinutes);
              const approved = endsAt < approvedBefore;
              const entryId = rng.uuid();
              entryRows.push({
                id: entryId, associateId: p.id, clientId: store.clientId, locationId: store.id, shiftId: id, clockInAt, clockOutAt, payRate: p.rate,
                status: approved ? 'APPROVED' : 'COMPLETED',
                ...(approved ? { approvedById: admin.id, approvedAt: minutes(endsAt, 20 * 60) } : {}),
                createdAt: clockInAt,
              });
              const mealAt = minutes(clockInAt, rng.int(220, 260));
              breakRows.push({ timeEntryId: entryId, type: 'MEAL', startedAt: mealAt, endedAt: minutes(mealAt, 30) });
              if (att.lateMinutes > 7) eventRows.push({ associateId: p.id, shiftId: id, clientId: store.clientId, kind: 'LATE', points: ATTENDANCE_POINTS.LATE!, occurredOn: dateOf(key), source: 'AUTO', createdAt: clockInAt });
              if (att.earlyOutMinutes > 15) eventRows.push({ associateId: p.id, shiftId: id, clientId: store.clientId, kind: 'EARLY_OUT', points: ATTENDANCE_POINTS.EARLY_OUT!, occurredOn: dateOf(key), source: 'AUTO', createdAt: clockOutAt });
              const list = pastShiftsOf.get(p.id) ?? [];
              list.push({ id, startsAt, endsAt });
              pastShiftsOf.set(p.id, list);
            }
          } else if (startsAt <= now) {
            // On the floor right now: the supervisor's "6 / 8".
            shiftRows.push({ ...base, status: 'ASSIGNED', acknowledgedAt: minutes(startsAt, -20 * 60) });
            if (now.getTime() - startsAt.getTime() > 6 * MIN && rng.chance(0.9)) {
              const clockInAt = minutes(startsAt, rng.int(-4, 5));
              entryRows.push({ id: rng.uuid(), associateId: p.id, clientId: store.clientId, locationId: store.id, shiftId: id, clockInAt, clockOutAt: null, payRate: p.rate, status: 'ACTIVE', createdAt: clockInAt });
            }
          } else {
            // Ahead: published, confirmed inside 48 hours except the few the desk chases.
            const within48 = startsAt.getTime() - now.getTime() < 48 * HOUR;
            let acknowledgedAt: Date | null = null;
            if (within48) {
              if (store.spec.key === 'front-beach' && unconfirmedLeft > 0 && rng.chance(0.35)) {
                unconfirmedLeft -= 1;
                next48FrontBeach.push(id);
              } else {
                acknowledgedAt = new Date(Math.max(now.getTime() - rng.int(2, 30) * HOUR, publishedAt.getTime() + HOUR));
              }
            }
            shiftRows.push({ ...base, status: 'ASSIGNED', acknowledgedAt });
            const list = futureShiftsOf.get(p.id) ?? [];
            list.push({ id, startsAt, endsAt, window: w.label });
            futureShiftsOf.set(p.id, list);
          }
        }
      }
    });
  }

  // Open shifts nobody holds yet (pickups on the desk, the open-shift broadcast's leftovers).
  const openShifts: Array<{ id: string; startsAt: Date }> = [];
  for (let i = 0; i < 5; i++) {
    const key = addDaysToKey(todayKey, 2 + i);
    const startsAt = minutes(utcInstantOfLocalMidnight(key, frontBeach.tz), 14 * 60);
    const id = rng.uuid();
    openShifts.push({ id, startsAt });
    shiftRows.push({
      id, clientId: frontBeach.clientId, locationId: frontBeach.id, position: i % 2 ? 'Cashier' : 'GM floor associate', startsAt, endsAt: new Date(startsAt.getTime() + SHIFT_HOURS * HOUR),
      location: 'Front end', hourlyRate: PAY_RATE.associate, payRate: PAY_RATE.associate, status: 'OPEN', workerId: null, publishedAt: daysAgo(1), createdById: workforce.id, createdAt: daysAgo(1),
      notes: i === 0 ? 'Truck day — extra hands in receiving.' : null,
    });
  }

  await createManyChunked('shifts', shiftRows, (c) => prisma.shift.createMany({ data: c }));
  await createManyChunked('timeEntries', entryRows, (c) => prisma.timeEntry.createMany({ data: c }));
  await createManyChunked('breaks', breakRows, (c) => prisma.breakEntry.createMany({ data: c }));
  await createManyChunked('attendanceEvents', eventRows, (c) => prisma.attendanceEvent.createMany({ data: c }));
  count('unconfirmedNext48h', next48FrontBeach.length);

  // ---- What is waiting on the desks ----------------------------------------
  const frontBeachCrew = people.filter((p) => p.store!.spec.key === 'front-beach' && !p.separatedAt);
  const active = people.filter((p) => !p.separatedAt);

  // A walk-in at the kiosk, four minutes ago.
  await prisma.clockInRequest.create({ data: { associateId: frontBeachCrew[5]!.id, clientId: frontBeach.clientId, locationId: frontBeach.id, requestedAt: minutes(now, -4), status: 'PENDING' } });
  count('walkIns');

  // Pickups: three people asking for the open shifts; four approved in the past.
  for (let i = 0; i < 3; i++) {
    await prisma.openShiftClaim.create({ data: { shiftId: openShifts[i]!.id, associateId: frontBeachCrew[8 + i]!.id, status: 'PENDING', createdAt: minutes(now, -rng.int(30, 600)) } });
  }
  for (let i = 0; i < 4; i++) {
    const p = frontBeachCrew[12 + i]!;
    const past = (pastShiftsOf.get(p.id) ?? []).filter((s) => s.endsAt < daysAgo(7));
    if (past.length === 0) continue;
    const s = rng.pick(past);
    await prisma.openShiftClaim.create({ data: { shiftId: s.id, associateId: p.id, status: 'APPROVED', decidedById: dana.id, decidedAt: minutes(s.startsAt, -3 * 24 * 60), createdAt: minutes(s.startsAt, -4 * 24 * 60) } });
  }
  count('pickups', 7);

  // Swaps: two the peer already said yes to, waiting on a manager; three settled.
  const swapPairs: Array<[Person, Person]> = [[frontBeachCrew[1]!, frontBeachCrew[2]!], [frontBeachCrew[3]!, frontBeachCrew[4]!], [frontBeachCrew[6]!, frontBeachCrew[7]!], [frontBeachCrew[9]!, frontBeachCrew[10]!], [frontBeachCrew[11]!, frontBeachCrew[13]!]];
  for (let i = 0; i < swapPairs.length; i++) {
    const [a, b] = swapPairs[i]!;
    const future = (futureShiftsOf.get(a.id) ?? []).filter((s) => s.startsAt > daysAgo(-3));
    const past = (pastShiftsOf.get(a.id) ?? []).filter((s) => s.endsAt < daysAgo(10));
    if (i < 2 && future.length) {
      await prisma.shiftSwapRequest.create({ data: { shiftId: future[0]!.id, requesterAssociateId: a.id, counterpartyAssociateId: b.id, status: 'PEER_ACCEPTED', note: rng.pick(['Doctor appointment that morning.', "Kid's school event.", "Covering my brother's move."]), createdAt: minutes(now, -rng.int(120, 1400)) } });
    } else if (past.length) {
      const s = rng.pick(past);
      await prisma.shiftSwapRequest.create({ data: { shiftId: s.id, requesterAssociateId: a.id, counterpartyAssociateId: b.id, status: 'MANAGER_APPROVED', decidedById: dana.id, decidedAt: minutes(s.startsAt, -2 * 24 * 60), createdAt: minutes(s.startsAt, -4 * 24 * 60) } });
    }
  }
  count('swaps', swapPairs.length);

  // Time off: three pending, six approved, one denied.
  const timeOff: Prisma.TimeOffRequestCreateManyInput[] = [];
  const categories = ['VACATION', 'SICK', 'PTO', 'BEREAVEMENT', 'OTHER'] as const;
  for (let i = 0; i < 10; i++) {
    const p = active[(i * 5 + 2) % active.length]!;
    const pending = i < 3;
    const startKey = pending ? addDaysToKey(todayKey, rng.int(6, 20)) : addDaysToKey(todayKey, -rng.int(10, 120));
    const days = rng.int(1, 4);
    timeOff.push({
      associateId: p.id, category: pending ? categories[i]! : rng.pick(categories), startDate: dateOf(startKey), endDate: dateOf(addDaysToKey(startKey, days - 1)), requestedMinutes: days * 8 * 60,
      reason: rng.pick(['Family visit', 'Travel booked before the season', 'Not feeling well', 'Moving apartments', null]),
      status: pending ? 'PENDING' : i === 9 ? 'DENIED' : 'APPROVED',
      ...(pending ? { createdAt: minutes(now, -rng.int(60, 2000)) } : { reviewerUserId: dana.id, decidedAt: dateOf(addDaysToKey(startKey, -rng.int(3, 9))), createdAt: dateOf(addDaysToKey(startKey, -rng.int(10, 18))), ...(i === 9 ? { reviewerNote: 'Peak weekend — can we move it a week?' } : {}) }),
    });
  }
  await prisma.timeOffRequest.createMany({ data: timeOff });
  count('timeOff', timeOff.length);

  // ---- Payroll: the last ten periods, run through the real aggregator -----
  let runsMade = 0;
  for (let i = 1; i <= 10; i++) {
    const periodStart = addDaysToKey(current.periodStart, -14 * i);
    const periodEnd = addDaysToKey(periodStart, 13);
    const payDate = addDaysToKey(periodEnd, 7);
    if (payDate > todayKey) continue; // not paid yet — the next payday on the page
    const run = await prisma.$transaction(
      async (tx) => {
        const r = await tx.payrollRun.create({
          data: { clientId: null, periodStart: dateOf(periodStart), periodEnd: dateOf(periodEnd), status: 'DRAFT', createdById: finance.id, createdAt: dateOf(addDaysToKey(periodEnd, 1)) },
        });
        await aggregateAndPersistRun(tx, r, PAY_RATE.associate);
        return r;
      },
      { timeout: 240_000, maxWait: 20_000 },
    );
    const finalizedAt = new Date(dateOf(addDaysToKey(periodEnd, 2)).getTime() + 15 * HOUR);
    const disbursedAt = new Date(dateOf(payDate).getTime() + 11 * HOUR);
    await prisma.payrollItem.updateMany({ where: { payrollRunId: run.id }, data: { status: 'DISBURSED', disbursedAt, disbursementRef: `BRANCH-${periodEnd.replace(/-/g, '')}`, paystubEmailedAt: minutes(disbursedAt, 20) } });
    await prisma.payrollRun.update({ where: { id: run.id }, data: { status: 'DISBURSED', finalizedAt, approvedById: finance.id, approvedAt: finalizedAt, disbursedAt, updatedAt: disbursedAt } });
    runsMade += 1;
  }
  count('payrollRuns', runsMade);

  // ---- Cases and incidents --------------------------------------------------
  const cases: Array<Prisma.HrCaseCreateInput> = [
    { associate: { connect: { id: active[7]!.id } }, category: 'PAYROLL', subject: 'Missing overtime on the Oct 2 stub', description: 'Worked 44 hours the week of Sep 26 and the stub shows 40 at regular. Supervisor confirms the extra Saturday.', priority: 'HIGH', status: 'IN_PROGRESS', assignedTo: { connect: { id: finance.id } }, createdAt: daysAgo(3) },
    { associate: { connect: { id: active[11]!.id } }, category: 'WORKPLACE_CONCERN', subject: 'Break room thermostat locked at 62°', description: 'The overnight crew cannot change the break room temperature and it has been very cold on the last three shifts.', priority: 'MEDIUM', status: 'OPEN', createdAt: daysAgo(1) },
    { associate: { connect: { id: active[19]!.id } }, category: 'PERSONAL_INFO', subject: 'Name change after marriage', description: 'Needs the last name updated on payroll and the badge; new Social Security card uploaded.', priority: 'LOW', status: 'WAITING_ASSOCIATE', assignedTo: { connect: { id: admin.id } }, createdAt: daysAgo(6) },
    { associate: { connect: { id: active[23]!.id } }, category: 'TIME_OFF', subject: 'Bereavement leave documentation', description: 'Requested five days; policy covers three paid. Asked whether the remaining two can come from PTO.', priority: 'MEDIUM', status: 'RESOLVED', assignedTo: { connect: { id: admin.id } }, resolvedAt: daysAgo(12), resolution: 'Three days paid bereavement, two days PTO approved.', createdAt: daysAgo(16) },
  ];
  for (const c of cases) {
    const row = await prisma.hrCase.create({ data: c });
    await prisma.hrCaseComment.create({ data: { caseId: row.id, authorUserId: c.assignedTo ? (c.assignedTo.connect!.id as string) : admin.id, body: rng.pick(['Looking into it today.', 'Pulled the punches for that week; following up with the supervisor.', 'Waiting on the document before we can change the record.']), createdAt: minutes(now, -rng.int(60, 1500)) } });
  }
  count('hrCases', cases.length);
  await prisma.oshaIncident.createMany({
    data: [
      { clientId: frontBeach.clientId, locationId: frontBeach.id, associateId: active[14]!.id, occurredAt: daysAgo(21), reportedAt: daysAgo(21), reportedById: dana.id, location: 'Receiving dock', description: 'Pallet jack rolled onto left foot while unloading the morning truck. Ice applied; associate finished the shift.', bodyPart: 'Left foot', severity: 'FIRST_AID', isRecordable: false, status: 'RESOLVED', resolutionNote: 'Dock mats replaced; pallet jack brake inspected.', resolvedAt: daysAgo(18) },
      { clientId: frontBeach.clientId, locationId: frontBeach.id, associateId: active[27]!.id, occurredAt: daysAgo(4), reportedAt: daysAgo(4), reportedById: dana.id, location: 'Deli', description: 'Slicer guard was off during cleaning; cut to the right index finger needing two stitches at urgent care.', bodyPart: 'Right hand', severity: 'MEDICAL_TREATMENT', daysRestricted: 5, status: 'INVESTIGATING' },
    ],
  });
  count('oshaIncidents', 2);

  // ---- Recruiting -------------------------------------------------------------
  const postings = await Promise.all(
    [
      { title: 'Overnight stocker', slug: 'demo-overnight-stocker-front-beach-218', client: coastal, location: 'Panama City Beach, FL', openings: 3 },
      { title: 'Cashier', slug: 'demo-cashier-destin-harbor-507', client: coastal, location: 'Destin, FL', openings: 2 },
      { title: 'Deli associate', slug: 'demo-deli-associate-gulf-coast-grocers', client: gulf, location: 'Panama City, FL', openings: 2 },
    ].map((j) =>
      prisma.jobPosting.create({
        data: { title: j.title, slug: j.slug, clientId: j.client.id, location: j.location, openings: j.openings, status: 'OPEN', openedAt: daysAgo(rng.int(5, 30)), minSalary: PAY_RATE.associate, maxSalary: PAY_RATE.lead, createdById: recruiter.id, description: `${j.title} at ${j.client.name}, ${j.location}. Full-time, weekends in rotation, paid biweekly. Alto People places you, trains you and drives you to the store.` },
      }),
    ),
  );
  const candidateNames: Array<[string, string, CandidateStage]> = [
    ['Priya', 'Natarajan', 'APPLIED'], ['Owen', 'Caldwell', 'APPLIED'], ['Marisol', 'Peña', 'APPLIED'], ['Deshawn', 'Ellis', 'APPLIED'],
    ['Hugo', 'Barrera', 'SCREENING'], ['Aylin', 'Koç', 'SCREENING'], ['Tessa', 'Morgan', 'SCREENING'],
    ['Nico', 'Alvarado', 'INTERVIEW'], ['Reagan', 'Holt', 'INTERVIEW'], ['Beatriz', 'Lima', 'INTERVIEW'],
    ['Cedric', 'Lane', 'OFFER'], ['Amara', 'Okafor', 'HIRED'],
  ];
  for (let i = 0; i < candidateNames.length; i++) {
    const [first, last, stage] = candidateNames[i]!;
    const posting = postings[i % postings.length]!;
    const c = await prisma.candidate.create({
      data: {
        firstName: first, lastName: last, email: `${emailLocal(first, last)}@candidates.${DEMO_EMAIL_DOMAIN}`, phone: `+1-850-555-${String(2100 + i).slice(-4)}`, position: posting.title, source: rng.pick(['Indeed', 'Referral', 'Walk-in', 'Careers page']),
        stage, jobPostingId: posting.id, stageChangedAt: daysAgo(rng.int(0, 9)), createdAt: daysAgo(rng.int(3, 28)),
        ...(stage === 'HIRED' ? { hiredAssociateId: active[30]!.id, hiredClientId: coastal.id, hiredAt: daysAgo(2) } : {}),
      },
    });
    await prisma.candidateEvent.create({ data: { candidateId: c.id, kind: 'CREATED', toStage: 'APPLIED', actorUserId: recruiter.id, createdAt: c.createdAt } });
    if (stage === 'INTERVIEW' || stage === 'OFFER') {
      const scheduledFor = i === 7 ? minutes(now, 110) : i === 8 ? minutes(now, 260) : i === 9 ? minutes(now, 26 * 60) : daysAgo(6);
      await prisma.interview.create({ data: { candidateId: c.id, interviewerUserId: recruiter.id, scheduledFor, durationMinutes: 30, location: i === 9 ? 'Phone' : 'Front Beach 218 · training room', ...(i === 10 ? { completedAt: minutes(scheduledFor, 35), rating: 4 } : {}) } });
      await prisma.candidateEvent.create({ data: { candidateId: c.id, kind: 'INTERVIEW_SCHEDULED', actorUserId: recruiter.id, createdAt: daysAgo(1) } });
    }
  }
  count('candidates', candidateNames.length);
  count('jobPostings', postings.length);

  // ---- The agents' trail ------------------------------------------------------
  await ensureBuiltInAgents(prisma);
  const profiles = await prisma.agentProfile.findMany({ where: { builtInKey: { in: ['workforce-agent', 'compliance-agent'] } }, select: { workerId: true, builtInKey: true } });
  const workforceAgent = profiles.find((p) => p.builtInKey === 'workforce-agent')?.workerId;
  const complianceAgent = profiles.find((p) => p.builtInKey === 'compliance-agent')?.workerId;
  const audit: Prisma.AuditLogCreateManyInput[] = [];
  if (workforceAgent) {
    // Shift fills: what the agent proposed, who decided, what happened.
    const outcomes = ['EXECUTED', 'EXECUTED', 'EXECUTED', 'EXECUTED', 'REJECTED', 'EXPIRED', 'PROPOSED', 'PROPOSED'] as const;
    for (let i = 0; i < outcomes.length; i++) {
      const status = outcomes[i]!;
      const pending = status === 'PROPOSED';
      const proposed = pending ? minutes(now, -rng.int(40, 400)) : daysAgo(rng.int(2, 40));
      const p = frontBeachCrew[(i * 3) % frontBeachCrew.length]!;
      const subject = pending ? openShifts[3 + (i % 2)]! : rng.pick(pastShiftsOf.get(p.id) ?? [{ id: rng.uuid(), startsAt: proposed, endsAt: proposed }]);
      const payload = { capability: 'shift.fill', shiftId: subject.id, associateId: p.id, reason: 'Placed here, free that day, under 40 hours this week' };
      const approval = await prisma.agentApprovalRequest.create({
        data: {
          workerId: workforceAgent, action: 'SHIFT_ASSIGN', summary: `Fill ${subject.startsAt.toISOString().slice(0, 10)} at Front Beach 218 with ${p.firstName} ${p.lastName}`,
          payload, payloadHash: payloadHash('SHIFT_ASSIGN', payload), requestedAt: proposed, expiresAt: new Date(proposed.getTime() + 24 * HOUR),
          status: pending ? 'PENDING' : status === 'EXECUTED' ? 'CONSUMED' : status === 'REJECTED' ? 'REJECTED' : 'EXPIRED',
          ...(status === 'EXECUTED' || status === 'REJECTED' ? { decidedById: dana.id, decidedAt: minutes(proposed, rng.int(12, 180)), decisionNote: status === 'REJECTED' ? 'She already has 38 hours; keep it open.' : null } : {}),
          ...(status === 'EXECUTED' ? { consumedAt: minutes(proposed, rng.int(181, 240)) } : {}),
        },
      });
      await prisma.agentProposal.create({
        data: { workerId: workforceAgent, capabilityKey: 'shift.fill', subjectType: 'Shift', subjectId: subject.id, payload, approvalId: approval.id, status, statusAt: pending ? proposed : minutes(proposed, 200), createdAt: proposed, ...(status === 'EXECUTED' ? { outcome: { assigned: true }, outcomeAt: minutes(proposed, 200) } : {}) },
      });
      audit.push({ workerId: workforceAgent, action: 'agent.shift_fill.proposed', entityType: 'Shift', entityId: subject.id, metadata: { capability: 'shift.fill', associateId: p.id, approvalId: approval.id }, createdAt: proposed });
      audit.push({ workerId: workforceAgent, action: 'agent.approval.requested', entityType: 'AgentApprovalRequest', entityId: approval.id, metadata: { gated: 'SHIFT_ASSIGN', summary: approval.summary }, createdAt: minutes(proposed, 1) });
      if (status === 'EXECUTED') audit.push({ workerId: workforceAgent, action: 'agent.shift_fill.assigned', entityType: 'Shift', entityId: subject.id, metadata: { associateId: p.id, approvalId: approval.id }, createdAt: minutes(proposed, 200) });
    }
    // Day-before confirmations: asked on WhatsApp, answered by most.
    const confirmed = Array.from(futureShiftsOf.entries()).flatMap(([associateId, list]) => list.filter((s) => s.startsAt.getTime() - now.getTime() < 36 * HOUR && !next48FrontBeach.includes(s.id)).map((s) => ({ associateId, s }))).slice(0, 14);
    for (const { associateId, s } of confirmed) {
      const sentAt = new Date(s.startsAt.getTime() - 26 * HOUR);
      if (sentAt > now) continue;
      const answered = rng.chance(0.85);
      await prisma.attendanceConfirmation.create({ data: { shiftId: s.id, associateId, workerId: workforceAgent, channel: 'whatsapp', sentAt, cutoffAt: new Date(s.startsAt.getTime() - 12 * HOUR), ...(answered ? { answer: 'YES', answeredAt: minutes(sentAt, rng.int(5, 240)), answeredVia: 'whatsapp' } : {}) } });
      audit.push({ workerId: workforceAgent, action: 'agent.attendance_confirm.sent', entityType: 'Shift', entityId: s.id, metadata: { capability: 'attendance.confirm', channel: 'whatsapp' }, createdAt: sentAt });
      count('attendanceConfirmations');
    }
  }
  if (complianceAgent) {
    for (const { person, docId, expiresAt } of expiringSoon) {
      const sentAt = daysAgo(2);
      await prisma.documentChase.create({ data: { itemKey: `document:${docId}`, associateId: person.id, workerId: complianceAgent, kind: 'DOCUMENT', label: 'Driver license', expiresAt, stage: 1, lastSentAt: sentAt } });
      audit.push({ workerId: complianceAgent, action: 'agent.document_chase.sent', entityType: 'Associate', entityId: person.id, metadata: { capability: 'document.chase', items: [`document:${docId}`], lang: person.lang }, createdAt: sentAt });
    }
    count('documentChases', expiringSoon.length);
  }
  if (audit.length) await prisma.auditLog.createMany({ data: audit });
  count('agentAuditRows', audit.length);

  // ---- Messages: the store channel and a thread with the desk ----------------
  await ensureStoreChannels({ id: dana.id, role: dana.role, clientId: dana.clientId, locationId: dana.locationId, regionId: dana.regionId }, prisma);
  await ensureStoreChannels({ id: portal.id, role: portal.role, clientId: portal.clientId, locationId: portal.locationId, regionId: portal.regionId }, prisma);
  const channel = await prisma.conversation.findFirst({ where: { kind: 'STORE_CHANNEL', clientId: frontBeach.clientId, locationId: frontBeach.id } });
  if (channel) {
    const thread: Array<[string, string, number]> = [
      [portal.id, 'Truck is landing at 6 tomorrow instead of 8 — can receiving start early?', 26 * 60],
      [dana.id, 'Yes. I moved two of the morning crew to a 5:30 start and told them on the channel.', 25 * 60 + 40],
      [portal.id, 'Thank you. Also the deli slicer incident — is the associate okay?', 24 * 60],
      [dana.id, 'Two stitches, back on restricted duty Thursday. The guard procedure is on the SOP again and we walked it with the crew.', 23 * 60 + 30],
      [portal.id, 'Appreciated. Fill rate looked good this week.', 3 * 60],
      [dana.id, 'Two short on Tuesday overnight, otherwise full. Covering tomorrow\'s afternoon with a pickup now.', 2 * 60 + 15],
    ];
    for (const [senderId, body, minsAgo] of thread) {
      await prisma.message.create({ data: { conversationId: channel.id, senderId, body, createdAt: minutes(now, -minsAgo) } });
    }
    await prisma.conversation.update({ where: { id: channel.id }, data: { lastMessageAt: minutes(now, -thread[thread.length - 1]![2]), lastPreview: thread[thread.length - 1]![1].slice(0, 160) } });
    count('messages', thread.length);
  }
  const direct = await prisma.conversation.create({ data: { kind: 'DIRECT', createdById: admin.id, participants: { create: [{ userId: admin.id }, { userId: dana.id }] }, lastMessageAt: minutes(now, -50), lastPreview: 'Sending the two names over now.' } });
  for (const [senderId, body, minsAgo] of [[admin.id, 'Dana — the two overnight stockers from the posting cleared background today. Can you take them on next week\'s schedule?', 95], [dana.id, 'Yes, put them on Monday and Tuesday overnight with Marcus.', 70], [admin.id, 'Sending the two names over now.', 50]] as Array<[string, string, number]>) {
    await prisma.message.create({ data: { conversationId: direct.id, senderId, body, createdAt: minutes(now, -minsAgo) } });
  }
  count('messages', 3);

  // ---- The bell: what each desk was told ---------------------------------------
  const notes: Prisma.NotificationCreateManyInput[] = [
    { channel: 'IN_APP', status: 'SENT', recipientUserId: admin.id, category: 'agent_approval', subject: 'Workforce agent is asking for approval', body: 'Assign a person to a shift: fill tomorrow\'s afternoon at Front Beach 218', linkUrl: '/agents', sentAt: minutes(now, -45), createdAt: minutes(now, -45) },
    { channel: 'IN_APP', status: 'SENT', recipientUserId: admin.id, category: 'onboarding.submitted', subject: 'Application submitted', body: `${DEMO_CAST[DEMO_CREW_TOTAL]!.first} ${DEMO_CAST[DEMO_CREW_TOTAL]!.last} finished onboarding and is ready for review.`, linkUrl: '/onboarding', sentAt: minutes(now, -130), createdAt: minutes(now, -130) },
    { channel: 'IN_APP', status: 'SENT', recipientUserId: admin.id, category: 'compliance.expirations', subject: '2 identity documents expire within 30 days', body: 'The Compliance agent has asked both people for a renewal in their language.', linkUrl: '/compliance', sentAt: daysAgo(2), createdAt: daysAgo(2), readAt: daysAgo(1) },
    { channel: 'IN_APP', status: 'SENT', recipientUserId: admin.id, category: 'hr_case', subject: 'New HR case: Break room thermostat locked at 62°', body: 'Workplace concern from the overnight crew at Front Beach 218.', linkUrl: '/hr-cases', sentAt: daysAgo(1), createdAt: daysAgo(1) },
    { channel: 'IN_APP', status: 'SENT', recipientUserId: finance.id, category: 'payroll', subject: 'Payroll disbursed', body: `${runsMade ? 'The last period paid on schedule.' : 'No run yet.'}`, linkUrl: '/payroll', sentAt: daysAgo(6), createdAt: daysAgo(6), readAt: daysAgo(5) },
    { channel: 'IN_APP', status: 'SENT', recipientUserId: dana.id, category: 'scheduling.swap', subject: 'A swap is waiting on you', body: 'Peer already said yes; approve or reject before the shift.', linkUrl: '/approvals?tab=swaps', sentAt: minutes(now, -200), createdAt: minutes(now, -200) },
    { channel: 'IN_APP', status: 'SENT', recipientUserId: dana.id, category: 'scheduling.unconfirmed', subject: `${next48FrontBeach.length} shifts in the next 48h are not confirmed`, body: 'Chase by phone or let the Workforce agent propose a backup.', linkUrl: '/approvals?tab=unconfirmed', sentAt: minutes(now, -60), createdAt: minutes(now, -60) },
    { channel: 'IN_APP', status: 'SENT', recipientUserId: portal.id, category: 'portal.weekly', subject: 'Your weekly service report is ready', body: 'Fill rate, reliability and hours delivered for last week at Front Beach 218.', linkUrl: '/portal/history', sentAt: daysAgo(2), createdAt: daysAgo(2) },
    { channel: 'IN_APP', status: 'SENT', recipientUserId: portal.id, category: 'message', subject: 'Dana Reyes replied in Front Beach 218', body: 'Two short on Tuesday overnight, otherwise full.', linkUrl: channel ? `/messages/${channel.id}` : '/messages', sentAt: minutes(now, -135), createdAt: minutes(now, -135) },
  ];
  await prisma.notification.createMany({ data: notes });
  count('notifications', notes.length);

  // ---- Done: the marker, then the receipt ----------------------------------------
  await prisma.auditLog.create({ data: { action: MARKER_ACTION, entityType: 'Tenant', entityId: ALTO_TENANT_ID, actorUserId: admin.id, metadata: { seed: SEED, today: todayKey, counts } } });
  console.log(`[seed-demo] complete — anchored on ${todayKey}`);
  for (const [k, v] of Object.entries(counts)) console.log(`[seed-demo]   ${k}: ${v}`);
  console.log(`[seed-demo]   associate logins: <first.last>@${DEMO_EMAIL_DOMAIN} / ${ASSOCIATE_DEMO_PASSWORD} (first 20 active people)`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[seed-demo] failed:', err);
    process.exit(1);
  });
