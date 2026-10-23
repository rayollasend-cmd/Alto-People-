import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { encryptString } from '../../lib/crypto.js';
import { segmentsOf } from '../../lib/edi834.js';
import { deliveryDeps, type SftpClient } from '../../lib/fileDelivery.js';
import { CARRIER_ACK_PICKUP_JOB, SFTP_NOT_INSTALLED, pickUpCarrierAcks, startCarrierAckPickupCron, stopCarrierAckPickupCron } from '../../lib/carrierAcks.js';
import { __resetJobsForTests, listJobs } from '../../lib/jobs.js';
import { ALTO_TENANT_ID, runWithTenant } from '../../lib/tenant.js';

/**
 * Carrier answers to 834 enrollment files (lib/ediAck, lib/carrierAcks):
 * uploaded on Carrier feeds or picked up from the carrier's SFTP folder,
 * matched to the file by carrier + control number, shown per file and per
 * feed, and raised in the Inbox when a carrier rejects a file or hasn't
 * answered in more than 3 business days.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const realLoadSftp = deliveryDeps.loadSftp;
afterEach(() => {
  deliveryDeps.loadSftp = realLoadSftp;
});

const job = <T>(fn: () => Promise<T>) => runWithTenant(ALTO_TENANT_ID, 'job', fn);

async function person(first: string, last: string, ssn: string) {
  const p = await createAssociate({ firstName: first, lastName: last });
  await prisma.associate.update({ where: { id: p.id }, data: { ssnLast4: ssn.slice(-4), dob: new Date('1985-03-04'), hireDate: new Date('2024-01-10'), employmentType: 'W2_EMPLOYEE', addressLine1: '5 Elm St', city: 'Austin', state: 'TX', zip: '78701' } });
  await prisma.w4Submission.create({ data: { associateId: p.id, filingStatus: 'SINGLE', ssnEncrypted: encryptString(ssn) } });
  return p;
}

/** A carrier with Ann and Bo enrolled in its one plan, and the benefits admin's session. */
async function feed(transport: 'DOWNLOAD' | 'SFTP' | 'HTTPS' = 'DOWNLOAD') {
  const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
  const a = await loginAs(agent(), user.email);
  const client = await createClient();
  const plan = await prisma.benefitsPlan.create({ data: { clientId: client.id, kind: 'HEALTH_MEDICAL', name: 'PPO 500' } });
  const ann = await person('Ann', 'Lee', '111223333');
  const bo = await person('Bo', 'Ray', '222334444');
  for (const p of [ann, bo]) await prisma.benefitsEnrollment.create({ data: { associateId: p.id, planId: plan.id, electedAmountCentsPerPeriod: 5000, effectiveDate: new Date('2026-01-01') } });
  const c = await a.post('/benefit-carriers').send({ name: 'Blue Cross', receiverId: 'BCBSTX', receiverQualifier: 'ZZ', senderId: 'ALTOHR', senderQualifier: 'ZZ', usageIndicator: 'T', transport });
  expect(c.status).toBe(201);
  const carrierId = c.body.carrier.id as string;
  await a.put(`/benefit-carriers/${carrierId}/plans`).send({ plans: [{ planId: plan.id }] });
  return { a, user, carrierId, ann, bo, plan };
}

async function makeFile(a: Awaited<ReturnType<typeof feed>>['a'], carrierId: string, mode: 'FULL' | 'CHANGE' = 'FULL') {
  const r = await a.post(`/benefit-carriers/${carrierId}/files`).send({ mode });
  expect(r.status).toBe(201);
  return r.body.file as { id: string; controlNumber: number };
}

const isa = (ctl: number) => ['ISA', '00', ' '.repeat(10), '00', ' '.repeat(10), 'ZZ', 'BCBSTX'.padEnd(15), 'ZZ', 'ALTOHR'.padEnd(15), '261016', '0930', '^', '00501', String(ctl).padStart(9, '0'), '0', 'T', ':'].join('*') + '~';
const ack999 = (group: number, body: string[], ak9: string) =>
  [isa(900 + group), `GS*FA*BCBSTX*ALTOHR*20261016*0930*${group}*X*005010X231A1~`, 'ST*999*0001*005010X231A1~', `AK1*BE*${group}*005010X220A1~`, 'AK2*834*0001*005010X220A1~', ...body, `${ak9}~`, `SE*${body.length + 5}*0001~`, `GE*1*${group}~`, `IEA*1*${String(900 + group).padStart(9, '0')}~`].join('\n');
const accepted = (group: number) => ack999(group, ['IK5*A~'], 'AK9*A*1*1*1');
const rejected = (group: number, body: string[] = ['IK5*R*4~']) => ack999(group, body, 'AK9*R*1*1*0');
const ta1 = (ctl: number, code: 'A' | 'E' | 'R', note = '000') => `${isa(990)}TA1*${String(ctl).padStart(9, '0')}*261016*0930*${code}*${note}~IEA*0*000000990~`;

describe('uploading a carrier’s answer', () => {
  it('matches by carrier + control number, names the member, and the file and the feed show the answer', async () => {
    const { a, carrierId } = await feed();
    const file = await makeFile(a, carrierId);
    // Where Bo's birth date sits in the file we sent (ST = 1): the DMG after his name.
    const segs = segmentsOf((await a.get(`/benefit-files/${file.id}/download`)).text);
    const st = segs.findIndex((s) => s[0] === 'ST');
    const boName = segs.findIndex((s) => s[0] === 'NM1' && s[3] === 'RAY');
    const boDmg = segs.findIndex((s, i) => i > boName && s[0] === 'DMG') - st + 1;
    const dmgs = [0, boDmg];

    const up = await a.post(`/benefit-carriers/${carrierId}/acks`).send({ content: ack999(file.controlNumber, [`IK3*DMG*${dmgs[1]}*2100A*8~`, 'IK4*2*1251*8*19850230~', 'IK5*E~'], 'AK9*E*1*1*1') });
    expect(up.status).toBe(201);
    expect(up.body.duplicate).toBe(false);
    expect(up.body.acks).toEqual([
      expect.objectContaining({
        kind: '999',
        status: 'ACCEPTED_WITH_ERRORS',
        controlNumber: file.controlNumber,
        source: 'UPLOAD',
        file: expect.objectContaining({ id: file.id, controlNumber: file.controlNumber, mode: 'FULL' }),
        errorCount: 1,
        errors: [expect.objectContaining({ code: 'IK4:8', member: 'Bo Ray', element: 'DMG02', message: `The birth date (DMG02) at segment ${dmgs[1]} isn’t a valid date (sent “19850230”).` })],
      }),
    ]);
    // The raw answer is kept encrypted.
    const row = await prisma.edi834Ack.findFirstOrThrow({ where: { carrierId } });
    expect(row.content).not.toContain('AK1');

    const files = (await a.get(`/benefit-carriers/${carrierId}/files`)).body.files;
    expect(files[0]).toMatchObject({ id: file.id, ackStatus: 'ACCEPTED_WITH_ERRORS', answer: { state: 'ACCEPTED_WITH_ERRORS' }, ack: { kind: '999', errorCount: 1, errors: [expect.objectContaining({ member: 'Bo Ray' })] } });
    const health = (await a.get('/benefit-carriers')).body.carriers[0].health;
    expect(health.lastAnswer).toMatchObject({ kind: '999', status: 'ACCEPTED_WITH_ERRORS', matched: true, errorCount: 1, controlNumber: file.controlNumber, source: 'UPLOAD' });
    expect(health.lastFile.answer).toEqual({ state: 'ACCEPTED_WITH_ERRORS' });

    // The same answer twice is kept once.
    const again = await a.post(`/benefit-carriers/${carrierId}/acks`).send({ content: `${ack999(file.controlNumber, [`IK3*DMG*${dmgs[1]}*2100A*8~`, 'IK4*2*1251*8*19850230~', 'IK5*E~'], 'AK9*E*1*1*1')}\n\n` });
    expect(again.status).toBe(200);
    expect(again.body.duplicate).toBe(true);
    expect(await prisma.edi834Ack.count()).toBe(1);

    // A later TA1 (the envelope) doesn't overrule the 999 (the transaction set).
    expect((await a.post(`/benefit-carriers/${carrierId}/acks`).send({ content: ta1(file.controlNumber, 'A') })).status).toBe(201);
    expect((await prisma.edi834File.findUniqueOrThrow({ where: { id: file.id } })).ackStatus).toBe('ACCEPTED_WITH_ERRORS');
    // A newer 999 does.
    await a.post(`/benefit-carriers/${carrierId}/acks`).send({ content: accepted(file.controlNumber) });
    expect((await prisma.edi834File.findUniqueOrThrow({ where: { id: file.id } })).ackStatus).toBe('ACCEPTED');
  });

  it('keeps an answer that matches nothing, and says plainly what isn’t an answer', async () => {
    const { a, carrierId } = await feed();
    await makeFile(a, carrierId);
    const up = await a.post(`/benefit-carriers/${carrierId}/acks`).send({ content: ta1(4242, 'R', '025') });
    expect(up.status).toBe(201);
    expect(up.body.acks[0]).toMatchObject({ kind: 'TA1', status: 'REJECTED', controlNumber: 4242, fileId: null, file: null, errors: [{ code: 'TA1:025', message: 'The carrier already received a file with this interchange control number.' }] });
    const list = (await a.get(`/benefit-carriers/${carrierId}/acks`)).body.acks;
    expect(list).toHaveLength(1);
    expect(list[0].file).toBeNull();
    expect((await a.get('/benefit-carriers')).body.carriers[0].health.lastAnswer).toMatchObject({ matched: false, status: 'REJECTED' });

    const bad = await a.post(`/benefit-carriers/${carrierId}/acks`).send({ content: 'ST*834*0001*005010X220A1~SE*2*0001~' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatchObject({ code: 'not_an_acknowledgment', message: expect.stringMatching(/enrollment file \(834\)/) });
    expect(await prisma.edi834Ack.count()).toBe(1);
  });

  it('one file with answers to two files matches each', async () => {
    const { a, carrierId, bo } = await feed();
    const first = await makeFile(a, carrierId);
    await prisma.benefitsEnrollment.updateMany({ where: { associateId: bo.id }, data: { terminationDate: new Date('2026-12-31') } });
    const second = await makeFile(a, carrierId, 'CHANGE');
    const body = [
      isa(950),
      'GS*FA*BCBSTX*ALTOHR*20261016*0930*950*X*005010X231A1~',
      `ST*999*0001~AK1*BE*${first.controlNumber}~AK2*834*0001~IK5*A~AK9*A*1*1*1~SE*6*0001~`,
      `ST*999*0002~AK1*BE*${second.controlNumber}~AK2*834*0001~IK5*R*5~AK9*R*1*1*0~SE*6*0002~`,
      'GE*2*950~IEA*1*000000950~',
    ].join('\n');
    const up = await a.post(`/benefit-carriers/${carrierId}/acks`).send({ content: body });
    expect(up.body.acks.map((x: { file: { id: string }; status: string }) => [x.file.id, x.status])).toEqual([
      [first.id, 'ACCEPTED'],
      [second.id, 'REJECTED'],
    ]);
  });
});

describe('who may read and upload answers', () => {
  it('benefits admins only, company-wide for an upload; a site-limited reader sees no member names; another tenant’s carrier is not found', async () => {
    const { a, carrierId } = await feed();
    const file = await makeFile(a, carrierId);
    const segs = segmentsOf((await a.get(`/benefit-files/${file.id}/download`)).text);
    // Ann's birth date: the DMG after her name (the file lists members by id,
    // so whether Ann or Bo comes first changes from run to run).
    const annName = segs.findIndex((s) => s[0] === 'NM1' && s[3] === 'LEE');
    const pos = segs.findIndex((s, i) => i > annName && s[0] === 'DMG') - segs.findIndex((s) => s[0] === 'ST') + 1;
    await a.post(`/benefit-carriers/${carrierId}/acks`).send({ content: rejected(file.controlNumber, [`IK3*DMG*${pos}*2100A*8~`, 'IK4*2*1251*8~', 'IK5*R*5~']) });

    const { user: recruiter } = await createUser({ role: 'INTERNAL_RECRUITER' });
    const r = await loginAs(agent(), recruiter.email);
    expect((await r.get(`/benefit-carriers/${carrierId}/acks`)).status).toBe(403);
    expect((await r.post(`/benefit-carriers/${carrierId}/acks`).send({ content: accepted(file.controlNumber) })).status).toBe(403);

    const { user: narrow } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    await prisma.user.update({ where: { id: narrow.id }, data: { scopeSiteIds: [randomUUID()] } });
    const n = await loginAs(agent(), narrow.email);
    const up = await n.post(`/benefit-carriers/${carrierId}/acks`).send({ content: accepted(file.controlNumber) });
    expect(up.status).toBe(403);
    expect(up.body.error.code).toBe('company_wide');
    const seen = await n.get(`/benefit-carriers/${carrierId}/acks`);
    expect(seen.status).toBe(200);
    expect(seen.body.acks[0].errors[0].member).toBeUndefined();
    expect(JSON.stringify(seen.body)).not.toContain('Ann Lee');
    expect((await a.get(`/benefit-carriers/${carrierId}/acks`)).body.acks[0].errors[0].member).toBe('Ann Lee');

    const T2 = '22222222-2222-4222-8222-222222222222';
    await prisma.tenant.upsert({ where: { id: T2 }, create: { id: T2, slug: 'acks-two', name: 'Acks Two' }, update: {} });
    const theirs = await prisma.benefitCarrier.create({ data: { tenantId: T2, name: 'Their Carrier', receiverId: 'THEM', senderId: 'THEM' } });
    expect((await a.get(`/benefit-carriers/${theirs.id}/acks`)).status).toBe(404);
    expect((await a.post(`/benefit-carriers/${theirs.id}/acks`).send({ content: accepted(1) })).status).toBe(404);
  });
});

describe('a rejected file is no baseline', () => {
  it('the next change file carries the rejected file’s changes again', async () => {
    const { a, carrierId, bo } = await feed();
    const full = await makeFile(a, carrierId);
    await a.post(`/benefit-carriers/${carrierId}/acks`).send({ content: accepted(full.controlNumber) });
    await new Promise((r) => setTimeout(r, 20));
    await prisma.benefitsEnrollment.updateMany({ where: { associateId: bo.id }, data: { terminationDate: new Date('2026-12-31') } });
    const change = await makeFile(a, carrierId, 'CHANGE');
    expect((await a.get('/benefit-carriers')).body.carriers[0].health.changesWaiting).toBe(0);

    await a.post(`/benefit-carriers/${carrierId}/acks`).send({ content: rejected(change.controlNumber) });
    // Bo's change is waiting again, and the next change file carries it.
    expect((await a.get('/benefit-carriers')).body.carriers[0].health.changesWaiting).toBe(1);
    const again = await makeFile(a, carrierId, 'CHANGE');
    const segs = segmentsOf((await a.get(`/benefit-files/${again.id}/download`)).text);
    expect(segs.filter((s) => s[0] === 'NM1' && s[1] === 'IL').map((s) => s[3])).toEqual(['RAY']);
    expect(segs.find((s) => s[0] === 'INS')!.slice(1, 4)).toEqual(['Y', '18', '024']);
  });
});

describe('the Inbox: carrier answers that need a benefits admin', () => {
  it('rejected files until a newer file follows, and files sent more than 3 business days ago with no answer', async () => {
    const { a, carrierId } = await feed('SFTP');
    const { user: finance } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const f = await loginAs(agent(), finance.email);
    const day = 86_400_000;
    const now = Date.now();
    const file = (controlNumber: number, o: Record<string, unknown>) =>
      prisma.edi834File.create({ data: { carrierId, mode: 'CHANGE', controlNumber, content: encryptString('x').toString('base64'), memberCount: 1, createdAt: new Date(now - 60 * day), ...o } });
    await file(101, { status: 'SENT', sentAt: new Date(now - 8 * day) }); // waiting ≥ 4 business days: counted
    await file(102, { status: 'SENT', sentAt: new Date(now - 3_600_000) }); // sent an hour ago: not yet
    await file(103, { status: 'SENT', sentAt: new Date(now - 40 * day) }); // past the 30-day look-back
    await file(104, { status: 'SENT', sentAt: new Date(now - 8 * day), ackStatus: 'ACCEPTED', ackedAt: new Date(now - 7 * day) }); // answered
    await file(105, { status: 'GENERATED' }); // never sent
    await file(106, { status: 'SENT', sentAt: new Date(now - 9 * day), ackStatus: 'REJECTED', ackedAt: new Date(now - 2 * day), createdAt: new Date(now - 9 * day) }); // rejected: counted

    const src = async (agentFor: typeof f) => ((await agentFor.get('/me/inbox')).body.sources as Array<{ key: string; count: number; path: string; preview?: string[]; description: string; watching?: boolean }>).find((s) => s.key === 'carrier-answers');
    const mine = await src(f);
    expect(mine).toMatchObject({ count: 2, path: `/benefits/carriers?carrier=${carrierId}`, description: 'Enrollment files: 1 rejected · 1 with no answer after 3 business days.' });
    expect(mine!.preview).toEqual(['Blue Cross · control 106 rejected', expect.stringMatching(/^Blue Cross · control 101: no answer in \d+ business days$/)]);
    expect(mine!.watching).toBeUndefined();
    // Payroll's desk: HR may see it, as "Also watching".
    expect(await src(a)).toMatchObject({ count: 2, watching: true });

    // A newer file after the rejection: the rejection has been acted on.
    await makeFile(a, carrierId, 'FULL');
    expect((await src(f))!.count).toBe(1);

    // A download carrier's file is never "waiting" in the Inbox.
    await prisma.benefitCarrier.update({ where: { id: carrierId }, data: { transport: 'DOWNLOAD' } });
    expect((await src(f))!.count).toBe(0);
  });
});

describe('the SFTP pickup', () => {
  type Entry = { type: string; name: string; size: number; modifyTime: number };
  function fakeSftp(files: Record<string, string>, opts: { connectError?: string } = {}) {
    const mtime = Date.now() - 60_000;
    const calls = { connect: 0, list: [] as string[], get: [] as string[] };
    class Fake implements SftpClient {
      async connect() {
        calls.connect += 1;
        if (opts.connectError) throw new Error(opts.connectError);
      }
      async put() {}
      async list(dir: string): Promise<Entry[]> {
        calls.list.push(dir);
        return [
          ...Object.entries(files).map(([name, body]) => ({ type: '-', name, size: body.length, modifyTime: mtime })),
          { type: 'd', name: 'archive', size: 0, modifyTime: mtime },
          { type: '-', name: '.lock', size: 1, modifyTime: mtime },
          { type: '-', name: 'last-year.999', size: 10, modifyTime: Date.now() - 400 * 86_400_000 },
        ];
      }
      async get(path: string) {
        calls.get.push(path);
        return Buffer.from(files[path.split('/').pop()!] ?? '', 'utf8');
      }
      async end() {}
    }
    deliveryDeps.loadSftp = async () => Fake;
    return calls;
  }

  it('reads new files from the inbound folder once, keeps one that isn’t an answer, and records each look', async () => {
    const { a, carrierId } = await feed('SFTP');
    const conn = await a.put(`/benefit-carriers/${carrierId}/connection`).send({ host: 'sftp.bcbstx.com', username: 'alto', password: 's3cret', remoteDir: '/inbound', inboundDir: '/outbound/acks/' });
    expect(conn.body.connection).toMatchObject({ host: 'sftp.bcbstx.com', remoteDir: '/inbound', inboundDir: '/outbound/acks/', hasSecret: true });
    const file = await makeFile(a, carrierId);
    // A second SFTP carrier with no inbound folder: never looked at.
    const other = (await a.post('/benefit-carriers').send({ name: 'Eye Co', receiverId: 'EYECO', receiverQualifier: 'ZZ', senderId: 'ALTOHR', senderQualifier: 'ZZ', usageIndicator: 'T', transport: 'SFTP' })).body.carrier.id;
    await a.put(`/benefit-carriers/${other}/connection`).send({ host: 'sftp.eyeco.com', username: 'alto', password: 'x' });

    const calls = fakeSftp({ [`999_${file.controlNumber}.txt`]: accepted(file.controlNumber), 'readme.txt': 'Welcome to the Blue Cross SFTP.' });
    expect(await job(() => pickUpCarrierAcks())).toEqual({ carriers: 1, picked: 2, failed: 0 });
    expect(calls.list).toEqual(['/outbound/acks']);
    expect(calls.get.sort()).toEqual([`/outbound/acks/999_${file.controlNumber}.txt`, '/outbound/acks/readme.txt']);
    expect((await prisma.edi834File.findUniqueOrThrow({ where: { id: file.id } })).ackStatus).toBe('ACCEPTED');
    const rows = await prisma.edi834Ack.findMany({ orderBy: { status: 'asc' } });
    expect(rows.map((r) => [r.kind, r.status, r.source])).toEqual([
      ['999', 'ACCEPTED', 'SFTP'],
      ['UNKNOWN', 'UNREADABLE', 'SFTP'],
    ]);
    expect((rows[1]!.errors as Array<{ message: string }>)[0]!.message).toMatch(/^readme\.txt: No 999 or TA1/);
    const carrier = await prisma.benefitCarrier.findUniqueOrThrow({ where: { id: carrierId } });
    expect(carrier.ackCheckedAt).not.toBeNull();
    expect(carrier.ackCheckError).toBeNull();
    // The page's latest answer skips the file that wasn't one.
    expect((await a.get('/benefit-carriers')).body.carriers.find((c: { id: string }) => c.id === carrierId).health.lastAnswer).toMatchObject({ status: 'ACCEPTED', source: 'SFTP' });

    // The next look reads nothing twice.
    expect(await job(() => pickUpCarrierAcks())).toEqual({ carriers: 1, picked: 0, failed: 0 });
    expect(calls.get).toHaveLength(2);
    expect(await prisma.edi834Ack.count()).toBe(2);
  });

  it('says plainly when SFTP isn’t installed or the folder can’t be read', async () => {
    const { a, carrierId } = await feed('SFTP');
    await a.put(`/benefit-carriers/${carrierId}/connection`).send({ host: 'sftp.bcbstx.com', username: 'alto', password: 's3cret', inboundDir: '/outbound' });
    await makeFile(a, carrierId);

    deliveryDeps.loadSftp = async () => null;
    expect(await job(() => pickUpCarrierAcks())).toEqual({ carriers: 1, picked: 0, failed: 1 });
    expect((await prisma.benefitCarrier.findUniqueOrThrow({ where: { id: carrierId } })).ackCheckError).toBe(SFTP_NOT_INSTALLED);
    const page = (await a.get('/benefit-carriers')).body;
    expect(page.sftpAvailable).toBe(false);
    expect(page.carriers[0]).toMatchObject({ ackCheckError: SFTP_NOT_INSTALLED, connection: { inboundDir: '/outbound' } });

    fakeSftp({}, { connectError: 'All configured authentication methods failed' });
    await job(() => pickUpCarrierAcks());
    expect((await prisma.benefitCarrier.findUniqueOrThrow({ where: { id: carrierId } })).ackCheckError).toBe('Couldn’t read the carrier’s folder: All configured authentication methods failed');

    // Clearing the inbound folder turns the pickup off for this carrier.
    await a.put(`/benefit-carriers/${carrierId}/connection`).send({ inboundDir: '' });
    expect((await a.get('/benefit-carriers')).body.carriers[0].connection.inboundDir).toBeNull();
    expect(await job(() => pickUpCarrierAcks())).toEqual({ carriers: 0, picked: 0, failed: 0 });
  });

  it('is a listed scheduled job, armed hourly by default', () => {
    __resetJobsForTests();
    startCarrierAckPickupCron();
    const j = listJobs().find((x) => x.name === CARRIER_ACK_PICKUP_JOB);
    expect(j).toMatchObject({ intervalSeconds: 3600, armed: true, runs: 0 });
    stopCarrierAckPickupCron();
    __resetJobsForTests();
  });
});
