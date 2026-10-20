import { createHmac, generateKeyPairSync, createSign } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createUser, prisma, truncateAll } from '../../../test/db.js';
import { encryptString } from '../../lib/crypto.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { taxBanditsJws } from '../../lib/providers/taxFiling.js';
import { resolveAdapter } from '../../lib/disbursement.js';

/**
 * Service providers: per-tenant connections with encrypted credentials and
 * health, the buttons that order through them, and signed, idempotent
 * webhooks that move the records. Every vendor call is mocked here — no
 * test reaches a real vendor.
 */

const reroute = vi.hoisted(() => vi.fn(async () => ({ outcome: 'check', to: 'Paper check #1001', provider: 'CHECK', ref: '1001' })));
vi.mock('../../lib/payoutReroute.js', async (orig) => ({ ...(await orig<typeof import('../../lib/payoutReroute.js')>()), rerouteReturnedItem: reroute }));

type Route = { match: RegExp; method?: string; reply: (url: string, init: RequestInit) => { status?: number; body: unknown } };
let routes: Route[] = [];
const calls: Array<{ url: string; method: string; body: string | null; headers: Record<string, string> }> = [];

function mockFetch(...r: Route[]) {
  routes = r;
}

beforeEach(async () => {
  await truncateAll();
  routes = [];
  calls.length = 0;
  reroute.mockClear();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1] = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init.method ?? 'GET').toUpperCase();
    calls.push({ url, method, body: typeof init.body === 'string' ? init.body : null, headers: (init.headers ?? {}) as Record<string, string> });
    const hit = routes.find((r) => r.match.test(url) && (!r.method || r.method === method));
    if (!hit) throw new Error(`unmocked provider call: ${method} ${url}`);
    const out = hit.reply(url, init);
    const body = typeof out.body === 'string' ? out.body : JSON.stringify(out.body);
    return new Response(body, { status: out.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function hr() {
  const { user } = await createUser({ role: 'HR_ADMINISTRATOR', email: `hr-${Math.random().toString(36).slice(2, 7)}@example.com` });
  return { user, a: await loginAs(agent(), user.email) };
}

async function connect(a: ReturnType<typeof agent>, body: Record<string, unknown>) {
  const r = await a.post('/provider-connections').send(body);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { connection: { id: string; webhookUrl: string | null; health: string }; webhookSecret: string | null };
}

const webhook = (id: string) => request(createApp()).post(`/webhooks/providers/${id}`);

describe('connections', () => {
  it('connects with encrypted credentials, never returns a secret, tests the connection and records health', async () => {
    const { a } = await hr();
    const { connection } = await connect(a, { kind: 'BACKGROUND_CHECK', provider: 'CHECKR', credentials: { apiKey: 'sk_test_123' }, settings: { defaultPackage: 'tasker_standard' } });
    const row = await prisma.providerConnection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(row.credentialsEnc?.toString()).not.toContain('sk_test_123');
    const list = await a.get('/provider-connections');
    expect(JSON.stringify(list.body)).not.toContain('sk_test_123');
    const bg = list.body.kinds.find((k: { kind: string }) => k.kind === 'BACKGROUND_CHECK');
    expect(bg.active).toMatchObject({ provider: 'CHECKR', health: 'not_tested', credentialsSet: { apiKey: true } });

    mockFetch({ match: /checkr-staging\.com\/v1\/account$/, reply: () => ({ body: { id: 'acc_1' } }) });
    const ok = await a.post(`/provider-connections/${connection.id}/test`);
    expect(ok.body).toMatchObject({ ok: true, connection: { health: 'healthy' } });
    expect(calls[0]!.headers.Authorization).toBe(`Basic ${Buffer.from('sk_test_123:').toString('base64')}`);

    mockFetch({ match: /\/account$/, reply: () => ({ status: 401, body: { error: 'Bad authentication' } }) });
    const bad = await a.post(`/provider-connections/${connection.id}/test`);
    expect(bad.body).toMatchObject({ ok: false, message: 'Bad authentication', connection: { health: 'failing', lastError: 'Bad authentication' } });

    // The Inbox says a connection is failing.
    const inbox = await a.get('/me/inbox');
    expect(inbox.body.sources.find((s: { key: string }) => s.key === 'provider-health')?.count).toBe(1);
  });

  it('a provider that signs with a shared secret gets one, shown once; only integration managers connect', async () => {
    const { a } = await hr();
    const made = await connect(a, { kind: 'BACKGROUND_CHECK', provider: 'GENERIC_SCREENING', credentials: { baseUrl: 'https://screen.example.com/v1', apiKey: 'k' } });
    expect(made.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(made.connection.webhookUrl).toContain(`/api/webhooks/providers/${made.connection.id}`);
    const again = await a.get('/provider-connections');
    expect(JSON.stringify(again.body)).not.toContain(made.webhookSecret!);
    const rotated = await a.post(`/provider-connections/${made.connection.id}/rotate-secret`);
    expect(rotated.body.webhookSecret).not.toBe(made.webhookSecret);

    const { user: fin } = await createUser({ role: 'FINANCE_ACCOUNTANT', email: 'fin@example.com' });
    const f = await loginAs(agent(), fin.email);
    expect((await f.post('/provider-connections').send({ kind: 'PAYOUT', provider: 'WISE', credentials: { apiKey: 'x', profileId: '1' } })).status).toBe(403);
    // Missing required credentials are named.
    const missing = await a.post('/provider-connections').send({ kind: 'TAX_FILING', provider: 'TAXBANDITS', credentials: { clientId: 'c' } });
    expect(missing.status).toBe(400);
    expect(missing.body.error.message).toMatch(/client secret/);
  });

  it('without a connection the buttons say so, and the manual path is untouched', async () => {
    const { a } = await hr();
    const p = await createAssociate();
    const check = await prisma.backgroundCheck.create({ data: { associateId: p.id, provider: 'MANUAL' } });
    const r = await a.post(`/provider-actions/background/${check.id}/order`).send({});
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('not_connected');
  });
});

describe('background checks through Checkr', () => {
  it('orders, follows the signed webhook once, and walks the FCRA adverse-action steps', async () => {
    const { a } = await hr();
    const { connection } = await connect(a, { kind: 'BACKGROUND_CHECK', provider: 'CHECKR', credentials: { apiKey: 'sk_test_abc' }, settings: { defaultPackage: 'tasker_standard' } });
    const p = await createAssociate({ firstName: 'Ana', lastName: 'Lopez' });
    const check = await prisma.backgroundCheck.create({ data: { associateId: p.id, provider: 'MANUAL' } });

    mockFetch(
      { match: /\/v1\/candidates$/, method: 'POST', reply: () => ({ body: { id: 'cand_1' } }) },
      { match: /\/v1\/invitations$/, method: 'POST', reply: () => ({ body: { id: 'inv_1', status: 'pending', invitation_url: 'https://apply.checkr.com/x' } }) },
    );
    const ordered = await a.post(`/provider-actions/background/${check.id}/order`).send({});
    expect(ordered.status, JSON.stringify(ordered.body)).toBe(200);
    expect(ordered.body).toMatchObject({ ordered: true, packageCode: 'tasker_standard', invitationUrl: 'https://apply.checkr.com/x' });
    const inv = JSON.parse(calls.find((c) => c.url.endsWith('/invitations'))!.body!);
    expect(inv).toMatchObject({ candidate_id: 'cand_1', package: 'tasker_standard', work_locations: [{ country: 'US' }] });

    // The report comes back "consider": signed with the API key.
    const payload = JSON.stringify({ id: 'evt_1', type: 'invitation.completed', data: { object: { id: 'inv_1', status: 'completed', report_id: 'rep_9' } } });
    const sign = (b: string) => createHmac('sha256', 'sk_test_abc').update(b).digest('hex');
    expect((await webhook(connection.id).set('Content-Type', 'application/json').set('X-Checkr-Signature', 'bad').send(payload)).status).toBe(401);
    expect((await webhook(connection.id).set('Content-Type', 'application/json').set('X-Checkr-Signature', sign(payload)).send(payload)).status).toBe(200);
    const done = JSON.stringify({ id: 'evt_2', type: 'report.completed', data: { object: { id: 'rep_9', status: 'complete', result: 'consider' } } });
    expect((await webhook(connection.id).set('Content-Type', 'application/json').set('X-Checkr-Signature', sign(done)).send(done)).body).toEqual({ ok: true });
    // Re-delivered: recorded once, applied once.
    expect((await webhook(connection.id).set('Content-Type', 'application/json').set('X-Checkr-Signature', sign(done)).send(done)).body).toEqual({ ok: true, duplicate: true });
    let row = await prisma.backgroundCheck.findUniqueOrThrow({ where: { id: check.id } });
    expect(row).toMatchObject({ status: 'NEEDS_REVIEW', result: 'consider', externalId: 'rep_9' });
    expect(await prisma.providerEvent.count({ where: { connectionId: connection.id, direction: 'IN' } })).toBe(2);
    await flushPendingNotifications();
    const inbox = await a.get('/me/inbox');
    expect(inbox.body.sources.find((s: { key: string }) => s.key === 'screening-decisions')?.count).toBe(1);

    // Pre-adverse: Checkr runs the notices; the final notice waits out the period.
    mockFetch({ match: /\/v1\/adverse_actions$/, method: 'POST', reply: () => ({ body: { id: 'aa_1' } }) });
    expect((await a.post(`/provider-actions/background/${check.id}/pre-adverse`).send({})).status).toBe(400);
    const pre = await a.post(`/provider-actions/background/${check.id}/pre-adverse`).send({ confirm: true });
    expect(pre.body).toMatchObject({ adjudication: 'PRE_ADVERSE', canSendFinal: false });
    expect((await a.post(`/provider-actions/background/${check.id}/adverse`).send({ confirm: true })).body.error.code).toBe('waiting_period');
    await prisma.backgroundCheck.update({ where: { id: check.id }, data: { adverseWaitUntil: new Date(Date.now() - 1000) } });
    const fin = await a.post(`/provider-actions/background/${check.id}/adverse`).send({ confirm: true });
    expect(fin.body).toMatchObject({ adjudication: 'ADVERSE', status: 'FAILED' });
    row = await prisma.backgroundCheck.findUniqueOrThrow({ where: { id: check.id } });
    expect(row.adverseActionId).toBe('aa_1');
    await flushPendingAudits();
    expect(await prisma.auditLog.count({ where: { action: { startsWith: 'compliance.background_' }, entityId: check.id } })).toBe(3);
  });
});

describe('E-Verify through an employer agent', () => {
  it('opens the case from the I-9, handles a mismatch with the referral deadline, and takes signed updates', async () => {
    const { a } = await hr();
    const { connection, webhookSecret } = await connect(a, { kind: 'EVERIFY', provider: 'EVERIFY_AGENT', credentials: { baseUrl: 'https://agent.example.com/api', apiKey: 'ak', companyId: 'C-77' } });
    const p = await createAssociate({ firstName: 'Ben', lastName: 'Ortiz' });
    await prisma.associate.update({ where: { id: p.id }, data: { dob: new Date('1990-04-02'), hireDate: new Date('2026-10-12') } });
    await prisma.w4Submission.create({ data: { associateId: p.id, filingStatus: 'SINGLE', ssnEncrypted: encryptString('123-45-6789') } });
    await prisma.i9Verification.create({ data: { associateId: p.id, citizenshipStatus: 'US_CITIZEN', section1CompletedAt: new Date(), section2CompletedAt: new Date() } });

    mockFetch({ match: /agent\.example\.com\/api\/cases$/, method: 'POST', reply: () => ({ body: { case_number: '2026291000001AB', case_status: 'TENTATIVE_NONCONFIRMATION' } }) });
    const opened = await a.post(`/provider-actions/everify/${p.id}/submit`).send({ firstDayOfEmployment: '2026-10-12' });
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    expect(opened.body).toMatchObject({ caseNumber: '2026291000001AB', status: 'TENTATIVE_NONCONFIRMATION', dueBy: '2026-10-15', sentThroughProvider: true });
    const sent = JSON.parse(calls[0]!.body!);
    expect(sent.employee).toMatchObject({ ssn: '123456789', dob: '1990-04-02', firstDayOfEmployment: '2026-10-12' });
    // Never kept in the connection log.
    expect(JSON.stringify(await prisma.providerEvent.findMany())).not.toContain('123456789');

    mockFetch({ match: /\/cases\/2026291000001AB\/referral$/, method: 'POST', reply: () => ({ body: { case_status: 'REFERRED' } }) });
    const decided = await a.post(`/provider-actions/everify/${p.id}/notice`).send({ decision: 'CONTEST' });
    expect(decided.body.tnc).toMatchObject({ decision: 'CONTEST' });
    expect(decided.body.tnc.referralDeadline).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((await a.post(`/provider-actions/everify/${p.id}/notice`).send({ decision: 'NO_CONTEST' })).status).toBe(409);

    const body = JSON.stringify({ id: 'upd-1', case_number: '2026291000001AB', case_status: 'EMPLOYMENT_AUTHORIZED' });
    const sig = createHmac('sha256', webhookSecret!).update(body).digest('hex');
    expect((await webhook(connection.id).set('Content-Type', 'application/json').set('X-Signature', sig).send(body)).status).toBe(200);
    const i9 = await prisma.i9Verification.findFirstOrThrow({ where: { associateId: p.id } });
    expect(i9).toMatchObject({ eVerifyStatus: 'EMPLOYMENT_AUTHORIZED' });
    expect(i9.eVerifyClosedAt).not.toBeNull();
  });
});

describe('drug tests through eScreen', () => {
  it('orders with a donor pass; a positive waits for the MRO; a verified negative passes', async () => {
    const { a } = await hr();
    const { connection, webhookSecret } = await connect(a, { kind: 'DRUG_TEST', provider: 'ESCREEN', credentials: { baseUrl: 'https://escreen.example.com/v2', apiKey: 'k', accountId: 'A1' }, settings: { defaultPanel: '5-panel' } });
    const p = await createAssociate();
    const t = await prisma.drugTest.create({ data: { associateId: p.id, provider: 'MANUAL' } });
    mockFetch({ match: /\/orders$/, method: 'POST', reply: () => ({ body: { orderId: 'ORD-1', donorPassUrl: 'https://pass.example.com/1', donorPassExpiresAt: '2026-10-24T23:59:00Z', collectionSite: 'Concentra, 12 Main St' } }) });
    const ordered = await a.post(`/provider-actions/drug-tests/${t.id}/order`).send({ reason: 'PRE_EMPLOYMENT' });
    expect(ordered.body).toMatchObject({ ordered: true, donorPassUrl: 'https://pass.example.com/1', collectionSite: 'Concentra, 12 Main St', panelCode: '5-panel' });

    const send = (o: Record<string, unknown>) => {
      const b = JSON.stringify(o);
      return webhook(connection.id).set('Content-Type', 'application/json').set('X-Signature', createHmac('sha256', webhookSecret!).update(b).digest('hex')).send(b);
    };
    await send({ eventId: 'e1', orderId: 'ORD-1', status: 'lab', result: 'positive', mroVerified: false });
    expect((await prisma.drugTest.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('NEEDS_REVIEW');
    await send({ eventId: 'e2', orderId: 'ORD-1', status: 'complete', result: 'positive', mroVerified: true });
    expect((await prisma.drugTest.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('FAILED');

    const t2 = await prisma.drugTest.create({ data: { associateId: p.id, provider: 'ESCREEN', externalId: 'ORD-2', connectionId: connection.id } });
    await send({ eventId: 'e3', orderId: 'ORD-2', status: 'complete', result: 'Negative' });
    expect((await prisma.drugTest.findUniqueOrThrow({ where: { id: t2.id } })).status).toBe('PASSED');
  });
});

describe('tax filing through TaxBandits', () => {
  it('signs the JWS the way TaxBandits asks', () => {
    const jws = taxBanditsJws('cid', 'secret', 'utok', new Date('2026-10-17T12:00:00Z'));
    const [h, pl, sig] = jws.split('.');
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({ alg: 'HS256', typ: 'JWT' });
    expect(JSON.parse(Buffer.from(pl!, 'base64url').toString())).toEqual({ iss: 'cid', sub: 'cid', aud: 'utok', iat: 1792238400 });
    expect(sig).toBe(createHmac('sha256', 'secret').update(`${h}.${pl}`).digest('base64url'));
  });

  it('e-files a 941, records the acceptance as filed; a rejection lands in the Inbox', async () => {
    const { a } = await hr();
    const { connection } = await connect(a, { kind: 'TAX_FILING', provider: 'TAXBANDITS', credentials: { clientId: 'cid', clientSecret: 'csecret', userToken: 'ut' } });
    await prisma.submitterProfile.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', userId: 'ALTO0001', ein: '123456789', name: 'Alto HR', addressLine1: '1 Main', city: 'Destin', state: 'FL', zip5: '32541', contactName: 'Pat', contactPhone: '8505550100', contactEmail: 'pay@example.com' }, update: { ein: '123456789' } });
    const form = await prisma.taxForm.create({ data: { kind: 'F941', taxYear: 2026, quarter: 3, amounts: { totalWages: '1000.00', totalFederalWithheld: '100.00' }, status: 'DRAFT' } });
    mockFetch(
      { match: /testoauth\.expressauth\.net\/v2\/tbsauth$/, reply: () => ({ body: { AccessToken: 'tok', ExpiresIn: 3600 } }) },
      { match: /\/Business\/Create$/, reply: () => ({ body: { BusinessId: 'biz-1' } }) },
      { match: /\/Form941\/Create$/, reply: () => ({ body: { SubmissionId: 'sub-1', Form941Records: { SuccessRecords: [{ RecordId: 'rec-1', Status: 'CREATED' }] } } }) },
      { match: /\/Form941\/Transmit$/, reply: () => ({ body: { SubmissionId: 'sub-1', SubmissionStatus: 'TRANSMITTED' } }) },
    );
    const filed = await a.post(`/provider-actions/tax-forms/${form.id}/efile`).send({});
    expect(filed.status, JSON.stringify(filed.body)).toBe(200);
    expect(filed.body).toMatchObject({ efileStatus: 'SENT_TO_AGENCY', efileSubmissionId: 'sub-1', status: 'DRAFT' });
    expect(calls.find((c) => /Form941\/Create/.test(c.url))!.headers.Authorization).toBe('Bearer tok');
    // The business id is remembered for next time.
    expect(((await prisma.providerConnection.findUniqueOrThrow({ where: { id: connection.id } })).settings as Record<string, unknown>).businessId).toBe('biz-1');

    const ts = '2026-10-18T10:00:00Z';
    const signature = createHmac('sha256', 'csecret').update(`cid\n${ts}`).digest('base64');
    const accepted = JSON.stringify({ SubmissionId: 'sub-1', FormType: 'Form941', Records: [{ RecordId: 'rec-1', Status: 'Accepted' }] });
    expect((await webhook(connection.id).set('Content-Type', 'application/json').set('Signature', 'nope').set('TimeStamp', ts).send(accepted)).status).toBe(401);
    expect((await webhook(connection.id).set('Content-Type', 'application/json').set('Signature', signature).set('TimeStamp', ts).send(accepted)).status).toBe(200);
    expect(await prisma.taxForm.findUniqueOrThrow({ where: { id: form.id } })).toMatchObject({ status: 'FILED', efileStatus: 'ACCEPTED' });

    const w2 = await prisma.taxForm.create({ data: { kind: 'F940', taxYear: 2026, amounts: {}, status: 'DRAFT', efileSubmissionId: 'sub-2', efileStatus: 'SENT_TO_AGENCY', efileConnectionId: connection.id } });
    const ts2 = '2026-10-18T11:00:00Z';
    const rejected = JSON.stringify({ SubmissionId: 'sub-2', Records: [{ RecordId: 'r2', Status: 'Rejected', Errors: [{ Code: 'R0000-904', Message: 'EIN and name do not match IRS records.' }] }] });
    await webhook(connection.id).set('Content-Type', 'application/json').set('Signature', createHmac('sha256', 'csecret').update(`cid\n${ts2}`).digest('base64')).set('TimeStamp', ts2).send(rejected);
    expect(await prisma.taxForm.findUniqueOrThrow({ where: { id: w2.id } })).toMatchObject({ efileStatus: 'REJECTED', efileRejectionReason: 'EIN and name do not match IRS records.', status: 'DRAFT' });
    const inbox = await a.get('/me/inbox');
    expect(inbox.body.sources.find((s: { key: string }) => s.key === 'efile-rejected')?.count).toBe(1);
  });
});

describe('payouts through Wise', () => {
  it('pays from the tenant’s own Wise connection, and a bounced transfer re-routes the paycheck once', async () => {
    const { a } = await hr();
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const { connection } = await connect(a, { kind: 'PAYOUT', provider: 'WISE', credentials: { apiKey: 'wise-token', profileId: '555' }, settings: { webhookPublicKey: pem } });
    expect((await resolveAdapter()).provider).toBe('WISE');

    const p = await createAssociate();
    const run = await prisma.payrollRun.create({ data: { periodStart: new Date('2026-10-03'), periodEnd: new Date('2026-10-16'), status: 'DISBURSED' } });
    const item = await prisma.payrollItem.create({ data: { payrollRunId: run.id, associateId: p.id, hoursWorked: 10, hourlyRate: 20, grossPay: 200, federalWithholding: 0, fica: 0, medicare: 0, stateWithholding: 0, netPay: 200, status: 'DISBURSED' } });
    await prisma.payrollDisbursementAttempt.create({ data: { payrollItemId: item.id, provider: 'WISE', status: 'SUCCESS', externalRef: '987654' } });

    const post = (o: Record<string, unknown>, key = privateKey) => {
      const b = JSON.stringify(o);
      const s = createSign('RSA-SHA256');
      s.update(b);
      return webhook(connection.id).set('Content-Type', 'application/json').set('X-Signature-SHA256', s.sign(key, 'base64')).send(b);
    };
    const sent = { event_type: 'transfers#state-change', data: { resource: { id: 987654, type: 'transfer' }, current_state: 'outgoing_payment_sent', previous_state: 'processing', occurred_at: '2026-10-16T15:00:00Z' } };
    expect((await post(sent)).body).toMatchObject({ ok: true, ignored: 'state_outgoing_payment_sent' });
    expect(reroute).not.toHaveBeenCalled();

    const bounced = { ...sent, data: { ...sent.data, current_state: 'bounced_back', previous_state: 'outgoing_payment_sent', occurred_at: '2026-10-17T09:00:00Z' } };
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    expect((await post(bounced, other)).status).toBe(401);
    expect((await post(bounced)).body).toEqual({ ok: true });
    expect((await post(bounced)).body).toEqual({ ok: true, duplicate: true });
    expect(reroute).toHaveBeenCalledTimes(1);
    expect((reroute.mock.calls[0] as unknown as unknown[])[1]).toMatchObject({ payrollItemId: item.id, returnedRef: '987654' });
  });
});
