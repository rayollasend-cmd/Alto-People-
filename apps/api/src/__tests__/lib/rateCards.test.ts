import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { associatesWithoutRate, cardOn, currentRateCards, endRateCard, loadRateCards, resolveRate, setRateCard } from '../../lib/rateCards.js';
import { computeStatementSnapshot } from '../../lib/clientStatement.js';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * Rate cards (Brief 1A-2): one effective-dated pay and bill rate per
 * client and role; every price resolves through the card in force on the
 * day; history is never rewritten; a placed associate whose role has no
 * card is flagged.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const D = (s: string) => new Date(`${s}T12:00:00.000Z`);

describe('effective dating', () => {
  it('a new rate closes the one before it the day before; the card in force on a date is the one that priced it', async () => {
    const client = await createClient('Coastal Resort');
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const first = await setRateCard(prisma, { clientId: client.id, position: 'Associate', payRate: 15, billRate: 21.21, effectiveFrom: '2026-01-01' }, hr.id);
    const raise = await setRateCard(prisma, { clientId: client.id, position: 'Associate', payRate: 16, billRate: 22.5, effectiveFrom: '2026-07-01' }, hr.id);
    expect(first).toMatchObject({ effectiveFrom: '2026-01-01', effectiveTo: null });
    const cards = await loadRateCards(prisma, [client.id]);
    expect(cards.find((c) => c.id === first.id)).toMatchObject({ effectiveTo: '2026-06-30' });
    expect(raise).toMatchObject({ effectiveFrom: '2026-07-01', effectiveTo: null, payRate: 16 });

    expect(cardOn(cards, client.id, 'Associate', D('2026-03-15'))?.payRate).toBe(15);
    expect(cardOn(cards, client.id, 'Associate', D('2026-06-30'))?.payRate).toBe(15);
    expect(cardOn(cards, client.id, 'Associate', D('2026-07-01'))?.payRate).toBe(16);
    expect(cardOn(cards, client.id, 'Associate', D('2025-12-31'))).toBeNull();
    expect((await currentRateCards(prisma, client.id, D('2026-10-14')))[0]).toMatchObject({ payRate: 16 });

    // History is never rewritten: nothing may start before the current card.
    await expect(setRateCard(prisma, { clientId: client.id, position: 'Associate', payRate: 14, billRate: null, effectiveFrom: '2026-05-01' }, hr.id)).rejects.toMatchObject({ code: 'rate_card_history' });
    // The same day replaces in place.
    const fixed = await setRateCard(prisma, { clientId: client.id, position: 'Associate', payRate: 16.5, billRate: 22.5, effectiveFrom: '2026-07-01' }, hr.id);
    expect(fixed.id).toBe(raise.id);
    expect((await loadRateCards(prisma, [client.id])).filter((c) => c.position === 'Associate')).toHaveLength(2);

    // Ending keeps the history; the shifts priced by the card stay priced.
    const ended = await endRateCard(prisma, raise.id, D('2026-10-14'));
    expect(ended).toMatchObject({ effectiveTo: '2026-10-13' });
    expect(cardOn(await loadRateCards(prisma, [client.id]), client.id, 'Associate', D('2026-10-14'))).toBeNull();
    expect(cardOn(await loadRateCards(prisma, [client.id]), client.id, 'Associate', D('2026-09-01'))?.payRate).toBe(16.5);
    // A card ended on the day it started never priced a day: removed.
    const same = await setRateCard(prisma, { clientId: client.id, position: 'Lead', payRate: 18, billRate: 24.24, effectiveFrom: '2026-10-14' }, hr.id);
    expect(await endRateCard(prisma, same.id, D('2026-10-14'))).toBeNull();
    expect((await loadRateCards(prisma, [client.id])).some((c) => c.id === same.id)).toBe(false);
  });

  it('resolves explicit, then the card, then the org standard, and says which', async () => {
    const client = await createClient('Coastal Resort');
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    await setRateCard(prisma, { clientId: client.id, position: 'Associate', payRate: 15.5, billRate: 21.21, effectiveFrom: '2026-01-01' }, hr.id);
    const cards = await loadRateCards(prisma, [client.id]);
    expect(resolveRate(cards, { clientId: client.id, position: 'Associate', startsAt: D('2026-10-14'), payRate: 17 })).toMatchObject({ payRate: 17, billRate: 21.21, source: 'explicit' });
    expect(resolveRate(cards, { clientId: client.id, position: 'Associate', startsAt: D('2026-10-14') })).toMatchObject({ payRate: 15.5, billRate: 21.21, source: 'card' });
    expect(resolveRate(cards, { clientId: client.id, position: 'Lead', startsAt: D('2026-10-14'), isLead: true })).toMatchObject({ payRate: 18, billRate: 24.24, source: 'standard' });
    expect(resolveRate(cards, { clientId: client.id, position: 'Associate', startsAt: D('2025-06-01') })).toMatchObject({ payRate: 15, source: 'standard' });
  });

  it('an evening shift is priced by its own day’s card, not the next UTC date’s', async () => {
    const client = await createClient('Coastal Resort');
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    await setRateCard(prisma, { clientId: client.id, position: 'Associate', payRate: 15, billRate: 21, effectiveFrom: '2026-01-01' }, hr.id);
    await setRateCard(prisma, { clientId: client.id, position: 'Associate', payRate: 16, billRate: 22, effectiveFrom: '2026-07-01' }, hr.id);
    const cards = await loadRateCards(prisma, [client.id]);
    // Tue Jun 30, 9 PM Eastern = Jul 1 01:00 UTC: still June's rate.
    expect(resolveRate(cards, { clientId: client.id, position: 'Associate', startsAt: new Date('2026-07-01T01:00:00Z') })).toMatchObject({ payRate: 15, source: 'card' });
    expect(resolveRate(cards, { clientId: client.id, position: 'Associate', startsAt: new Date('2026-07-01T13:00:00Z') })).toMatchObject({ payRate: 16, source: 'card' });
    // A calendar day given as YYYY-MM-DD is that day.
    expect(cardOn(cards, client.id, 'Associate', '2026-06-30')?.payRate).toBe(15);
  });
});

describe('the surfaces', () => {
  it('the rate editor writes dated cards and lists the current ones; history on request; a statement prices with the card in force at period end', async () => {
    const client = await createClient('Coastal Resort');
    const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(agent(), hr.email);
    const first = await a.put('/scheduling/rate-defaults').send({ clientId: client.id, position: 'Associate', payRate: 15, billRate: 20, effectiveFrom: '2026-01-01' });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ payRate: 15, billRate: 20, effectiveFrom: '2026-01-01', effectiveTo: null });
    const second = await a.put('/scheduling/rate-defaults').send({ clientId: client.id, position: 'Associate', payRate: 16, billRate: 25, effectiveFrom: '2026-09-01' });
    expect(second.status).toBe(200);
    const current = await a.get(`/scheduling/rate-defaults?clientId=${client.id}`);
    expect(current.body.rateDefaults).toEqual([expect.objectContaining({ id: second.body.id, payRate: 16, effectiveFrom: '2026-09-01' })]);
    const history = await a.get(`/scheduling/rate-defaults?clientId=${client.id}&history=1`);
    expect(history.body.rateDefaults).toHaveLength(2);
    expect(history.body.rateDefaults.find((r: { id: string }) => r.id === first.body.id)).toMatchObject({ effectiveTo: '2026-08-31' });

    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Lopez' });
    const entry = async (day: string) => {
      const shift = await prisma.shift.create({ data: { clientId: client.id, locationId: site.id, position: 'Associate', startsAt: new Date(`${day}T13:00:00.000Z`), endsAt: new Date(`${day}T17:00:00.000Z`), status: 'COMPLETED', assignedAssociateId: ana.id } });
      return prisma.timeEntry.create({ data: { associateId: ana.id, clientId: client.id, locationId: site.id, shiftId: shift.id, clockInAt: new Date(`${day}T13:00:00.000Z`), clockOutAt: new Date(`${day}T17:00:00.000Z`), status: 'APPROVED' } });
    };
    await entry('2026-08-10');
    await entry('2026-09-10');
    // August's statement bills at $20; September's at $25.
    const aug = await computeStatementSnapshot(prisma, client.id, new Date('2026-08-01T00:00:00.000Z'), new Date('2026-09-01T00:00:00.000Z'));
    const sep = await computeStatementSnapshot(prisma, client.id, new Date('2026-09-01T00:00:00.000Z'), new Date('2026-10-01T00:00:00.000Z'));
    expect(aug.totals.amount).toBe(80);
    expect(sep.totals.amount).toBe(100);
  });

  it('flags every placed associate whose role has no card at their client, and the Headcount overview counts them', async () => {
    const coastal = await createClient('Coastal Resort');
    const siteA = await prisma.site.findFirstOrThrow({ where: { clientId: coastal.id } });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    await setRateCard(prisma, { clientId: coastal.id, position: 'Associate', payRate: 15, billRate: 21, effectiveFrom: '2026-01-01' }, hr.id);
    const mk = async (first: string, position: string | null) => {
      const x = await createAssociate({ firstName: first, lastName: 'Test' });
      await prisma.associateAssignment.create({ data: { associateId: x.id, locationId: siteA.id, startedAt: new Date('2026-05-01') } });
      await prisma.application.create({ data: { associateId: x.id, clientId: coastal.id, onboardingTrack: 'STANDARD', status: 'APPROVED', approvedAt: new Date('2026-05-01'), position } });
      return x;
    };
    const covered = await mk('Ana', 'Associate');
    const lead = await mk('Bo', 'Lead');
    const noRole = await mk('Cy', null);
    // The overview lists a client by its active people; Ana punched yesterday.
    await prisma.timeEntry.create({ data: { associateId: covered.id, clientId: coastal.id, locationId: siteA.id, clockInAt: new Date(Date.now() - 26 * 3_600_000), clockOutAt: new Date(Date.now() - 18 * 3_600_000), status: 'APPROVED' } });
    const flagged = await associatesWithoutRate(prisma, new Date('2026-10-14T12:00:00.000Z'));
    expect(flagged.map((f) => f.associateId).sort()).toEqual([lead.id, noRole.id].sort());
    expect(flagged.find((f) => f.associateId === lead.id)).toMatchObject({ position: 'Lead', clientName: 'Coastal Resort', locationId: siteA.id });
    expect(flagged.some((f) => f.associateId === covered.id)).toBe(false);

    const a = await loginAs(agent(), hr.email);
    const list = await a.get('/headcount/without-rate');
    expect(list.body.associates).toHaveLength(2);
    const overview = await a.get('/headcount/overview');
    expect(overview.body.byClient[0]).toMatchObject({ id: coastal.id, withoutRate: 2 });
  });
});
