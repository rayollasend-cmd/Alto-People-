import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createUser, prisma, truncateAll } from '../../../test/db.js';
import { builtInAgentId, ensureBuiltInAgents, resetAgentRateLimits } from '../../lib/agents.js';
import { catalogFixture, runCapabilityFixture, suspendCapability } from '../../lib/agentCapabilities.js';
import { COVERAGE_FORECAST, computeCoverageForecast, demandOn, runCoverageForecast } from '../../lib/coverageForecast.js';
import { BATON_LABELS } from '../../lib/relayBoard.js';
import { detectConfirmAnswer, detectHugoIntent } from '../../lib/hugo.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';
import { invalidateTenantProfile, setTenantProfile } from '../../lib/tenantProfile.js';
import { utcInstantOfLocalMidnight } from '../../lib/timeAnomalies.js';
import { invalidateUserCache } from '../../middleware/auth.js';

/**
 * Agent families step 3 — the Workforce agent's coverage.forecast and Hugo
 * in the app (docs/agent-families-investigation.md §4 and §4.5).
 *
 *   The forecast: per site, today and the next seven days, demand from the
 *   staffing targets vs the people assigned, the open shifts and the free
 *   bench; written once a day; one Workforce baton on the relay board while
 *   the capability runs. Hugo: one registry for WhatsApp and the app; an
 *   intent whose module or capability is off is neither offered nor
 *   reached; a desk's coverage answer is clamped to its own sites; nothing
 *   he says to the hotel names a client, store, van or Alto.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TZ = 'America/Chicago';
const FORBIDDEN = /\b(clients?|bill rates?|housing|vans?|stores?|associates?|alto)\b/i;
const exempt = (s: string) => s.replace(/Alto People/g, '');

beforeEach(async () => {
  await truncateAll();
  resetAgentRateLimits();
  invalidateTenantProfile();
});
afterAll(async () => {
  invalidateTenantProfile();
  await prisma.$disconnect();
});

const localKey = (days: number) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + days * DAY));
/** 09:00 Chicago, `days` from today. */
const at9 = (days: number) => new Date(utcInstantOfLocalMidnight(localKey(days), TZ).getTime() + 9 * HOUR);

/**
 * A hotel whose day and night windows call for 2 + 1 people; tomorrow Ana
 * is assigned, one shift is open, Ben and Cy are free on its bench. An inn
 * nearby needs one and has one. A site-bound property manager at the hotel.
 */
async function world() {
  const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
  await ensureBuiltInAgents(prisma, ALTO_TENANT_ID);
  const workerId = (await builtInAgentId(prisma, 'workforce-agent', ALTO_TENANT_ID))!;
  await prisma.worker.update({ where: { id: workerId }, data: { status: 'ACTIVE' } });
  const hotel = await prisma.site.create({ data: { name: 'The Grand Hotel', clientId: null, timezone: TZ } });
  const inn = await prisma.site.create({ data: { name: 'The Other Inn', clientId: null, timezone: TZ } });
  const since = new Date(Date.now() - 30 * DAY);
  await prisma.staffingTarget.createMany({
    data: [
      { locationId: hotel.id, targetCount: 5, effectiveFrom: since },
      { locationId: hotel.id, targetCount: 2, effectiveFrom: since, label: 'Day', startMinute: 420, endMinute: 900 },
      { locationId: hotel.id, targetCount: 1, effectiveFrom: since, label: 'Night', startMinute: 1380, endMinute: 420 },
      { locationId: inn.id, targetCount: 1, effectiveFrom: since },
    ],
  });
  const ana = await createAssociate({ firstName: 'Ana', lastName: 'One' });
  const ben = await createAssociate({ firstName: 'Ben', lastName: 'Two' });
  const cy = await createAssociate({ firstName: 'Cy', lastName: 'Three' });
  const dee = await createAssociate({ firstName: 'Dee', lastName: 'Four' });
  for (const a of [ana, ben, cy]) await prisma.associateAssignment.create({ data: { associateId: a.id, locationId: hotel.id, startedAt: since } });
  await prisma.associateAssignment.create({ data: { associateId: dee.id, locationId: inn.id, startedAt: since } });
  const { user: anaUser } = await createUser({ role: 'ASSOCIATE', email: ana.email, associateId: ana.id });
  const now = new Date();
  const start = at9(1);
  const end = new Date(start.getTime() + 8 * HOUR);
  await prisma.shift.create({ data: { clientId: null, locationId: hotel.id, position: 'Housekeeper', startsAt: start, endsAt: end, status: 'ASSIGNED', assignedAssociateId: ana.id, publishedAt: now } });
  await prisma.shift.create({ data: { clientId: null, locationId: hotel.id, position: 'Housekeeper', startsAt: start, endsAt: end, status: 'OPEN', publishedAt: now } });
  await prisma.shift.create({ data: { clientId: null, locationId: inn.id, position: 'Housekeeper', startsAt: start, endsAt: end, status: 'ASSIGNED', assignedAssociateId: dee.id, publishedAt: now } });
  const { user: manager } = await createUser({ role: 'SHIFT_SUPERVISOR' });
  await prisma.user.update({ where: { id: manager.id }, data: { locationId: inn.id } });
  return { hr, workerId, hotel, inn, ana, anaUser, manager };
}

describe('coverage.forecast', () => {
  it('reads the windows (summed, over the total), the people assigned, the open shifts and the free bench, today and seven days out', async () => {
    const w = await world();
    const forecast = await computeCoverageForecast(prisma, new Date(), { tenantId: ALTO_TENANT_ID });
    const hotel = forecast.find((s) => s.locationId === w.hotel.id)!;
    expect(hotel.days.map((d) => d.leadDays)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(hotel.days[1]).toMatchObject({ date: localKey(1), demand: 3, assigned: 1, openShifts: 1, bench: 2, gap: 2 });
    expect(forecast.find((s) => s.locationId === w.inn.id)!.days[1]).toMatchObject({ demand: 1, assigned: 1, gap: 0 });
    // Effective-dated: a newer window from the day after tomorrow wins from that day.
    const rows = [
      { locationId: 'x', label: 'Day', targetCount: 2, effectiveFrom: new Date('2026-01-01') },
      { locationId: 'x', label: 'Day', targetCount: 4, effectiveFrom: new Date('2026-03-01') },
      { locationId: 'x', label: null, targetCount: 9, effectiveFrom: new Date('2026-01-01') },
    ];
    expect(demandOn(rows, '2026-02-15')).toBe(2);
    expect(demandOn(rows, '2026-03-01')).toBe(4);
    expect(demandOn([rows[2]!], '2026-02-15')).toBe(9);
    expect(demandOn(rows, '2025-12-31')).toBeNull();
  });

  it('writes once a day, puts one Workforce baton on the relay board, and the trail records the run', async () => {
    const w = await world();
    const first = await runCoverageForecast(prisma, new Date());
    expect(first).toMatchObject({ sites: 2, written: 16 });
    expect((await runCoverageForecast(prisma, new Date())).written).toBe(0);
    await flushPendingAudits();
    expect(await prisma.auditLog.count({ where: { workerId: w.workerId, action: 'agent.coverage.forecast' } })).toBe(1);

    const hr = await loginAs(agent(), w.hr.email);
    const board = await hr.get('/relay/board');
    expect(board.status).toBe(200);
    const baton = board.body.batons.find((b: { key: string }) => b.key === 'coverage-gap');
    expect(baton).toMatchObject({ desk: 'WORKFORCE', label: BATON_LABELS['coverage-gap'], status: 'overdue' });
    expect(baton.count).toBeGreaterThanOrEqual(1);
    expect(baton.link).toContain(`location=${w.hotel.id}`);
  });

  it('suspended: nothing written and no baton', async () => {
    const w = await world();
    await suspendCapability(prisma, w.workerId, COVERAGE_FORECAST, ALTO_TENANT_ID, w.hr.id, 'Checking the targets');
    expect(await runCoverageForecast(prisma, new Date())).toMatchObject({ written: 0, skipped: 'capability_off' });
    const board = await (await loginAs(agent(), w.hr.email)).get('/relay/board');
    expect(board.body.batons.some((b: { key: string }) => b.key === 'coverage-gap')).toBe(false);
  });

  it('the scorecard compares what was forecast 7 and 1 days ahead with the day itself', async () => {
    const w = await world();
    const day = new Date(`${localKey(-1)}T00:00:00Z`);
    const row = (lead: number, assigned: number) => ({ tenantId: ALTO_TENANT_ID, locationId: w.hotel.id, forecastOn: new Date(day.getTime() - lead * DAY), targetDay: day, leadDays: lead, demand: 4, assigned, openShifts: 0, bench: 0, gap: Math.max(0, 4 - assigned) });
    await prisma.coverageForecastDay.createMany({ data: [row(7, 2), row(1, 3), row(0, 4)] });
    const sc = await (await loginAs(agent(), w.hr.email)).get(`/agents/${w.workerId}/capabilities/${COVERAGE_FORECAST}/scorecard`);
    expect(sc.status, JSON.stringify(sc.body)).toBe(200);
    expect(sc.body.metrics).toMatchObject({ forecastErrorPct7d: 50, forecastErrorPct1d: 25 });
  });

  it('the catalog fixture runs through the real computation and passes', async () => {
    const fixture = catalogFixture(COVERAGE_FORECAST, 'Two sites, one short tomorrow: the forecast names it and the gap')!;
    const direct = await runCapabilityFixture(COVERAGE_FORECAST, fixture, new Date());
    expect(direct, JSON.stringify(direct)).toMatchObject({ passed: true, reason: null });
    expect(direct.refAnswer?.output).toEqual({ shortRef: 'hotel', gap: 2 });
  });
});

describe('Hugo in the app', () => {
  it('a desk hears what is on, and asks coverage clamped to its own site; the trail has the intent, never the words', async () => {
    const w = await world();
    const admin = await loginAs(agent(), w.hr.email);
    const me = await admin.get('/hugo');
    expect(me.status, JSON.stringify(me.body)).toBe(200);
    expect(me.body).toMatchObject({ name: 'Hugo', audience: 'admin' });
    // "Your assistant" (the owner, 2026-10-29) — and still not a person.
    expect(me.body.intro).toMatch(/^I'm Hugo, your assistant in Alto People — not a person, but always here\./);
    expect(me.body.can.map((c: { key: string }) => c.key)).toEqual(expect.arrayContaining(['DESK', 'COVERAGE']));

    const all = await admin.post('/hugo/ask').send({ text: 'Where are we short this week?' });
    expect(all.body.intent).toBe('COVERAGE');
    expect(all.body.reply).toContain('The Grand Hotel');
    expect(all.body.linkUrl).toContain(`location=${w.hotel.id}`);

    // The inn's property manager sees the inn only, which is covered.
    const mgr = await loginAs(agent(), w.manager.email);
    const mine = await mgr.post('/hugo/ask').send({ text: 'how is coverage?' });
    expect(mine.body.intent).toBe('COVERAGE');
    expect(mine.body.reply).toContain('The Other Inn');
    expect(mine.body.reply).not.toContain('The Grand Hotel');

    const desk = await mgr.post('/hugo/ask').send({ text: 'What is waiting on me?' });
    expect(desk.body).toMatchObject({ intent: 'DESK', reply: 'Nothing from the agents is waiting on you.' });

    await flushPendingAudits();
    const asked = await prisma.auditLog.findMany({ where: { action: 'hugo.asked', actorUserId: w.hr.id } });
    expect(asked).toHaveLength(1);
    expect(JSON.stringify(asked[0]!.metadata)).not.toContain('short this week');
  });

  it('a capability suspended is neither offered nor reached; Hugo switched off is silent', async () => {
    const w = await world();
    await suspendCapability(prisma, w.workerId, COVERAGE_FORECAST, ALTO_TENANT_ID, w.hr.id, 'Checking the targets');
    const admin = await loginAs(agent(), w.hr.email);
    const me = await admin.get('/hugo');
    expect(me.body.can.map((c: { key: string }) => c.key)).toEqual(expect.arrayContaining(['DESK']));
    expect(me.body.can.map((c: { key: string }) => c.key)).not.toContain('COVERAGE');
    expect(me.body.intro).not.toMatch(/coverage/i);
    const asked = await admin.post('/hugo/ask').send({ text: 'Where are we short this week?' });
    expect(asked.body.intent).toBe('HELP');
    expect(asked.body.reply).not.toMatch(/coverage/i);

    const hugoId = (await builtInAgentId(prisma, 'whatsapp-assistant', ALTO_TENANT_ID))!;
    await prisma.agentProfile.update({ where: { workerId: hugoId }, data: { suspendedAt: new Date() } });
    const off = await admin.get('/hugo');
    expect(off.status).toBe(409);
    expect(off.body.error.code).toBe('hugo_off');
  });

  it('an associate asks about their own schedule; coverage is not theirs to ask', async () => {
    const w = await world();
    const ana = await loginAs(agent(), w.anaUser.email);
    const me = await ana.get('/hugo');
    expect(me.body.audience).toBe('associate');
    expect(me.body.can.map((c: { key: string }) => c.key)).toEqual(expect.arrayContaining(['PAYDAY', 'RIDE', 'SCHEDULE']));
    const sched = await ana.post('/hugo/ask').send({ text: "What's my schedule?" });
    expect(sched.body.intent).toBe('SCHEDULE');
    expect(sched.body.reply).toContain('Housekeeper');
    const who = await ana.post('/hugo/ask').send({ text: 'who are you?' });
    expect(who.body.intent).toBe('WHO');
    expect((await ana.post('/hugo/ask').send({ text: 'Where are we short this week?' })).body.intent).toBe('HANDOFF');
  });

  it('under the hotel profile nothing he offers or says names a client, store, van or Alto', async () => {
    const w = await world();
    const admin = await loginAs(agent(), w.hr.email);
    try {
      // The hotel names itself: "the app" in a reply is its name (as in hotelJourney).
      expect((await admin.patch('/admin/org/settings').send({ orgName: 'The Grand Hotel' })).status).toBe(200);
      await setTenantProfile(ALTO_TENANT_ID, { businessModel: 'DIRECT_EMPLOYER', resetToDefaults: true }, w.hr.id);
      invalidateTenantProfile();
      for (const lang of ['en', 'es', 'tr'] as const) {
        await prisma.user.updateMany({ where: { id: { in: [w.hr.id, w.anaUser.id, w.manager.id] } }, data: { language: lang } });
        for (const id of [w.hr.id, w.anaUser.id, w.manager.id]) invalidateUserCache(id);
        for (const email of [w.hr.email, w.manager.email, w.anaUser.email]) {
          const s = await loginAs(agent(), email);
          const me = await s.get('/hugo');
          expect(me.status).toBe(200);
          const said = [me.body.intro, ...me.body.can.flatMap((c: { label: string; example: string }) => [c.label, c.example])];
          for (const c of me.body.can as Array<{ example: string }>) said.push((await s.post('/hugo/ask').send({ text: c.example })).body.reply);
          said.push((await s.post('/hugo/ask').send({ text: 'who are you?' })).body.reply);
          for (const line of said) expect(exempt(String(line)), `${lang} ${email}: ${line}`).not.toMatch(FORBIDDEN);
          // Transportation is off for the hotel: no ride anywhere.
          expect(me.body.can.some((c: { key: string }) => c.key === 'RIDE')).toBe(false);
        }
      }
    } finally {
      await admin.patch('/admin/org/settings').send({ orgName: 'Alto HR' });
      await prisma.user.updateMany({ where: { id: { in: [w.hr.id, w.anaUser.id, w.manager.id] } }, data: { language: 'en' } });
      await setTenantProfile(ALTO_TENANT_ID, { businessModel: 'WORKFORCE_PROVIDER', resetToDefaults: true }, w.hr.id);
      invalidateTenantProfile();
    }
  });
});

describe('the registry', () => {
  it('keeps WhatsApp precedence; a module off is never matched; YES/NO must be the whole word', () => {
    const wa = { channel: 'whatsapp' as const, audience: 'associate' as const, capabilityOn: () => true };
    expect(detectHugoIntent('What time is my ride', { ...wa, moduleOn: () => true }).intent).toBe('RIDE');
    expect(detectHugoIntent('What time is my ride', { ...wa, moduleOn: (m) => m !== 'transportation' }).intent).toBe('HANDOFF');
    expect(detectHugoIntent('STOP my shifts', { ...wa, moduleOn: () => true }).intent).toBe('OPT_OUT');
    expect(detectHugoIntent('where are we short', { ...wa, moduleOn: () => true }).intent).toBe('HANDOFF');
    expect(detectConfirmAnswer('Sí!')).toBe('YES');
    expect(detectConfirmAnswer('yes ')).toBe('YES');
    expect(detectConfirmAnswer('yess')).toBeNull();
    expect(detectConfirmAnswer('no thanks')).toBeNull();
    const staff = { channel: 'app' as const, audience: 'manager' as const, moduleOn: () => true, capabilityOn: () => true };
    expect(detectHugoIntent('Bende ne bekliyor?', staff).intent).toBe('DESK');
    expect(detectHugoIntent('¿Qué está pendiente para mí?', staff).intent).toBe('DESK');
    expect(detectHugoIntent('Bu hafta nerede eksik var?', staff).intent).toBe('COVERAGE');
    expect(detectHugoIntent('Programım ne?', { ...wa, moduleOn: () => true }).intent).toBe('SCHEDULE');
  });
});
