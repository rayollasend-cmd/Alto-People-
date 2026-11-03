import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { orgDateKey } from '../../lib/timeAnomalies.js';
import { addDaysToKey } from '../../lib/timezone.js';
import { workAuthorizationFor } from '../../lib/workAuthorization.js';

/**
 * Owner, 2026-11-03 — three I-9 follow-ups:
 *   - NEEDS REVIEW: an older I-9 with a work-authorization end date and no
 *     Section 1 citizenship status, for someone still employed. A chip and
 *     tile on the I-9 tab, an Inbox row (the view it opens), and a warning —
 *     never a block — on the Cleared to work tab.
 *   - REHIRE on Supplement B: within 3 years of the original I-9 it is
 *     reused, and a rehire whose earlier case ended Employment Authorized
 *     needs no new E-Verify case — on the E-Verify tab, in the Inbox and on
 *     the Cleared tab alike. Past 3 years: a new I-9.
 *   - DESTROY an I-9 past retention: only then, only for someone who left,
 *     with a typed confirmation; the I-9, its Supplement B entries and its
 *     document copies go, the person and everything else stay; a permanent
 *     audit row without personal data.
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

async function hired(name: string, clientId: string, opts: { paused?: boolean; leftAt?: Date } = {}) {
  const a = await createAssociate({ firstName: name, lastName: 'Person' });
  await prisma.application.create({ data: { associateId: a.id, clientId, onboardingTrack: 'STANDARD', status: 'APPROVED', approvedAt: new Date() } });
  if (opts.paused) await prisma.associate.update({ where: { id: a.id }, data: { deactivatedAt: new Date() } });
  if (opts.leftAt) await prisma.associate.update({ where: { id: a.id }, data: { separatedAt: opts.leftAt } });
  return a;
}

type Row = { associateId: string; [k: string]: unknown };
const byId = (rows: Row[]) => new Map(rows.map((r) => [r.associateId, r]));
const source = async (a: Awaited<ReturnType<typeof hr>>, key: string) =>
  ((await a.get('/me/inbox')).body.sources as Array<{ key: string; count: number; path: string }>).find((s) => s.key === key);

describe('I-9 needs review: an end date and no citizenship status', () => {
  it('flags current and paused people, counts them in the Inbox as the view it opens, and only warns on the Cleared tab', async () => {
    const c = await createClient();
    const soon = day(addDaysToKey(today(), 40));
    const old = await hired('Ola', c.id);
    const paused = await hired('Pia', c.id, { paused: true });
    const gone = await hired('Gus', c.id, { leftAt: new Date(Date.now() - 5 * DAY) });
    const lpr = await hired('Leo', c.id);
    for (const p of [old, paused, gone]) await prisma.i9Verification.create({ data: { associateId: p.id, workAuthExpiresAt: soon } });
    await prisma.i9Verification.create({ data: { associateId: lpr.id, citizenshipStatus: 'LAWFUL_PERMANENT_RESIDENT', workAuthExpiresAt: soon } });

    const a = await hr();
    const all = byId((await a.get('/compliance/i9?workforce=all')).body.i9s);
    expect(all.get(old.id)).toMatchObject({ needsReview: true, reverifyDue: false });
    expect(all.get(paused.id)).toMatchObject({ needsReview: true });
    expect(all.get(gone.id)).toMatchObject({ needsReview: false });
    expect(all.get(lpr.id)).toMatchObject({ needsReview: false });

    const view = await a.get('/compliance/i9?status=needs_review&workforce=current');
    expect(view.body.i9s.map((r: Row) => r.associateId)).toEqual([old.id]);
    const src = await source(a, 'i9-needs-review');
    expect(src).toMatchObject({ count: 1, path: '/compliance?tab=i9&status=needs_review&workforce=current' });
    const current = (await a.get('/compliance/i9?workforce=current')).body.i9s as Array<{ needsReview?: boolean }>;
    expect(current.filter((r) => r.needsReview)).toHaveLength(src!.count);

    // Cleared to work: "Needs review", a warning, never a block.
    const cl = (await workAuthorizationFor(prisma, [old.id], new Date())).get(old.id)!;
    expect(cl.cleared).toBe(true);
    expect(cl.cells.workAuth).toEqual({ state: 'issue', date: soon.toISOString().slice(0, 10) });
    expect(cl.warnings.map((w) => w.kind)).toContain('WORK_AUTH_NEEDS_REVIEW');
    expect(cl.warnings.find((w) => w.kind === 'WORK_AUTH_NEEDS_REVIEW')!.message).toMatch(/^Citizenship status missing — check Section 1 and the expiry date\./);

    // HR types the status from the paper Section 1: the flag clears. An
    // e-signed (or already recorded) status is never overwritten.
    const fixed = await a.post(`/compliance/i9/${old.id}`).send({ citizenshipStatus: 'US_CITIZEN' });
    expect(fixed.status).toBe(200);
    expect(byId((await a.get('/compliance/i9')).body.i9s).get(old.id)).toMatchObject({ needsReview: false, citizenshipStatus: 'US_CITIZEN' });
    const overwrite = await a.post(`/compliance/i9/${old.id}`).send({ citizenshipStatus: 'ALIEN_AUTHORIZED_TO_WORK' });
    expect(overwrite.status).toBe(409);
    expect((await source(a, 'i9-needs-review'))!.count).toBe(0);
  });
});

describe('Supplement B rehire and E-Verify', () => {
  /** Worked 2024 (case authorized then), left, rehired 2026-09-01. */
  async function rehire(name: string, earlier: { status: 'EMPLOYMENT_AUTHORIZED' | 'TENTATIVE_NONCONFIRMATION' | null; section2: string }) {
    const c = await createClient();
    const employer = await prisma.employerOrganization.create({ data: { kind: 'THIRD_PARTY', legalName: `EOR ${name}` } });
    const a = await hired(name, c.id);
    await prisma.associate.update({ where: { id: a.id }, data: { hireDate: day('2024-01-08') } });
    await prisma.employment.create({ data: { associateId: a.id, employerOrgId: employer.id, hireDate: day('2024-01-08'), endDate: day('2024-12-20') } });
    await prisma.employment.create({ data: { associateId: a.id, employerOrgId: employer.id, hireDate: day('2026-09-01') } });
    await prisma.i9Verification.create({
      data: {
        associateId: a.id,
        citizenshipStatus: 'US_CITIZEN',
        section1CompletedAt: new Date(`${earlier.section2}T15:00:00.000Z`),
        section2CompletedAt: new Date(`${earlier.section2}T15:00:00.000Z`),
        documentList: 'LIST_A',
        ...(earlier.status
          ? { eVerifyCaseNumber: `C-${name}`, eVerifyStatus: earlier.status, eVerifyCaseOpenedAt: new Date('2024-01-10T15:00:00.000Z'), eVerifyClosedAt: new Date('2024-01-11T15:00:00.000Z') }
          : {}),
      },
    });
    return a;
  }

  it('within 3 years of the original I-9: no new case — on the E-Verify tab, in the Inbox and on the Cleared tab', async () => {
    const rae = await rehire('Rae', { status: 'EMPLOYMENT_AUTHORIZED', section2: '2024-01-09' });
    const a = await hr();
    // Before the rehire is recorded: a new case is needed.
    expect(byId((await a.get('/compliance/everify')).body.rows).get(rae.id)).toMatchObject({ needsNewCase: true, status: null });
    expect((await source(a, 'everify'))!.count).toBe(1);

    const rec = await a.post(`/compliance/i9/${rae.id}/reverification`).send({ kind: 'REHIRE', rehiredOn: '2026-09-01' });
    expect(rec.status).toBe(201);
    expect(rec.body).toMatchObject({ kind: 'REHIRE', rehiredOn: '2026-09-01', documentTitle: null });

    const roster = await a.get('/compliance/everify');
    expect(byId(roster.body.rows).get(rae.id)).toMatchObject({
      needsNewCase: false,
      earlierI9Reused: true,
      status: 'EMPLOYMENT_AUTHORIZED',
      overdue: false,
    });
    expect(roster.body.counts.notRun).toBe(0);
    expect(roster.body.counts.overdue).toBe(0);
    expect((await source(a, 'everify'))!.count).toBe(0);
    const cl = (await workAuthorizationFor(prisma, [rae.id], new Date())).get(rae.id)!;
    expect(cl.cells.everify.state).toBe('done');
    expect(cl.warnings.map((w) => w.kind)).not.toContain('EVERIFY_LATE');
    // The I-9 row says the rehire.
    expect(byId((await a.get('/compliance/i9')).body.i9s).get(rae.id)).toMatchObject({ rehireOn: '2026-09-01', originalSection2On: '2024-01-09' });
  });

  it('more than 3 years since the original I-9 is refused: a new I-9', async () => {
    const old = await rehire('Ode', { status: 'EMPLOYMENT_AUTHORIZED', section2: '2023-06-01' });
    const a = await hr();
    const res = await a.post(`/compliance/i9/${old.id}/reverification`).send({ kind: 'REHIRE', rehiredOn: '2026-09-01' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'rehire_too_late', message: 'More than 3 years since the original I-9: complete a new I-9.' });
    expect(await prisma.i9Reverification.count({ where: { associateId: old.id } })).toBe(0);
  });

  it('an earlier case that never ended Employment Authorized: the rehire still needs a case, on both tabs', async () => {
    const tnc = await rehire('Tia', { status: 'TENTATIVE_NONCONFIRMATION', section2: '2024-01-09' });
    const a = await hr();
    expect((await a.post(`/compliance/i9/${tnc.id}/reverification`).send({ kind: 'REHIRE', rehiredOn: '2026-09-01' })).status).toBe(201);
    expect(byId((await a.get('/compliance/everify')).body.rows).get(tnc.id)).toMatchObject({ needsNewCase: true, earlierI9Reused: false, status: null, overdue: true });
    expect((await source(a, 'everify'))!.count).toBe(1);
    const cl = (await workAuthorizationFor(prisma, [tnc.id], new Date())).get(tnc.id)!;
    expect(cl.cells.everify.state).toBe('late');
    expect(cl.warnings.map((w) => w.kind)).toContain('EVERIFY_LATE');
  });

  it('a rehire whose authorization ended by the rehire day re-verifies on the same Supplement B', async () => {
    const c = await createClient();
    const ana = await hired('Ana', c.id);
    await prisma.i9Verification.create({
      data: { associateId: ana.id, citizenshipStatus: 'ALIEN_AUTHORIZED_TO_WORK', workAuthExpiresAt: day('2025-06-30'), section2CompletedAt: new Date('2024-02-01T15:00:00.000Z') },
    });
    const a = await hr();
    const bare = await a.post(`/compliance/i9/${ana.id}/reverification`).send({ kind: 'REHIRE', rehiredOn: '2026-09-01' });
    expect(bare.status).toBe(400);
    expect(bare.body.error.code).toBe('document_required');
    const ok = await a
      .post(`/compliance/i9/${ana.id}/reverification`)
      .send({ kind: 'REHIRE', rehiredOn: '2026-09-01', documentTitle: 'Employment Authorization Document (Form I-766)', documentNumber: 'SRC555', newExpiresAt: '2028-08-31' });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ kind: 'REHIRE', documentNumberLast4: 'C555', newExpiresAt: '2028-08-31', previousExpiresAt: '2025-06-30' });
    expect((await prisma.i9Verification.findUniqueOrThrow({ where: { associateId: ana.id } })).workAuthExpiresAt?.toISOString().slice(0, 10)).toBe('2028-08-31');
  });
});

describe('Destroy an I-9 past retention', () => {
  /** Hired 2020-01-06, last day 2022-01-15 (separation recorded): kept until 2023-01-15, the later mark. */
  async function pastRetention(name: string, clientId: string) {
    const a = await hired(name, clientId, { leftAt: new Date('2022-01-20T17:00:00.000Z') });
    await prisma.associate.update({ where: { id: a.id }, data: { hireDate: day('2020-01-06'), ssnLast4: '6789' } });
    await prisma.separation.create({ data: { associateId: a.id, reason: 'VOLUNTARY_PERSONAL', status: 'COMPLETE', lastDayWorked: day('2022-01-15'), completedAt: new Date('2022-01-20T17:00:00.000Z') } });
    const id = await prisma.documentRecord.create({ data: { associateId: a.id, kind: 'ID', filename: `${name}-passport.jpg`, mimeType: 'image/jpeg', size: 10 } });
    const i9 = await prisma.i9Verification.create({
      data: { associateId: a.id, citizenshipStatus: 'ALIEN_AUTHORIZED_TO_WORK', section2CompletedAt: new Date('2020-01-07T15:00:00.000Z'), documentList: 'LIST_A', supportingDocIds: [id.id] },
    });
    await prisma.i9Reverification.create({ data: { associateId: a.id, i9VerificationId: i9.id, documentTitle: 'EAD', documentNumberLast4: '1234', reviewedOn: day('2021-01-04') } });
    await prisma.documentRecord.create({ data: { associateId: a.id, kind: 'I9_SUPPORTING', filename: `${name}-list-c.pdf`, mimeType: 'application/pdf', size: 10 } });
    await prisma.documentRecord.create({ data: { associateId: a.id, kind: 'I9_VERIFICATION_RESULT', filename: `${name}-everify.pdf`, mimeType: 'application/pdf', size: 10 } });
    await prisma.documentRecord.create({ data: { associateId: a.id, kind: 'OTHER', filename: `${name}-other.pdf`, mimeType: 'application/pdf', size: 10 } });
    return a;
  }

  it('needs the typed word; destroys the I-9, its Supplement B and document copies — never the person; the audit row has no personal data', async () => {
    const c = await createClient();
    const pat = await pastRetention('Pat', c.id);
    const a = await hr();

    const wrong = await a.post(`/compliance/i9/${pat.id}/destroy`).send({ confirm: 'destroy please' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('confirmation_mismatch');
    expect(await prisma.i9Verification.count({ where: { associateId: pat.id } })).toBe(1);

    const res = await a.post(`/compliance/i9/${pat.id}/destroy`).send({ confirm: 'DESTROY' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ destroyed: [{ associateId: pat.id, documents: 3 }], refused: [] });
    expect(await prisma.i9Verification.count({ where: { associateId: pat.id } })).toBe(0);
    expect(await prisma.i9Reverification.count({ where: { associateId: pat.id } })).toBe(0);
    const left = await prisma.documentRecord.findMany({ where: { associateId: pat.id }, select: { kind: true } });
    expect(left.map((d) => d.kind)).toEqual(['OTHER']);
    expect(await prisma.associate.count({ where: { id: pat.id } })).toBe(1);
    expect(await prisma.separation.count({ where: { associateId: pat.id } })).toBe(1);

    await flushPendingAudits();
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'compliance.i9_destroyed', entityId: pat.id } });
    expect(audit.metadata).toMatchObject({ associateId: pat.id, retainUntil: '2023-01-15', hireDate: '2020-01-06', lastDayWorked: '2022-01-15', documentsDestroyed: 3 });
    const text = JSON.stringify(audit.metadata);
    for (const personal of ['Pat', 'Person', '6789', '1234', 'passport']) expect(text).not.toContain(personal);

    // Gone from the Former view.
    expect((await a.get('/compliance/i9?workforce=former')).body.i9s).toEqual([]);
  });

  it('refused while it must be kept, and for someone current or rehired; out of reach is a 404', async () => {
    const c = await createClient();
    const recent = await hired('Rex', c.id, { leftAt: new Date(Date.now() - 30 * DAY) });
    await prisma.associate.update({ where: { id: recent.id }, data: { hireDate: day('2020-01-06') } });
    await prisma.i9Verification.create({ data: { associateId: recent.id } });
    const cur = await hired('Cur', c.id);
    await prisma.associate.update({ where: { id: cur.id }, data: { hireDate: day('2015-01-05') } });
    await prisma.i9Verification.create({ data: { associateId: cur.id } });
    // Left years ago, now coming back: a rehire in flight.
    const back = await pastRetention('Bea', c.id);
    await prisma.application.create({ data: { associateId: back.id, clientId: c.id, onboardingTrack: 'STANDARD', status: 'DRAFT' } });

    const a = await hr();
    const keep = await a.post(`/compliance/i9/${recent.id}/destroy`).send({ confirm: 'DESTROY' });
    expect(keep.status).toBe(409);
    expect(keep.body.error.message).toMatch(/^This I-9 must be kept until /);
    expect((await a.post(`/compliance/i9/${cur.id}/destroy`).send({ confirm: 'DESTROY' })).status).toBe(409);
    expect((await a.post(`/compliance/i9/${back.id}/destroy`).send({ confirm: 'DESTROY' })).status).toBe(409);
    expect(await prisma.i9Verification.count()).toBe(3);

    // A store-bound HR account: someone who left from another store is out of reach.
    const north = await createClient('North Co');
    const n = await prisma.site.findFirstOrThrow({ where: { clientId: north.id } });
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    await prisma.user.update({ where: { id: user.id }, data: { scopeSiteIds: [n.id] } });
    const scoped = await loginAs(agent(), user.email);
    const far = await pastRetention('Fay', c.id);
    expect((await scoped.post(`/compliance/i9/${far.id}/destroy`).send({ confirm: 'DESTROY' })).status).toBe(404);
    expect(await prisma.i9Verification.count({ where: { associateId: far.id } })).toBe(1);
  });

  it('several at once: the typed count confirms; each is checked on its own', async () => {
    const c = await createClient();
    const one = await pastRetention('One', c.id);
    const two = await pastRetention('Two', c.id);
    const recent = await hired('Rex', c.id, { leftAt: new Date(Date.now() - 30 * DAY) });
    await prisma.associate.update({ where: { id: recent.id }, data: { hireDate: day('2020-01-06') } });
    await prisma.i9Verification.create({ data: { associateId: recent.id } });
    const a = await hr();
    const ids = [one.id, two.id, recent.id];

    expect((await a.post('/compliance/i9/destroy').send({ associateIds: ids, confirm: '2' })).status).toBe(400);
    const res = await a.post('/compliance/i9/destroy').send({ associateIds: ids, confirm: '3' });
    expect(res.status).toBe(200);
    expect(res.body.destroyed.map((d: { associateId: string }) => d.associateId).sort()).toEqual([one.id, two.id].sort());
    expect(res.body.refused).toEqual([{ associateId: recent.id, code: 'retention_not_over', message: expect.stringMatching(/^This I-9 must be kept until /) }]);
    expect(await prisma.i9Verification.count()).toBe(1);
    await flushPendingAudits();
    expect(await prisma.auditLog.count({ where: { action: 'compliance.i9_destroyed' } })).toBe(2);
  });
});
