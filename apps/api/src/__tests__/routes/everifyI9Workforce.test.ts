import { afterAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { orgDateKey } from '../../lib/timeAnomalies.js';
import { addDaysToKey } from '../../lib/timezone.js';
import { eVerifyDueBy, section2DueBy } from '../../lib/hiringCompliance.js';

/**
 * The E-Verify and I-9 lists open on the CURRENT workforce (owner,
 * 2026-11-03). In production 693 people were on file and 155 still worked
 * here; the lists, their counts and their exports were ~70% people who had
 * left, silent caps hid the rest, and the real gaps (hires with no case,
 * Section 2s past day 3, expired work authorizations) were lost inside.
 * What these tests hold:
 *   - each list's group (?workforce=, default current), its chip counts
 *     and each row's status; no silent cap;
 *   - E-Verify: overdue only when no case is on file, the due day skips
 *     weekends and federal holidays, a rehire needs a new case, and a case
 *     left open by someone who left is counted;
 *   - I-9: re-verification only for an alien authorized to work who still
 *     works here; Supplement B moves workAuthExpiresAt; retention runs from
 *     the last day worked; the examined date and the reason to untick;
 *   - every by-id route answers only inside the caller's reach;
 *   - each Inbox count equals the view its link opens.
 */

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

const DAY = 86_400_000;
const day = (key: string) => new Date(`${key}T00:00:00.000Z`);
const today = () => orgDateKey(new Date());

async function hr() {
  const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
  return loginAs(agent(), user.email);
}

/** Hired: an approved application (placed through it). Optionally paused, or gone. */
async function hired(name: string, clientId: string, opts: { paused?: boolean; leftAt?: Date } = {}) {
  const a = await createAssociate({ firstName: name, lastName: 'Person' });
  await prisma.application.create({ data: { associateId: a.id, clientId, onboardingTrack: 'STANDARD', status: 'APPROVED', approvedAt: new Date() } });
  if (opts.paused) await prisma.associate.update({ where: { id: a.id }, data: { deactivatedAt: new Date() } });
  if (opts.leftAt) await prisma.associate.update({ where: { id: a.id }, data: { separatedAt: opts.leftAt } });
  return a;
}

/** Onboarding, not hired: a draft application ("Starting soon"). */
async function starting(name: string, clientId: string) {
  const a = await createAssociate({ firstName: name, lastName: 'Person' });
  await prisma.application.create({ data: { associateId: a.id, clientId, onboardingTrack: 'STANDARD', status: 'DRAFT' } });
  return a;
}

type Row = { associateId: string; [k: string]: unknown };
const byId = (rows: Row[]) => new Map(rows.map((r) => [r.associateId, r]));

describe('E-Verify — who the list is about', () => {
  it('opens on the current workforce; the chips count every group; a case left open by someone who left is counted', async () => {
    const c = await createClient();
    const cora = await hired('Cora', c.id);
    await starting('Sam', c.id);
    await hired('Pat', c.id, { paused: true });
    const gil = await hired('Gil', c.id, { leftAt: new Date(Date.now() - 30 * DAY) });
    await prisma.i9Verification.create({
      data: { associateId: gil.id, eVerifyCaseNumber: '2026-OPEN-1', eVerifyStatus: 'PENDING', eVerifyCaseOpenedAt: new Date(Date.now() - 40 * DAY) },
    });

    const a = await hr();
    const res = await a.get('/compliance/everify');
    expect(res.status).toBe(200);
    expect(res.body.workforce).toBe('current');
    expect(res.body.rows.map((r: Row) => r.associateId)).toEqual([cora.id]);
    expect(res.body.rows[0].workStatus).toBe('PLACED_NOT_ACTIVE');
    expect(res.body.workforceCounts).toEqual({ current: 1, starting: 1, paused: 1, former: 1, all: 4 });
    // Whatever the group, the cases people who left still hold open.
    expect(res.body.formerOpenCases).toBe(1);
    expect(res.body.counts.total).toBe(1);

    const former = await a.get('/compliance/everify?workforce=former');
    expect(former.body.rows.map((r: Row) => r.associateId)).toEqual([gil.id]);
    expect(former.body.rows[0]).toMatchObject({ caseOpen: true, workStatus: 'SEPARATED', status: 'PENDING' });
    expect(former.body.rows[0].leftOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // Anything else reads as the default.
    const odd = await a.get('/compliance/everify?workforce=everyone');
    expect(odd.body.workforce).toBe('current');
  });

  it('no silent cap: 520 hires are all listed', async () => {
    const c = await createClient();
    const tag = Math.random().toString(36).slice(2, 7);
    await prisma.associate.createMany({
      data: Array.from({ length: 520 }, (_, i) => ({ firstName: `P${i}`, lastName: `Bulk${String(i).padStart(3, '0')}`, email: `bulk-${tag}-${i}@example.com` })),
    });
    const people = await prisma.associate.findMany({ where: { email: { startsWith: `bulk-${tag}-` } }, select: { id: true } });
    await prisma.application.createMany({
      data: people.map((p) => ({ associateId: p.id, clientId: c.id, onboardingTrack: 'STANDARD' as const, status: 'APPROVED' as const, approvedAt: new Date() })),
    });
    const a = await hr();
    const res = await a.get('/compliance/everify');
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(520);
    expect(res.body.truncated).toBe(false);
    expect(res.body.counts.total).toBe(520);
  });
});

describe('E-Verify — deadlines and the overdue rule', () => {
  it('the due day is the 3rd business day after the first day, skipping weekends and federal holidays', () => {
    // Thanksgiving (Thu Nov 26, 2026) is skipped: Fri, Mon, Tue.
    expect(section2DueBy('2026-11-25')!.toISOString().slice(0, 10)).toBe('2026-12-01');
    // Labor Day (Mon Sep 7, 2026) is after the third day: Wed, Thu, Fri.
    expect(section2DueBy('2026-09-01')!.toISOString().slice(0, 10)).toBe('2026-09-04');
    // A stored provider deadline wins — unless it belongs to an earlier employment.
    expect(eVerifyDueBy('2026-09-01', day('2026-09-08'))!.toISOString().slice(0, 10)).toBe('2026-09-08');
    expect(eVerifyDueBy('2026-09-01', day('2025-01-09'))!.toISOString().slice(0, 10)).toBe('2026-09-04');
  });

  it('overdue only when no case is on file, and only after the due day', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-06-09T16:00:00.000Z') });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const c = await createClient();
    const due = await hired('Dee', c.id);
    const late = await hired('Lou', c.id);
    const authorized = await hired('Ava', c.id);
    await prisma.associate.update({ where: { id: due.id }, data: { hireDate: day('2026-06-04') } });
    await prisma.associate.update({ where: { id: late.id }, data: { hireDate: day('2026-05-01') } });
    await prisma.associate.update({ where: { id: authorized.id }, data: { hireDate: day('2026-05-01') } });
    // An Authorized case recorded by hand, with no opened date: never "Overdue".
    await prisma.i9Verification.create({ data: { associateId: authorized.id, eVerifyCaseNumber: '2026-AUTH', eVerifyStatus: 'EMPLOYMENT_AUTHORIZED' } });

    const a = await hr();
    const rows = byId((await a.get('/compliance/everify')).body.rows);
    // Thursday Jun 4 + 3 business days = Tuesday Jun 9: due today, not late yet.
    expect(rows.get(due.id)).toMatchObject({ dueBy: '2026-06-09', overdue: false });
    expect(rows.get(late.id)).toMatchObject({ overdue: true });
    expect(rows.get(authorized.id)).toMatchObject({ status: 'EMPLOYMENT_AUTHORIZED', overdue: false });

    // A day later (signed in afresh: the session's idle clock moved too).
    vi.setSystemTime(new Date('2026-06-10T16:00:00.000Z'));
    const b = await hr();
    const next = byId((await b.get('/compliance/everify')).body.rows);
    expect(next.get(due.id)).toMatchObject({ overdue: true });
  });

  it('a rehire whose case was opened in an earlier employment needs a new case; opening it starts clean', async () => {
    const c = await createClient();
    const employer = await prisma.employerOrganization.create({ data: { kind: 'THIRD_PARTY', legalName: 'Coastal EOR' } });
    const rae = await hired('Rae', c.id);
    await prisma.associate.update({ where: { id: rae.id }, data: { hireDate: day('2025-01-06'), dob: day('1990-01-01') } });
    await prisma.employment.create({ data: { associateId: rae.id, employerOrgId: employer.id, hireDate: day('2025-01-06'), endDate: day('2025-06-30') } });
    await prisma.employment.create({ data: { associateId: rae.id, employerOrgId: employer.id, hireDate: day('2026-09-01') } });
    await prisma.i9Verification.create({
      data: {
        associateId: rae.id,
        eVerifyCaseNumber: '2025-OLD',
        eVerifyStatus: 'EMPLOYMENT_AUTHORIZED',
        eVerifyCaseOpenedAt: new Date('2025-01-08T15:00:00.000Z'),
        eVerifyClosedAt: new Date('2025-01-09T15:00:00.000Z'),
        eVerifyClosureReason: 'EMPLOYEE_CONTINUES_TO_WORK',
      },
    });
    // A first hire whose case was opened two days before the start is theirs.
    const fay = await hired('Fay', c.id);
    await prisma.employment.create({ data: { associateId: fay.id, employerOrgId: employer.id, hireDate: day('2026-09-10') } });
    await prisma.i9Verification.create({
      data: { associateId: fay.id, eVerifyCaseNumber: '2026-FAY', eVerifyStatus: 'EMPLOYMENT_AUTHORIZED', eVerifyCaseOpenedAt: new Date('2026-09-08T15:00:00.000Z') },
    });

    const a = await hr();
    const res = await a.get('/compliance/everify');
    const rows = byId(res.body.rows);
    expect(rows.get(rae.id)).toMatchObject({
      status: null,
      caseNumber: null,
      closureReason: null,
      needsNewCase: true,
      hireDate: '2026-09-01',
      // Tue Sep 1 → Wed, Thu, Fri.
      dueBy: '2026-09-04',
      previousCase: { caseNumber: '2025-OLD', status: 'EMPLOYMENT_AUTHORIZED' },
    });
    expect(rows.get(fay.id)).toMatchObject({ status: 'EMPLOYMENT_AUTHORIZED', needsNewCase: false, previousCase: null });
    expect(res.body.counts.notRun).toBe(1);

    const detail = await a.get(`/compliance/everify/${rae.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ caseNumber: null, caseOpenedAt: null, needsNewCase: true });

    const opened = await a.post(`/compliance/everify/${rae.id}/case`).send({ caseNumber: '2026-NEW', status: 'PENDING', caseOpenedAt: new Date().toISOString() });
    expect(opened.status).toBe(200);
    const stored = await prisma.i9Verification.findUniqueOrThrow({ where: { associateId: rae.id } });
    expect(stored).toMatchObject({ eVerifyCaseNumber: '2026-NEW', eVerifyStatus: 'PENDING', eVerifyClosedAt: null, eVerifyClosureReason: null });
    const after = byId((await a.get('/compliance/everify')).body.rows).get(rae.id);
    expect(after).toMatchObject({ status: 'PENDING', needsNewCase: false, caseOpen: true, overdue: false });

    await flushPendingAudits();
    const audit = await prisma.auditLog.findFirst({ where: { action: 'compliance.everify_case_recorded', entityId: stored.id }, orderBy: { createdAt: 'desc' } });
    expect((audit!.metadata as { previousCase?: { caseNumber: string } }).previousCase?.caseNumber).toBe('2025-OLD');
  });
});

describe('I-9 — who the list is about', () => {
  it('opens on the current workforce, with chip counts and each row’s status; no silent cap', async () => {
    const c = await createClient();
    const cora = await hired('Cora', c.id);
    const pat = await hired('Pat', c.id, { paused: true });
    const gil = await hired('Gil', c.id, { leftAt: new Date(Date.now() - 30 * DAY) });
    const sam = await starting('Sam', c.id);
    for (const p of [cora, pat, gil, sam]) await prisma.i9Verification.create({ data: { associateId: p.id, section1CompletedAt: new Date() } });

    const a = await hr();
    const res = await a.get('/compliance/i9');
    expect(res.status).toBe(200);
    expect(res.body.workforce).toBe('current');
    expect(res.body.i9s.map((r: Row) => r.associateId)).toEqual([cora.id]);
    expect(res.body.i9s[0].workStatus).toBe('PLACED_NOT_ACTIVE');
    expect(res.body.workforceCounts).toEqual({ current: 1, starting: 1, paused: 1, former: 1, all: 4 });
    const paused = await a.get('/compliance/i9?workforce=paused');
    expect(paused.body.i9s.map((r: Row) => r.associateId)).toEqual([pat.id]);
    const former = await a.get('/compliance/i9?workforce=former');
    expect(former.body.i9s[0]).toMatchObject({ associateId: gil.id, workStatus: 'SEPARATED' });

    // 1,005 records: the old list stopped at 1,000 without a word on the tab.
    const tag = Math.random().toString(36).slice(2, 7);
    await prisma.associate.createMany({
      data: Array.from({ length: 1005 }, (_, i) => ({ firstName: `P${i}`, lastName: 'Bulk', email: `i9bulk-${tag}-${i}@example.com` })),
    });
    const bulk = await prisma.associate.findMany({ where: { email: { startsWith: `i9bulk-${tag}-` } }, select: { id: true } });
    await prisma.i9Verification.createMany({ data: bulk.map((p) => ({ associateId: p.id })) });
    const big = await a.get('/compliance/i9?workforce=all');
    expect(big.body.i9s).toHaveLength(1009);
    expect(big.body.truncated).toBe(false);
  });

  it('re-verification is only for an alien authorized to work who still works here', async () => {
    const c = await createClient();
    const soon = day(addDaysToKey(today(), 10));
    const alien = await hired('Ana', c.id);
    const lpr = await hired('Leo', c.id);
    const paused = await hired('Pia', c.id, { paused: true });
    const gone = await hired('Gus', c.id, { leftAt: new Date(Date.now() - 5 * DAY) });
    const far = await hired('Fen', c.id);
    const auth = (associateId: string, citizenshipStatus: 'ALIEN_AUTHORIZED_TO_WORK' | 'LAWFUL_PERMANENT_RESIDENT', workAuthExpiresAt: Date) =>
      prisma.i9Verification.create({ data: { associateId, citizenshipStatus, workAuthExpiresAt } });
    await auth(alien.id, 'ALIEN_AUTHORIZED_TO_WORK', soon);
    // A green card's expiry is not a re-verification trigger.
    await auth(lpr.id, 'LAWFUL_PERMANENT_RESIDENT', soon);
    await auth(paused.id, 'ALIEN_AUTHORIZED_TO_WORK', soon);
    await auth(gone.id, 'ALIEN_AUTHORIZED_TO_WORK', soon);
    await auth(far.id, 'ALIEN_AUTHORIZED_TO_WORK', day(addDaysToKey(today(), 200)));

    const a = await hr();
    const rows = byId((await a.get('/compliance/i9?workforce=all')).body.i9s);
    expect(rows.get(alien.id)).toMatchObject({ reverifyDue: true, citizenshipStatus: 'ALIEN_AUTHORIZED_TO_WORK' });
    expect(rows.get(lpr.id)).toMatchObject({ reverifyDue: false, reverifyDueAt: null });
    expect(rows.get(paused.id)).toMatchObject({ reverifyDue: true });
    expect(rows.get(gone.id)).toMatchObject({ reverifyDue: false });
    expect(rows.get(far.id)).toMatchObject({ reverifyDue: false });

    const due = await a.get('/compliance/i9?status=reverification');
    expect(due.body.i9s.map((r: Row) => r.associateId)).toEqual([alien.id]);
    const dueAll = await a.get('/compliance/i9?status=reverification&workforce=all');
    expect(dueAll.body.i9s.map((r: Row) => r.associateId).sort()).toEqual([alien.id, paused.id].sort());

    // The Inbox counts the current workforce, the view its link opens.
    const inbox = await a.get('/me/inbox');
    const src = inbox.body.sources.find((s: { key: string }) => s.key === 'i9-reverification');
    const current = (await a.get('/compliance/i9?workforce=current')).body.i9s as Array<{ reverifyDue?: boolean }>;
    expect(src).toMatchObject({ count: 1, path: '/compliance?tab=i9&status=work_auth&workforce=current' });
    expect(current.filter((r) => r.reverifyDue)).toHaveLength(src.count);
  });

  it('Supplement B: the record and the new authorization end land together; the number is never sent whole', async () => {
    const c = await createClient();
    const ana = await hired('Ana', c.id);
    const old = day(addDaysToKey(today(), 10));
    await prisma.i9Verification.create({ data: { associateId: ana.id, citizenshipStatus: 'ALIEN_AUTHORIZED_TO_WORK', workAuthExpiresAt: old } });
    const leo = await hired('Leo', c.id);
    await prisma.i9Verification.create({ data: { associateId: leo.id, citizenshipStatus: 'LAWFUL_PERMANENT_RESIDENT', workAuthExpiresAt: old } });

    const a = await hr();
    const res = await a.post(`/compliance/i9/${ana.id}/reverification`).send({
      documentTitle: 'Employment Authorization Document (Form I-766)',
      documentNumber: 'SRC1234567890',
      issuingAuthority: 'USCIS',
      newExpiresAt: '2028-03-31',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ documentNumberLast4: '7890', newExpiresAt: '2028-03-31', previousExpiresAt: old.toISOString().slice(0, 10), reviewedOn: today() });
    expect(JSON.stringify(res.body)).not.toContain('SRC1234567890');

    const i9 = await prisma.i9Verification.findUniqueOrThrow({ where: { associateId: ana.id } });
    expect(i9.workAuthExpiresAt?.toISOString().slice(0, 10)).toBe('2028-03-31');
    const rec = await prisma.i9Reverification.findFirstOrThrow({ where: { associateId: ana.id } });
    expect(Buffer.from(rec.documentNumberEnc!).toString('utf8')).not.toContain('SRC1234567890');

    const row = byId((await a.get('/compliance/i9')).body.i9s).get(ana.id);
    expect(row).toMatchObject({ reverifyDue: false, workAuthExpiresAt: '2028-03-31' });
    const history = await a.get(`/compliance/i9/${ana.id}/reverifications`);
    expect(history.body.reverifications).toHaveLength(1);
    expect(history.body.reverifications[0]).toMatchObject({ documentTitle: 'Employment Authorization Document (Form I-766)', documentNumberLast4: '7890' });
    expect(history.body.reverifications[0].reviewedByEmail).toMatch(/@example\.com$/);

    await flushPendingAudits();
    expect(await prisma.auditLog.count({ where: { action: 'compliance.i9_reverified', entityId: i9.id } })).toBe(1);

    // Never for a permanent resident; never examined tomorrow.
    const lprRes = await a.post(`/compliance/i9/${leo.id}/reverification`).send({ documentTitle: 'Permanent Resident Card', documentNumber: 'IOE0000000001', newExpiresAt: '2036-01-01' });
    expect(lprRes.status).toBe(409);
    expect(lprRes.body.error.code).toBe('not_reverifiable');
    const tomorrow = await a.post(`/compliance/i9/${ana.id}/reverification`).send({ documentTitle: 'EAD', documentNumber: 'SRC999', newExpiresAt: null, reviewedOn: addDaysToKey(today(), 1) });
    expect(tomorrow.status).toBe(400);
    // A document that never expires clears the end date.
    const forever = await a.post(`/compliance/i9/${ana.id}/reverification`).send({ documentTitle: 'Unrestricted Social Security card', documentNumber: '123-45-6789', newExpiresAt: null });
    expect(forever.status).toBe(201);
    expect((await prisma.i9Verification.findUniqueOrThrow({ where: { associateId: ana.id } })).workAuthExpiresAt).toBeNull();
  });

  it('retention runs from the last day worked; the Inbox counts the Former view’s past-retention rows', async () => {
    const c = await createClient();
    // Last day worked 2024-06-01, recorded as separated much later.
    const old = await hired('Ola', c.id, { leftAt: new Date('2026-01-15T17:00:00.000Z') });
    await prisma.associate.update({ where: { id: old.id }, data: { hireDate: day('2021-01-04') } });
    await prisma.separation.create({ data: { associateId: old.id, reason: 'VOLUNTARY_PERSONAL', status: 'COMPLETE', lastDayWorked: day('2024-06-01'), completedAt: new Date('2026-01-15T17:00:00.000Z') } });
    await prisma.i9Verification.create({ data: { associateId: old.id } });
    // Left a month ago: a year from now.
    const recent = await hired('Rex', c.id, { leftAt: new Date(Date.now() - 30 * DAY) });
    await prisma.associate.update({ where: { id: recent.id }, data: { hireDate: day('2021-01-04') } });
    await prisma.i9Verification.create({ data: { associateId: recent.id } });

    const a = await hr();
    const former = byId((await a.get('/compliance/i9?workforce=former')).body.i9s);
    expect(former.get(old.id)).toMatchObject({ retainUntil: '2025-06-01', leftOn: '2024-06-01' });
    expect(String(former.get(recent.id)!.retainUntil) > today()).toBe(true);

    const past = await a.get('/compliance/i9?status=retention');
    expect(past.body.workforce).toBe('former');
    expect(past.body.i9s.map((r: Row) => r.associateId)).toEqual([old.id]);

    const inbox = await a.get('/me/inbox');
    const src = inbox.body.sources.find((s: { key: string }) => s.key === 'i9-retention');
    expect(src).toMatchObject({ count: 1, path: '/compliance?tab=i9&status=retention&workforce=former' });
  });

  it('Section 2 by hand: the examined date is today or earlier and not before the first day; unticking needs a reason', async () => {
    const c = await createClient();
    const mia = await hired('Mia', c.id);
    await prisma.associate.update({ where: { id: mia.id }, data: { hireDate: day('2026-01-05') } });
    const a = await hr();
    const tick = (extra: Record<string, unknown>) =>
      a.post(`/compliance/i9/${mia.id}`).send({ section1CompletedAt: new Date().toISOString(), section2CompletedAt: new Date().toISOString(), documentList: 'LIST_A', ...extra });

    const future = await tick({ section2ExaminedOn: addDaysToKey(today(), 1) });
    expect(future.status).toBe(400);
    expect(future.body.error.code).toBe('examined_in_future');
    const early = await tick({ section2ExaminedOn: '2026-01-04' });
    expect(early.status).toBe(400);
    expect(early.body.error.code).toBe('examined_before_hire');
    const ok = await tick({});
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ section2ExaminedOn: today(), hireDate: '2026-01-05' });

    const silent = await a.post(`/compliance/i9/${mia.id}`).send({ section2CompletedAt: null });
    expect(silent.status).toBe(400);
    expect(silent.body.error.code).toBe('reason_required');
    const cleared = await a.post(`/compliance/i9/${mia.id}`).send({ section2CompletedAt: null, reason: 'Ticked on the wrong person' });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ section2CompletedAt: null, section2ExaminedOn: null });

    await flushPendingAudits();
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'compliance.i9_section2_cleared', entityId: cleared.body.id } });
    expect(audit.metadata).toMatchObject({ reason: 'Ticked on the wrong person', previousSection2ExaminedOn: today() });
  });
});

describe('Reach on the by-id routes', () => {
  it('another store’s person is a 404 on every E-Verify and I-9 route; one who left from my store is still mine', async () => {
    const north = await createClient('North Co');
    const south = await createClient('South Co');
    const n = await prisma.site.findFirstOrThrow({ where: { clientId: north.id } });
    const s = await prisma.site.findFirstOrThrow({ where: { clientId: south.id } });
    const nia = await hired('Nia', north.id);
    const sam = await hired('Sam', south.id);
    const gil = await hired('Gil', north.id, { leftAt: new Date(Date.now() - 10 * DAY) });
    const assign = (associateId: string, locationId: string, endedAt: Date | null = null) =>
      prisma.associateAssignment.create({ data: { associateId, locationId, startedAt: new Date('2026-01-01'), endedAt } });
    await assign(nia.id, n.id);
    await assign(sam.id, s.id);
    await assign(gil.id, n.id, new Date(Date.now() - 10 * DAY));
    for (const p of [nia, sam, gil]) await prisma.i9Verification.create({ data: { associateId: p.id, citizenshipStatus: 'ALIEN_AUTHORIZED_TO_WORK', workAuthExpiresAt: day(addDaysToKey(today(), 10)) } });

    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    await prisma.user.update({ where: { id: user.id }, data: { scopeSiteIds: [n.id] } });
    const a = await loginAs(agent(), user.email);

    const reverify = { documentTitle: 'EAD', documentNumber: 'SRC1234', newExpiresAt: '2028-01-01' };
    expect((await a.post(`/compliance/i9/${sam.id}`).send({ section1CompletedAt: new Date().toISOString() })).status).toBe(404);
    expect((await a.post(`/compliance/i9/${sam.id}/reverification`).send(reverify)).status).toBe(404);
    expect((await a.get(`/compliance/i9/${sam.id}/reverifications`)).status).toBe(404);
    expect((await a.get(`/compliance/everify/${sam.id}`)).status).toBe(404);
    expect((await a.post(`/compliance/everify/${sam.id}/case`).send({ caseNumber: 'X-1', status: 'PENDING' })).status).toBe(404);
    expect((await a.patch(`/compliance/everify/${sam.id}/identity`).send({ middleInitial: 'Q' })).status).toBe(404);
    // Nothing was written to the out-of-reach person.
    expect((await prisma.i9Verification.findUniqueOrThrow({ where: { associateId: sam.id } })).eVerifyCaseNumber).toBeNull();
    expect(await prisma.i9Reverification.count({ where: { associateId: sam.id } })).toBe(0);

    // My own store's people work — so the 404s above are reach, not a broken route.
    expect((await a.post(`/compliance/i9/${nia.id}`).send({ section1CompletedAt: new Date().toISOString() })).status).toBe(200);
    expect((await a.post(`/compliance/i9/${nia.id}/reverification`).send(reverify)).status).toBe(201);
    expect((await a.get(`/compliance/everify/${nia.id}`)).status).toBe(200);
    // Someone who left from my store: on the Former list and openable.
    expect((await a.get(`/compliance/everify/${gil.id}`)).status).toBe(200);
    const former = await a.get('/compliance/i9?workforce=former');
    expect(former.body.i9s.map((r: Row) => r.associateId)).toEqual([gil.id]);
    const everyone = await a.get('/compliance/i9?workforce=all');
    expect(everyone.body.i9s.map((r: Row) => r.associateId)).not.toContain(sam.id);
  });
});

describe('Inbox counts equal the views they open', () => {
  it('E-Verify cases to open and Section 2 to complete count the current workforce’s rows', async () => {
    const c = await createClient();
    const ready = await hired('Rae', c.id);
    await prisma.i9Verification.create({ data: { associateId: ready.id, section1CompletedAt: new Date(), section2CompletedAt: new Date(), documentList: 'LIST_A' } });
    const opened = await hired('Opa', c.id);
    await prisma.i9Verification.create({ data: { associateId: opened.id, eVerifyCaseNumber: 'C-1', eVerifyStatus: 'PENDING', eVerifyCaseOpenedAt: new Date() } });
    const toVerify = await hired('Tov', c.id);
    await prisma.i9Verification.create({ data: { associateId: toVerify.id, section1CompletedAt: new Date(), documentsSubmittedAt: new Date() } });
    // Not the current workforce: left, or not hired yet.
    const gone = await hired('Gon', c.id, { leftAt: new Date(Date.now() - 3 * DAY) });
    await prisma.i9Verification.create({ data: { associateId: gone.id, section1CompletedAt: new Date(), documentsSubmittedAt: new Date() } });
    const fresh = await starting('Fre', c.id);
    await prisma.i9Verification.create({ data: { associateId: fresh.id, section1CompletedAt: new Date(), documentsSubmittedAt: new Date() } });

    const a = await hr();
    const sources = (await a.get('/me/inbox')).body.sources as Array<{ key: string; count: number; path: string }>;
    const src = (k: string) => sources.find((s) => s.key === k)!;

    const everify = src('everify');
    expect(everify.path).toBe('/compliance?tab=everify&status=not_run&workforce=current');
    const roster = (await a.get('/compliance/everify?workforce=current')).body.rows as Array<{ status: string | null }>;
    expect(everify.count).toBe(roster.filter((r) => r.status === null).length);
    expect(everify.count).toBe(2);

    const section2 = src('i9-section2');
    expect(section2.path).toBe('/compliance?tab=i9&status=ready&workforce=current');
    const i9s = (await a.get('/compliance/i9?workforce=current')).body.i9s as Array<{ documentsSubmittedAt?: string | null; section2CompletedAt: string | null }>;
    expect(section2.count).toBe(i9s.filter((r) => r.documentsSubmittedAt && !r.section2CompletedAt).length);
    expect(section2.count).toBe(1);
  });
});
