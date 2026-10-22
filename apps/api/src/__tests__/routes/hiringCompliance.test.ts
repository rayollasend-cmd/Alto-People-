import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import {
  createApplicationWithChecklist,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';
import { hashToken } from '../../lib/inviteToken.js';
import { getBlobStore } from '../../lib/blobStore.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { buildEeoReport, i9RetainUntil, i9ReverifyDueAt, preAdverseNotice } from '../../lib/hiringCompliance.js';

/**
 * 2026-10-21 system audit, Tier 1 #14 — hiring compliance that did not
 * exist: applicant EEO self-identification (voluntary, kept apart, read only
 * in aggregate), the FCRA adverse-action flow for hand-recorded checks (the
 * report and the summary of rights, a waiting period, the final notice), and
 * I-9 retention and reverification dates with their Inbox counts.
 */

const sent = vi.hoisted(() => [] as Array<{ subject: string | null; email: string | null; attachments: string[] }>);
vi.mock('../../lib/notifications.js', async (orig) => {
  const real = await orig<typeof import('../../lib/notifications.js')>();
  return {
    ...real,
    send: async (input: Parameters<typeof real.send>[0]) => {
      sent.push({ subject: input.subject, email: input.recipient.email, attachments: (input.attachments ?? []).map((a) => a.filename) });
      return real.send(input);
    },
  };
});

beforeEach(async () => {
  await truncateAll();
  sent.length = 0;
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function hrAgent() {
  const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
  return loginAs(agent(), user.email);
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const daysFromNow = (n: number) => new Date(Date.now() + n * 86_400_000);

/* ----- I-9 retention and reverification --------------------------------- */

describe('I-9 retention and reverification', () => {
  it('keeps the I-9 until the later of 3 years from hire and 1 year from separation', () => {
    expect(ymd(i9RetainUntil(new Date('2024-01-10'), new Date('2026-06-01T15:00:00Z'))!)).toBe('2027-06-01');
    expect(ymd(i9RetainUntil(new Date('2020-01-10'), new Date('2021-01-01T09:00:00Z'))!)).toBe('2023-01-10');
    expect(ymd(i9RetainUntil(new Date('2025-03-01'), null)!)).toBe('2028-03-01');
    expect(i9RetainUntil(null, new Date())).toBeNull();
    expect(ymd(i9ReverifyDueAt(new Date('2026-12-31'))!)).toBe('2026-12-31');
    expect(i9ReverifyDueAt(null)).toBeNull();
  });

  it('lists reverification due and past-retention I-9s, and the Inbox counts them with the same predicate', async () => {
    const expiring = await createAssociate({ firstName: 'Ana', lastName: 'Expiring' });
    await prisma.associate.update({ where: { id: expiring.id }, data: { hireDate: new Date('2025-02-01') } });
    await prisma.i9Verification.create({ data: { associateId: expiring.id, workAuthExpiresAt: new Date(`${ymd(daysFromNow(30))}T00:00:00.000Z`) } });

    const later = await createAssociate({ firstName: 'Ben', lastName: 'Later' });
    await prisma.i9Verification.create({ data: { associateId: later.id, workAuthExpiresAt: new Date(`${ymd(daysFromNow(200))}T00:00:00.000Z`) } });

    const gone = await createAssociate({ firstName: 'Cora', lastName: 'Gone' });
    await prisma.associate.update({ where: { id: gone.id }, data: { hireDate: new Date('2019-05-01'), separatedAt: new Date('2022-02-01T12:00:00Z') } });
    await prisma.i9Verification.create({ data: { associateId: gone.id } });

    const recent = await createAssociate({ firstName: 'Dev', lastName: 'Recent' });
    await prisma.associate.update({ where: { id: recent.id }, data: { hireDate: new Date('2019-05-01'), separatedAt: daysFromNow(-100) } });
    await prisma.i9Verification.create({ data: { associateId: recent.id } });

    const hr = await hrAgent();
    const reverify = await hr.get('/compliance/i9?status=reverification');
    expect(reverify.status).toBe(200);
    expect(reverify.body.i9s.map((r: { associateId: string }) => r.associateId)).toEqual([expiring.id]);
    expect(reverify.body.i9s[0]).toMatchObject({ reverifyDueAt: ymd(daysFromNow(30)), retainUntil: '2028-02-01' });

    const retention = await hr.get('/compliance/i9?status=retention');
    expect(retention.body.i9s.map((r: { associateId: string }) => r.associateId)).toEqual([gone.id]);
    expect(retention.body.i9s[0].retainUntil).toBe('2023-02-01');

    const inbox = await hr.get('/me/inbox');
    const src = (k: string) => inbox.body.sources.find((s: { key: string }) => s.key === k);
    expect(src('i9-reverification')).toMatchObject({ count: 1, path: '/compliance?tab=i9&status=work_auth' });
    expect(src('i9-retention')).toMatchObject({ count: 1, path: '/compliance?tab=i9&status=retention' });
  });
});

/* ----- EEO self-identification ------------------------------------------ */

describe('applicant EEO self-identification', () => {
  async function candidateWithLink() {
    const raw = `tok-${randomUUID()}`;
    const c = await prisma.candidate.create({
      data: {
        firstName: 'Riley',
        lastName: 'Applicant',
        email: `riley-${randomUUID()}@example.com`,
        portalTokenHash: hashToken(raw),
        portalTokenExpiresAt: daysFromNow(10),
      },
    });
    return { c, raw };
  }

  it('the applicant answers on their own page; no candidate read ever carries the answers', async () => {
    const { c, raw } = await candidateWithLink();
    const anon = agent();
    const r = await anon.post(`/candidate-portal/${raw}/eeo`).send({ gender: 'FEMALE', ethnicity: 'ASIAN', veteranStatus: 'NOT_PROTECTED', disabilityStatus: 'DECLINE' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const row = await prisma.eeoSelfIdentification.findUniqueOrThrow({ where: { candidateId: c.id } });
    expect(row).toMatchObject({ gender: 'FEMALE', ethnicity: 'ASIAN', declined: false });

    const page = await anon.get(`/candidate-portal/${raw}`);
    expect(page.body.eeoAnswered).toBe(true);
    expect(JSON.stringify(page.body)).not.toMatch(/FEMALE|ASIAN/);

    const hr = await hrAgent();
    const detail = await hr.get(`/recruiting/candidates/${c.id}`);
    expect(detail.status).toBe(200);
    expect(JSON.stringify(detail.body)).not.toMatch(/FEMALE|ASIAN|ethnicity|eeo/i);

    // A whole-form decline keeps no answers.
    await anon.post(`/candidate-portal/${raw}/eeo`).send({ declined: true, gender: 'MALE' });
    const declined = await prisma.eeoSelfIdentification.findUniqueOrThrow({ where: { candidateId: c.id } });
    expect(declined).toMatchObject({ declined: true, gender: null, ethnicity: null });

    // Bad values are refused; a dead link is a 404.
    expect((await anon.post(`/candidate-portal/${raw}/eeo`).send({ gender: 'Other' })).status).toBe(400);
    expect((await anon.post('/candidate-portal/nope/eeo').send({ gender: 'MALE' })).status).toBe(404);
  });

  it('the new hire answers on their checklist; HR cannot answer for them; the application read never carries it', async () => {
    const client = await createClient();
    const a = await createAssociate({ firstName: 'Sam', lastName: 'Hire' });
    const app = await createApplicationWithChecklist({ associateId: a.id, clientId: client.id });
    const { user: me } = await createUser({ role: 'ASSOCIATE', email: a.email, associateId: a.id });
    const self = await loginAs(agent(), me.email);
    const r = await self.post(`/onboarding/applications/${app.id}/eeo-self-id`).send({ gender: 'MALE', veteranStatus: 'PROTECTED' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await prisma.eeoSelfIdentification.findUniqueOrThrow({ where: { associateId: a.id } })).toMatchObject({ gender: 'MALE', veteranStatus: 'PROTECTED' });

    const hr = await hrAgent();
    const byHr = await hr.post(`/onboarding/applications/${app.id}/eeo-self-id`).send({ gender: 'FEMALE' });
    expect(byHr.status).toBe(403);
    const detail = await hr.get(`/onboarding/applications/${app.id}`);
    expect(detail.status).toBe(200);
    expect(JSON.stringify(detail.body)).not.toMatch(/PROTECTED|veteran|eeo/i);
  });

  it('the report is counts only, small buckets read “<5”, and only the compliance desk may read it', async () => {
    const mk = async (data: { gender?: string; ethnicity?: string; declined?: boolean }) => {
      const c = await prisma.candidate.create({ data: { firstName: 'X', lastName: 'Y', email: `x-${randomUUID()}@example.com` } });
      await prisma.eeoSelfIdentification.create({ data: { candidateId: c.id, ...data } });
    };
    for (let i = 0; i < 5; i++) await mk({ gender: 'FEMALE', ethnicity: 'HISPANIC_OR_LATINO' });
    await mk({ gender: 'MALE', ethnicity: 'WHITE' });
    await mk({ declined: true });

    const hr = await hrAgent();
    const r = await hr.get('/compliance/eeo/applicant-report');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.applicants).toBe(7);
    expect(r.body.responses).toBe(6);
    expect(r.body.declined).toBe('<5');
    expect(r.body.gender).toEqual({ FEMALE: 5, MALE: '<5' });
    expect(r.body.ethnicity).toEqual({ HISPANIC_OR_LATINO: 5, WHITE: '<5' });
    expect(JSON.stringify(r.body)).not.toMatch(/candidateId|associateId|"id"/);
    await flushPendingAudits();
    const audit = await prisma.auditLog.findFirst({ where: { action: 'compliance.eeo_report_viewed' } });
    expect(audit).not.toBeNull();

    const a = await createAssociate();
    const { user } = await createUser({ role: 'ASSOCIATE', associateId: a.id });
    const assoc = await loginAs(agent(), user.email);
    expect((await assoc.get('/compliance/eeo/applicant-report')).status).toBe(403);
  });

  it('buildEeoReport never publishes a bucket under five', () => {
    const r = buildEeoReport([{ declined: false, gender: 'NONBINARY', ethnicity: null, veteranStatus: null, disabilityStatus: 'YES' }], 1, '2026-01-01', '2026-12-31');
    expect(r.gender).toEqual({ NONBINARY: '<5' });
    expect(r.responses).toBe('<5');
    expect(r.declined).toBe(0);
  });
});

/* ----- FCRA adverse action ---------------------------------------------- */

describe('FCRA adverse action for checks recorded by hand', () => {
  async function seed() {
    const a = await createAssociate({ firstName: 'Lee', lastName: 'Screened' });
    const check = await prisma.backgroundCheck.create({
      data: { associateId: a.id, provider: 'Sterling (portal)', status: 'NEEDS_REVIEW', externalId: 'ST-77' },
    });
    return { a, check };
  }
  async function fileReport(associateId: string) {
    const key = `background-reports/${randomUUID()}.pdf`;
    await getBlobStore().put(key, Buffer.from('%PDF-1.4 report'), 'application/pdf');
    await prisma.documentRecord.create({
      data: { associateId, kind: 'BACKGROUND_CHECK_RESULT', s3Key: key, filename: 'sterling-report.pdf', mimeType: 'application/pdf', size: 15 },
    });
  }

  it('the pre-adverse notice needs the report on file, carries it, and starts the waiting period', async () => {
    const { a, check } = await seed();
    const hr = await hrAgent();

    const refused = await hr.post(`/compliance/background/${check.id}/pre-adverse`).send({});
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('no_report_on_file');

    await fileReport(a.id);
    const r = await hr.post(`/compliance/background/${check.id}/pre-adverse`).send({ waitDays: 5 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ adjudication: 'PRE_ADVERSE', viaProvider: false });
    await flushPendingNotifications();
    const notice = sent.find((s) => s.subject?.startsWith('Pre-adverse action notice'));
    expect(notice).toBeDefined();
    expect(notice!.email).toBe(a.email);
    expect(notice!.attachments).toEqual(['sterling-report.pdf']);
    const row = await prisma.backgroundCheck.findUniqueOrThrow({ where: { id: check.id } });
    expect(row.adverseWaitUntil!.getTime()).toBeGreaterThan(Date.now() + 4 * 86_400_000);

    // The final notice waits out the period.
    const early = await hr.post(`/compliance/background/${check.id}/final-adverse`).send({});
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('waiting_period');

    await prisma.backgroundCheck.update({ where: { id: check.id }, data: { adverseWaitUntil: daysFromNow(-1) } });
    const fin = await hr.post(`/compliance/background/${check.id}/final-adverse`).send({});
    expect(fin.status, JSON.stringify(fin.body)).toBe(200);
    expect(fin.body).toMatchObject({ adjudication: 'ADVERSE', status: 'FAILED' });
    await flushPendingNotifications();
    expect(sent.find((s) => s.subject?.startsWith('Adverse action notice'))?.attachments).toEqual(['sterling-report.pdf']);
  });

  it('the notice carries the CFPB summary of rights', () => {
    const n = preAdverseNotice({ personName: 'Lee', orgName: 'Alto', providerName: 'Sterling', reportFileName: 'r.pdf', waitUntil: new Date('2026-11-01'), contactEmail: 'hr@example.com' });
    expect(n.text).toContain('A Summary of Your Rights Under the Fair Credit Reporting Act');
    expect(n.text).toContain('Consumer Financial Protection Bureau');
    expect(n.text).toContain('2026-11-01');
    expect(n.html).toContain('<ol>');
  });

  it('a provider-ordered check is sent to the provider flow; withdraw clears a pending one', async () => {
    const a = await createAssociate();
    const viaCheckr = await prisma.backgroundCheck.create({
      data: { associateId: a.id, provider: 'CHECKR', status: 'NEEDS_REVIEW', externalId: 'inv_1', connectionId: randomUUID(), result: 'consider' },
    });
    const hr = await hrAgent();
    const r = await hr.post(`/compliance/background/${viaCheckr.id}/pre-adverse`).send({});
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('use_provider_flow');

    const { check } = await seed();
    await prisma.backgroundCheck.update({ where: { id: check.id }, data: { adjudication: 'PRE_ADVERSE', adverseWaitUntil: daysFromNow(3) } });
    const w = await hr.post(`/compliance/background/${check.id}/withdraw-adverse`).send({});
    expect(w.status).toBe(200);
    expect(w.body).toMatchObject({ adjudication: 'ENGAGED', status: 'PASSED' });
  });

  it('the worklist orders final notices due, then decisions, then waiting, then done; the Inbox counts the hand-recorded review', async () => {
    const mk = async (name: string, data: Record<string, unknown>) => {
      const a = await createAssociate({ firstName: name, lastName: 'Case' });
      return prisma.backgroundCheck.create({ data: { associateId: a.id, provider: 'manual', status: 'NEEDS_REVIEW', ...data } });
    };
    const decide = await mk('Decide', {});
    const waiting = await mk('Waiting', { adjudication: 'PRE_ADVERSE', preAdverseSentAt: new Date(), adverseWaitUntil: daysFromNow(4) });
    const due = await mk('Due', { adjudication: 'PRE_ADVERSE', preAdverseSentAt: daysFromNow(-8), adverseWaitUntil: daysFromNow(-1) });
    const done = await mk('Done', { adjudication: 'ADVERSE', status: 'FAILED', adverseSentAt: daysFromNow(-2) });
    await mk('Cleared', { status: 'PASSED', adjudication: 'ENGAGED' });

    const hr = await hrAgent();
    const r = await hr.get('/compliance/adverse-actions');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.rows.map((x: { checkId: string; stage: string }) => [x.checkId, x.stage])).toEqual([
      [due.id, 'FINAL_DUE'],
      [decide.id, 'DECIDE'],
      [waiting.id, 'WAITING'],
      [done.id, 'DONE'],
    ]);

    const inbox = await hr.get('/me/inbox');
    // The decision (NEEDS_REVIEW, no adjudication) and the final notice now due.
    expect(inbox.body.sources.find((s: { key: string }) => s.key === 'screening-decisions')).toMatchObject({ count: 2, path: '/compliance?tab=background' });
  });
});
