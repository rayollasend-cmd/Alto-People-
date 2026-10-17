import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createUser, prisma, truncateAll } from '../../../test/db.js';
import { builtInAgentId, ensureBuiltInAgents, resetAgentRateLimits } from '../../lib/agents.js';
import { catalogFixture, runCapabilityFixture, suspendCapability } from '../../lib/agentCapabilities.js';
import { askFrom, runAttendanceConfirm } from '../../lib/attendanceConfirm.js';
import { recordNoShowAttendance } from '../../lib/attendance.js';
import { handleInbound } from '../../lib/whatsappAssistant.js';
import { ATTENDANCE_CONFIRM } from '../../lib/workforceAgent.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';
import { invalidateTenantProfile } from '../../lib/tenantProfile.js';
import { utcInstantOfLocalMidnight } from '../../lib/timeAnomalies.js';

/**
 * Agent families step 2 — the Workforce agent's attendance.confirm
 * (docs/agent-families-investigation.md §4; 12-hour cut-off, owner 2026-10-15).
 *
 *   The day before, at 10:00 site time, the agent asks each high-risk
 *   holder whether they are coming (WhatsApp when opted in, the app
 *   otherwise), once, in place of the reminder and the generic nudge. YES
 *   confirms; NO files a backup at once; silence past the cut-off files
 *   one too; the holder confirming retires it. A NO left uncovered is a
 *   call-out, not a no-call no-show.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TZ = 'America/Chicago';

beforeEach(async () => {
  await truncateAll();
  resetAgentRateLimits();
  invalidateTenantProfile();
});
afterAll(async () => {
  invalidateTenantProfile();
  await prisma.$disconnect();
});

/** 08:00 Chicago, `days` from today: in the real future, so the app routes accept it. */
function localMorning(days: number): Date {
  const key = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + days * DAY));
  return new Date(utcInstantOfLocalMidnight(key, TZ).getTime() + 8 * HOUR);
}

/**
 * A hotel: Rhea (two no-call no-shows) and Sam (one late) each hold an
 * 8 AM shift three days out; Tess is free on the bench. `askAt` is an hour
 * past the ask time for those shifts.
 */
async function hotelWorld() {
  const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
  await ensureBuiltInAgents(prisma, ALTO_TENANT_ID);
  const workerId = (await builtInAgentId(prisma, 'workforce-agent', ALTO_TENANT_ID))!;
  // It boots ONBOARDING; these cases exercise it as an owner would after certifying it.
  await prisma.worker.update({ where: { id: workerId }, data: { status: 'ACTIVE' } });
  const hotel = await prisma.site.create({ data: { name: 'The Grand Hotel', clientId: null, timezone: TZ } });
  const people = {
    rhea: await createAssociate({ firstName: 'Rhea', lastName: 'Risky' }),
    sam: await createAssociate({ firstName: 'Sam', lastName: 'Steady' }),
    tess: await createAssociate({ firstName: 'Tess', lastName: 'Free' }),
  };
  for (const p of Object.values(people)) {
    await prisma.associateAssignment.create({ data: { associateId: p.id, locationId: hotel.id, startedAt: new Date(Date.now() - 60 * DAY) } });
  }
  const { user: rheaUser } = await createUser({ role: 'ASSOCIATE', email: people.rhea.email, associateId: people.rhea.id });
  for (const daysAgo of [10, 40]) {
    await prisma.attendanceEvent.create({ data: { associateId: people.rhea.id, kind: 'NO_CALL_NO_SHOW', points: 2, occurredOn: new Date(Date.now() - daysAgo * DAY), source: 'MANUAL' } });
  }
  await prisma.attendanceEvent.create({ data: { associateId: people.sam.id, kind: 'LATE', points: 0.5, occurredOn: new Date(Date.now() - 5 * DAY), source: 'MANUAL' } });
  const startsAt = localMorning(3);
  const endsAt = new Date(startsAt.getTime() + 8 * HOUR);
  const published = new Date();
  const rheaShift = await prisma.shift.create({ data: { clientId: null, locationId: hotel.id, position: 'Housekeeper', startsAt, endsAt, status: 'ASSIGNED', assignedAssociateId: people.rhea.id, publishedAt: published } });
  const samShift = await prisma.shift.create({ data: { clientId: null, locationId: hotel.id, position: 'Housekeeper', startsAt, endsAt, status: 'ASSIGNED', assignedAssociateId: people.sam.id, publishedAt: published } });
  const { user: manager } = await createUser({ role: 'SHIFT_SUPERVISOR' });
  await prisma.user.update({ where: { id: manager.id }, data: { locationId: hotel.id } });
  const askAt = new Date(askFrom({ startsAt, locationRel: { timezone: TZ } }).getTime() + HOUR);
  return { hr, workerId, hotel, ...people, rheaUser, rheaShift, samShift, manager, startsAt, askAt };
}

type World = Awaited<ReturnType<typeof hotelWorld>>;

const backupsFor = (shiftId: string) => prisma.agentProposal.findMany({ where: { capabilityKey: ATTENDANCE_CONFIRM, subjectId: shiftId }, orderBy: { createdAt: 'asc' } });

async function askRhea(w: World) {
  const run = await runAttendanceConfirm(prisma, w.askAt);
  await flushPendingNotifications();
  return run;
}

describe('attendance.confirm: asking', () => {
  it('asks only the high-risk holder, at 10:00 site time the day before, once, in place of the reminder and the nudge', async () => {
    const w = await hotelWorld();
    // An hour before the ask time: nobody.
    expect(await runAttendanceConfirm(prisma, new Date(w.askAt.getTime() - 2 * HOUR))).toMatchObject({ asked: 0 });

    expect(await askRhea(w)).toMatchObject({ asked: 1 });
    const row = await prisma.attendanceConfirmation.findUniqueOrThrow({ where: { shiftId: w.rheaShift.id } });
    expect(row).toMatchObject({ associateId: w.rhea.id, workerId: w.workerId, channel: 'IN_APP', answer: null });
    expect(row.cutoffAt.toISOString()).toBe(new Date(w.startsAt.getTime() - 12 * HOUR).toISOString());
    expect(await prisma.attendanceConfirmation.count({ where: { shiftId: w.samShift.id } })).toBe(0);

    // One message, not three: the reminder and the generic nudge are claimed.
    const shift = await prisma.shift.findUniqueOrThrow({ where: { id: w.rheaShift.id } });
    expect(shift.reminderSentAt).toBeTruthy();
    expect(shift.confirmNudgedAt).toBeTruthy();
    const asks = await prisma.notification.findMany({ where: { recipientUserId: w.rheaUser.id, category: 'shift_confirm', channel: 'IN_APP' } });
    expect(asks).toHaveLength(1);
    expect(asks[0]!.body).toMatch(/I'll be there.*I can't make it/);

    // On the agent's trail, and never twice.
    await flushPendingAudits();
    expect(await prisma.auditLog.count({ where: { workerId: w.workerId, action: 'agent.attendance.asked', entityId: w.rheaShift.id } })).toBe(1);
    expect(await runAttendanceConfirm(prisma, new Date(w.askAt.getTime() + HOUR))).toMatchObject({ asked: 0 });
  });

  it('the capability suspended: nobody is asked', async () => {
    const w = await hotelWorld();
    await suspendCapability(prisma, w.workerId, ATTENDANCE_CONFIRM, ALTO_TENANT_ID, w.hr.id, 'Checking the wording');
    expect(await runAttendanceConfirm(prisma, w.askAt)).toMatchObject({ asked: 0, skipped: 'capability_off' });
  });
});

describe('attendance.confirm: the answers', () => {
  it('"I can\'t make it" in the app files a backup at once; the desk approves; the agent gives the shift to the backup and tells the holder', async () => {
    const w = await hotelWorld();
    await askRhea(w);
    const rhea = await loginAs(agent(), w.rheaUser.email);
    const mine = await rhea.get('/scheduling/me/shifts');
    const listed = mine.body.shifts.find((s: { id: string }) => s.id === w.rheaShift.id);
    expect(listed.confirmationAsk).toMatchObject({ answer: null });

    const declined = await rhea.post(`/scheduling/me/shifts/${w.rheaShift.id}/decline`).send({});
    expect(declined.status, JSON.stringify(declined.body)).toBe(200);
    expect(declined.body.confirmationAsk.answer).toBe('NO');
    await flushPendingNotifications();

    const [p] = await backupsFor(w.rheaShift.id);
    expect(p).toMatchObject({ status: 'PROPOSED' });
    expect(p!.payload).toMatchObject({ associateId: w.tess.id, replacesAssociateId: w.rhea.id, reason: 'NO' });
    const approval = await prisma.agentApprovalRequest.findUniqueOrThrow({ where: { id: p!.approvalId! } });
    expect(approval.summary).toMatch(/^Give Rhea Risky's Housekeeper shift at The Grand Hotel, .* to Tess Free\. Rhea Risky said they can't make it\.$/);
    expect((await prisma.attendanceConfirmation.findUniqueOrThrow({ where: { shiftId: w.rheaShift.id } })).backupProposalId).toBe(p!.id);

    const manager = await loginAs(agent(), w.manager.email);
    const approve = await manager.post('/me/decisions/quick').send({ key: `agents:shift-fill:${approval.id}` });
    expect(approve.status, JSON.stringify(approve.body)).toBe(200);
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: w.rheaShift.id } })).assignedAssociateId).toBe(w.tess.id);
    await flushPendingNotifications();
    const told = await prisma.notification.findFirst({ where: { recipientUserId: w.rheaUser.id, category: 'shift_unassigned', channel: 'IN_APP' } });
    // AI disclosure: the notice ends by saying the agent did it and who answers for it; the record names the agent.
    expect(told?.body).toMatch(/^You told us you can't make .* It is covered and off your schedule\.\n\nSent by Workforce agent, an AI agent — .+ answers for it\.$/);
    expect(told?.byAgentId).toBe(w.workerId);
    const closure = await prisma.notification.findFirst({ where: { recipientUserId: w.manager.id, category: 'agent_shift_fill', channel: 'IN_APP' } });
    expect(closure?.subject).toBe('Backup assigned: Tess Free for Rhea Risky');
    expect(closure?.body).toMatch(/Assigned by Workforce agent on your approval\.\n\nSent by Workforce agent, an AI agent — .+ answers for it\.$/);
    expect(closure?.byAgentId).toBe(w.workerId);
  });

  it('silence past the cut-off files a backup; the holder confirming afterwards retires it', async () => {
    const w = await hotelWorld();
    await askRhea(w);
    const afterCutoff = new Date(w.startsAt.getTime() - 12 * HOUR + 60_000);
    expect(await runAttendanceConfirm(prisma, afterCutoff)).toMatchObject({ backups: 1 });
    const [p] = await backupsFor(w.rheaShift.id);
    expect(p!.payload).toMatchObject({ associateId: w.tess.id, reason: 'SILENT' });
    expect((await prisma.agentApprovalRequest.findUniqueOrThrow({ where: { id: p!.approvalId! } })).summary).toMatch(/Rhea Risky did not confirm by /);
    // A second tick files nothing more.
    expect(await runAttendanceConfirm(prisma, new Date(afterCutoff.getTime() + HOUR))).toMatchObject({ backups: 0 });

    const rhea = await loginAs(agent(), w.rheaUser.email);
    expect((await rhea.post(`/scheduling/me/shifts/${w.rheaShift.id}/acknowledge`).send({})).status).toBe(200);
    const retired = await prisma.agentProposal.findUniqueOrThrow({ where: { id: p!.id } });
    expect(retired.status).toBe('SUPERSEDED');
    expect(retired.outcome).toMatchObject({ reason: 'the holder confirmed they will be there' });
    expect((await prisma.agentApprovalRequest.findUniqueOrThrow({ where: { id: p!.approvalId! } })).status).toBe('EXPIRED');
    expect(await prisma.attendanceConfirmation.findUniqueOrThrow({ where: { shiftId: w.rheaShift.id } })).toMatchObject({ answer: 'YES', answeredVia: 'APP' });
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: w.rheaShift.id } })).assignedAssociateId).toBe(w.rhea.id);
  });

  it('on WhatsApp: asked through it, a bare SÍ confirms; a bare no with nothing asked still goes to a person', async () => {
    const w = await hotelWorld();
    await prisma.whatsAppConsent.create({ data: { associateId: w.rhea.id, phone: '18505550199', status: 'OPTED_IN' } });
    await askRhea(w);
    expect((await prisma.attendanceConfirmation.findUniqueOrThrow({ where: { shiftId: w.rheaShift.id } })).channel).toBe('WHATSAPP');

    const yes = await handleInbound({ from: '18505550199', waMessageId: 'wamid.si', text: 'Sí' }, prisma, w.askAt);
    expect(yes.intent).toBe('CONFIRM_YES');
    expect(yes.reply).toMatch(/confirmed|confirmado/i);
    expect(await prisma.attendanceConfirmation.findUniqueOrThrow({ where: { shiftId: w.rheaShift.id } })).toMatchObject({ answer: 'YES', answeredVia: 'WHATSAPP' });
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: w.rheaShift.id } })).acknowledgedAt).toBeTruthy();

    // Sam was never asked: his "no" is an ordinary message.
    await prisma.whatsAppConsent.create({ data: { associateId: w.sam.id, phone: '18505550198', status: 'OPTED_IN' } });
    const no = await handleInbound({ from: '18505550198', waMessageId: 'wamid.no', text: 'no' }, prisma, w.askAt);
    expect(no.intent).not.toMatch(/^CONFIRM_/);
  });

  it('a NO the desk could not cover is recorded as a call-out, not a no-call no-show', async () => {
    const w = await hotelWorld();
    await askRhea(w);
    await prisma.attendanceConfirmation.update({ where: { shiftId: w.rheaShift.id }, data: { answer: 'NO', answeredAt: new Date(), answeredVia: 'APP' } });
    await recordNoShowAttendance(prisma, { id: w.rheaShift.id, clientId: null, startsAt: w.rheaShift.startsAt, assignedAssociateId: w.rhea.id });
    expect((await prisma.attendanceEvent.findFirstOrThrow({ where: { shiftId: w.rheaShift.id } })).kind).toBe('CALL_OUT');
    // Silence stays a no-call no-show.
    await recordNoShowAttendance(prisma, { id: w.samShift.id, clientId: null, startsAt: w.samShift.startsAt, assignedAssociateId: w.sam.id });
    expect((await prisma.attendanceEvent.findFirstOrThrow({ where: { shiftId: w.samShift.id } })).kind).toBe('NO_CALL_NO_SHOW');
  });

  it('"I can\'t make it" on a shift nobody asked about is refused with a way forward', async () => {
    const w = await hotelWorld();
    const rhea = await loginAs(agent(), w.rheaUser.email);
    const res = await rhea.post(`/scheduling/me/shifts/${w.rheaShift.id}/decline`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('not_asked');
    expect(await backupsFor(w.rheaShift.id)).toHaveLength(0);
  });
});

describe('attendance.confirm: scorecard and certification', () => {
  it('counts asks, answers and accepted backups', async () => {
    const w = await hotelWorld();
    await askRhea(w);
    const rhea = await loginAs(agent(), w.rheaUser.email);
    await rhea.post(`/scheduling/me/shifts/${w.rheaShift.id}/decline`).send({});
    await flushPendingNotifications();
    const admin = await loginAs(agent(), w.hr.email);
    const sc = await admin.get(`/agents/${w.workerId}/capabilities/${ATTENDANCE_CONFIRM}/scorecard`);
    expect(sc.status, JSON.stringify(sc.body)).toBe(200);
    expect(sc.body.metrics).toMatchObject({ textsSent: 1, answered: 1, backupsAccepted: 0, noShowsConfirmed: 0, noShowsUnconfirmed: 0 });
  });

  it('the catalog fixture runs through the real selection and risk score and passes', async () => {
    const fixture = catalogFixture(ATTENDANCE_CONFIRM, 'Two shifts tomorrow, one holder with two no-call no-shows: only that holder is asked')!;
    expect(fixture).toBeTruthy();
    const direct = await runCapabilityFixture(ATTENDANCE_CONFIRM, fixture, new Date('2026-10-14T12:00:00.000Z'));
    expect(direct, JSON.stringify(direct)).toMatchObject({ passed: true, reason: null });
    expect(direct.refAnswer?.output).toEqual({ askedRef: 'rheaShift', asked: 1 });
    expect(await prisma.attendanceEvent.count()).toBe(0);
  });
});
