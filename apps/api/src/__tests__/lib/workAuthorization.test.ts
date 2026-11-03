import { afterAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  authorizationFactsFor,
  blockedFrom,
  blockersForShift,
  daysBetweenKeys,
  notClearedFor,
  shiftDays,
  workAuthorizationFor,
} from '../../lib/workAuthorization.js';
import { createAssociate, createClient, prisma, truncateAll } from '../../../test/db.js';

/**
 * Cleared to work (owner, 2026-11-03): the one rule for "may this person
 * work on that day?" — what blocks (work authorization ended, J-1 program
 * ended, E-Verify final nonconfirmation), what only warns, and which day a
 * shift is judged on.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

// Wednesday Nov 4 2026, 11:00 in New York: the company's today is 2026-11-04.
const NOW = new Date('2026-11-04T16:00:00.000Z');
const TODAY = '2026-11-04';
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
/** An instant on that company day (timestamps read on the company's clock). */
const noon = (s: string) => new Date(`${s}T16:00:00.000Z`);

function pinClock() {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  onTestFinished(() => {
    vi.useRealTimers();
  });
}

async function alien(expires: string, citizenshipStatus: 'ALIEN_AUTHORIZED_TO_WORK' | 'US_CITIZEN' | 'LAWFUL_PERMANENT_RESIDENT' = 'ALIEN_AUTHORIZED_TO_WORK') {
  const a = await createAssociate({ firstName: 'Ana', lastName: 'Visa' });
  await prisma.i9Verification.create({ data: { associateId: a.id, citizenshipStatus, workAuthExpiresAt: day(expires), section1CompletedAt: NOW, section2CompletedAt: NOW } });
  return a;
}

describe('workAuthorizationFor: the blockers', () => {
  it('an "alien authorized to work" whose authorization ended yesterday is not cleared; on the last day they still were', async () => {
    pinClock();
    const a = await alien('2026-11-03');
    const today = (await workAuthorizationFor(prisma, [a.id], NOW)).get(a.id)!;
    expect(today.cleared).toBe(false);
    expect(today.standing).toBe('NOT_CLEARED');
    expect(today.blockers).toHaveLength(1);
    expect(today.blockers[0]).toMatchObject({ kind: 'WORK_AUTH_ENDED', endsOn: '2026-11-03', since: TODAY });
    expect(today.blockers[0]!.message).toBe("Ana Visa's work authorization ended on Nov 3, 2026. Record the re-verification on the I-9 first.");
    expect(today.blockers[0]!.fixLink).toContain(`/compliance?tab=i9&associateId=${a.id}`);
    expect(today.cells.workAuth).toEqual({ state: 'ended', date: '2026-11-03' });

    const lastDay = (await workAuthorizationFor(prisma, [a.id], new Date('2026-11-03T16:00:00.000Z'))).get(a.id)!;
    expect(lastDay.cleared).toBe(true);
  });

  it('a citizen or a permanent resident with an expiry date on file is never blocked by it', async () => {
    pinClock();
    const citizen = await alien('2026-01-01', 'US_CITIZEN');
    const lpr = await alien('2026-01-01', 'LAWFUL_PERMANENT_RESIDENT');
    const result = await workAuthorizationFor(prisma, [citizen.id, lpr.id], NOW);
    for (const id of [citizen.id, lpr.id]) {
      expect(result.get(id)!.cleared).toBe(true);
      expect(result.get(id)!.blockers).toEqual([]);
      expect(result.get(id)!.cells.workAuth.state).toBe('not_required');
    }
    expect(blockedFrom((await authorizationFactsFor(prisma, [citizen.id])).get(citizen.id)!)).toBeNull();
  });

  it('an authorization ending within 30 days warns (Needs attention), and blocks from the day after', async () => {
    pinClock();
    const a = await alien('2026-11-20');
    const c = (await workAuthorizationFor(prisma, [a.id], NOW)).get(a.id)!;
    expect(c.cleared).toBe(true);
    expect(c.standing).toBe('NEEDS_ATTENTION');
    expect(c.warnings.map((w) => w.kind)).toEqual(['WORK_AUTH_ENDING']);
    expect(c.cells.workAuth).toEqual({ state: 'ending', date: '2026-11-20' });
    const f = (await authorizationFactsFor(prisma, [a.id])).get(a.id)!;
    expect(blockedFrom(f)).toBe('2026-11-21');
    // The message says "ends" while the date is still ahead.
    expect(blockersForShift(f, { startsAt: new Date('2026-11-22T14:00:00Z'), endsAt: new Date('2026-11-22T22:00:00Z') }, NOW)[0]!.message).toContain('ends on Nov 20, 2026');
  });

  it('J-1: the program end blocks the day after it — the grace period does not allow work — and the later of the profile and an open program counts', async () => {
    pinClock();
    const ended = await createAssociate({ firstName: 'Jo', lastName: 'Ended' });
    // The profile ended Nov 1; a CLOSED program (left early) doesn't extend it; the grace period runs to Dec 1.
    await prisma.j1Profile.create({ data: { associateId: ended.id, programStartDate: day('2026-06-01'), programEndDate: day('2026-11-01'), ds2019Number: 'N1', sponsorAgency: 'Sponsor', country: 'Peru' } });
    await prisma.program.create({ data: { associateId: ended.id, type: 'J1_SWT', programStart: day('2026-06-01'), programEnd: day('2026-12-31'), closedAt: NOW, closedReason: 'left early' } });
    const extended = await createAssociate({ firstName: 'Kai', lastName: 'Extended' });
    await prisma.j1Profile.create({ data: { associateId: extended.id, programStartDate: day('2026-06-01'), programEndDate: day('2026-11-01'), ds2019Number: 'N2', sponsorAgency: 'Sponsor', country: 'Peru' } });
    await prisma.program.create({ data: { associateId: extended.id, type: 'J1_SWT', programStart: day('2026-06-01'), programEnd: day('2027-01-15'), gracePeriodDays: 30 } });

    const r = await workAuthorizationFor(prisma, [ended.id, extended.id], NOW);
    expect(r.get(ended.id)!.blockers.map((b) => b.kind)).toEqual(['J1_PROGRAM_ENDED']);
    expect(r.get(ended.id)!.blockers[0]!.message).toContain('The grace period does not allow work');
    expect(r.get(ended.id)!.cells.j1).toEqual({ state: 'ended', date: '2026-11-01' });
    expect(r.get(extended.id)!.cleared).toBe(true);
    expect(r.get(extended.id)!.cells.j1).toEqual({ state: 'ends', date: '2027-01-15' });
  });

  it('an E-Verify final nonconfirmation blocks every day', async () => {
    pinClock();
    const a = await createAssociate({ firstName: 'Fin', lastName: 'Nonconf' });
    await prisma.i9Verification.create({ data: { associateId: a.id, citizenshipStatus: 'US_CITIZEN', eVerifyStatus: 'FINAL_NONCONFIRMATION', eVerifyCaseNumber: 'C-9', section2CompletedAt: NOW } });
    const c = (await workAuthorizationFor(prisma, [a.id], NOW)).get(a.id)!;
    expect(c.blockers.map((b) => b.kind)).toEqual(['EVERIFY_FINAL_NONCONFIRMATION']);
    expect(c.blockers[0]!.since).toBeNull();
    expect(c.cells.everify.state).toBe('blocked');
  });
});

describe('the day a shift is judged on', () => {
  it('an overnight shift that starts on the last authorized day is blocked; one ending at midnight is not', async () => {
    pinClock();
    const a = await alien('2026-11-10');
    const f = (await authorizationFactsFor(prisma, [a.id])).get(a.id)!;
    // 10 PM Nov 10 → 6 AM Nov 11, New York.
    const overnight = { startsAt: new Date('2026-11-11T03:00:00Z'), endsAt: new Date('2026-11-11T11:00:00Z'), timezone: 'America/New_York' };
    expect(shiftDays(overnight)).toEqual({ first: '2026-11-10', last: '2026-11-11' });
    expect(blockersForShift(f, overnight, NOW).map((b) => b.kind)).toEqual(['WORK_AUTH_ENDED']);
    // 4 PM → midnight Nov 10: the last day it touches is Nov 10.
    const toMidnight = { startsAt: new Date('2026-11-10T21:00:00Z'), endsAt: new Date('2026-11-11T05:00:00Z'), timezone: 'America/New_York' };
    expect(shiftDays(toMidnight).last).toBe('2026-11-10');
    expect(blockersForShift(f, toMidnight, NOW)).toEqual([]);
    // The batch form agrees, and a scheduler is told to ask HR.
    const batch = await notClearedFor(prisma, [a.id], overnight, NOW);
    expect(batch.get(a.id)![0]!.message).toContain('Ask HR');
  });

  it('daysBetweenKeys counts calendar days: the last day is 0', () => {
    expect(daysBetweenKeys('2026-11-04', '2026-11-04')).toBe(0);
    expect(daysBetweenKeys('2026-11-04', '2026-11-03')).toBe(-1);
    expect(daysBetweenKeys('2026-11-04', '2026-12-04')).toBe(30);
  });
});

describe('the warnings', () => {
  it('Section 2 and the E-Verify case past the third business day; due-soon before it', async () => {
    pinClock();
    const late = await createAssociate({ firstName: 'Lee', lastName: 'Late' });
    await prisma.associate.update({ where: { id: late.id }, data: { hireDate: day('2026-10-26') } });
    const fresh = await createAssociate({ firstName: 'Fay', lastName: 'Fresh' });
    await prisma.associate.update({ where: { id: fresh.id }, data: { hireDate: day('2026-11-03') } });
    const r = await workAuthorizationFor(prisma, [late.id, fresh.id], NOW);
    const l = r.get(late.id)!;
    // Hired Mon Oct 26: the third business day is Thu Oct 29.
    expect(l.warnings.map((w) => [w.kind, w.dueBy])).toEqual([
      ['SECTION2_LATE', '2026-10-29'],
      ['EVERIFY_LATE', '2026-10-29'],
    ]);
    expect(l.cells.i9).toEqual({ state: 'late', date: '2026-10-29' });
    expect(l.standing).toBe('NEEDS_ATTENTION');
    const f = r.get(fresh.id)!;
    expect(f.warnings).toEqual([]);
    expect(f.upcoming.map((w) => [w.kind, w.dueBy])).toEqual([
      ['SECTION2_DUE', '2026-11-06'],
      ['EVERIFY_DUE', '2026-11-06'],
    ]);
    expect(f.standing).toBe('CLEARED');
  });

  it('a background check or drug test a site requires: missing, too old, or done — and nothing when none is required', async () => {
    pinClock();
    const client = await createClient('Screened Client');
    const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    await prisma.credentialRequirement.create({ data: { clientId: client.id, kind: 'BACKGROUND_CHECK', label: 'Yearly background check', maxAgeDays: 365 } });
    await prisma.credentialRequirement.create({ data: { locationId: site.id, kind: 'DRUG_TEST', label: 'Drug test every 60 days', maxAgeDays: 60 } });
    const placedAt = async (first: string) => {
      const a = await createAssociate({ firstName: first, lastName: 'Screen' });
      await prisma.i9Verification.create({ data: { associateId: a.id, citizenshipStatus: 'US_CITIZEN', section2CompletedAt: NOW, eVerifyStatus: 'EMPLOYMENT_AUTHORIZED', eVerifyCaseNumber: `C-${first}` } });
      await prisma.associateAssignment.create({ data: { associateId: a.id, locationId: site.id, startedAt: day('2026-01-05') } });
      return a;
    };
    const none = await placedAt('None');
    const old = await placedAt('Old');
    await prisma.backgroundCheck.create({ data: { associateId: old.id, provider: 'manual', status: 'PASSED', initiatedAt: noon('2025-09-01'), completedAt: noon('2025-09-10') } });
    await prisma.drugTest.create({ data: { associateId: old.id, provider: 'manual', status: 'PASSED', initiatedAt: noon('2026-10-01'), completedAt: noon('2026-10-02') } });
    const unplaced = await createAssociate({ firstName: 'Free', lastName: 'Agent' });

    const r = await workAuthorizationFor(prisma, [none.id, old.id, unplaced.id], NOW);
    expect(r.get(none.id)!.warnings.map((w) => w.kind)).toEqual(['BACKGROUND_REQUIRED', 'DRUG_TEST_REQUIRED']);
    expect(r.get(none.id)!.cells.background).toEqual({ state: 'missing', date: null });
    // Passed 2025-09-10 + 365 days = 2026-09-10, before today: too old.
    expect(r.get(old.id)!.cells.background).toEqual({ state: 'late', date: '2026-09-10' });
    // Passed 2026-10-02 + 60 = 2026-12-01: still good, and due again within 30 days.
    expect(r.get(old.id)!.cells.drugTest).toEqual({ state: 'due', date: '2026-12-01' });
    expect(r.get(old.id)!.upcoming.map((w) => w.kind)).toEqual(['DRUG_TEST_DUE']);
    expect(r.get(unplaced.id)!.cells.background).toEqual({ state: 'not_required', date: null });
    expect(r.get(unplaced.id)!.cells.drugTest).toEqual({ state: 'not_required', date: null });
  });
});
