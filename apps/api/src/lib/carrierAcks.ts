import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { env } from '../config/env.js';
import { enqueueAudit } from './audit.js';
import { decryptString, encryptString } from './crypto.js';
import { AckParseError, memberAt, parseAcknowledgments, type AckError, type AckStatus } from './ediAck.js';
import { deliveryDeps, openConnection, type ConnectionSettings } from './fileDelivery.js';
import { armJob, stopJob } from './jobs.js';
import { isBusinessDay } from './payrollTaxCalendar.js';
import { tenantIdForWrite } from './tenant.js';
import { tenantJob } from './tenantJobs.js';

/**
 * Carrier answers to 834 enrollment files: reading them in (an upload on
 * Carrier feeds, or a pickup from the carrier's SFTP folder), matching
 * each to the file it answers, and saying where each file stands.
 *
 *   Matching   by carrier + control number — a TA1 echoes our ISA13 and a
 *              999's AK1 our GS06, and an 834 here carries the same number
 *              in both (lib/edi834). An answer that matches no file is
 *              kept, with no file, and shown as such.
 *   The file   takes the deciding answer: the newest 999 (it speaks for
 *              the transaction set) over a TA1 (the envelope only).
 *   Waiting    a file sent to an SFTP or HTTPS carrier with no answer is
 *              waiting; more than 3 business days is overdue (the Inbox
 *              item). A download carrier's file is waiting only once that
 *              carrier has answered here before — until then no answer is
 *              expected here.
 *   Pickup     off unless the carrier's connection names an inbound
 *              folder. Every file in it is remembered by name, size and
 *              time (Edi834Ack.sourceRef), so nothing is read twice;
 *              files older than the first 834 made for that carrier can't
 *              answer one of ours and are skipped. A file that isn't an
 *              acknowledgment is kept as UNREADABLE, so it isn't retried.
 */

export type AnswerState = AckStatus | 'WAITING' | 'NOT_EXPECTED';

/** Business days after `from`'s day, up to and including `now`'s day (UTC dates; federal holidays skipped). */
export function businessDaysSince(from: Date, now: Date): number {
  const day = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  let n = 0;
  for (let t = day(from) + 86_400_000; t <= day(now); t += 86_400_000) if (isBusinessDay(new Date(t))) n += 1;
  return n;
}

/** More than this many business days with no answer is overdue. */
export const ANSWER_DUE_BUSINESS_DAYS = 3;
/** Overdue files older than this are history, not a to-do. */
const WAITING_LOOKBACK_DAYS = 30;

export interface FileAnswer {
  state: AnswerState;
  /** WAITING: business days since the file went out (sent, or made for a download carrier). */
  waitingDays?: number;
  overdue?: boolean;
  /** NOT_EXPECTED: why, in words. */
  why?: string;
}

/** Where one file stands with the carrier. */
export function answerFor(
  file: { status: string; sentAt: Date | null; createdAt: Date; ackStatus: string | null },
  carrier: { transport: string },
  carrierHasAnswered: boolean,
  now: Date = new Date(),
): FileAnswer {
  if (file.ackStatus) return { state: file.ackStatus as AckStatus };
  if (file.status === 'FAILED') return { state: 'NOT_EXPECTED', why: 'The file wasn’t delivered.' };
  if (carrier.transport !== 'DOWNLOAD') {
    if (file.status !== 'SENT' || !file.sentAt) return { state: 'NOT_EXPECTED', why: 'Not sent yet.' };
    const days = businessDaysSince(file.sentAt, now);
    return { state: 'WAITING', waitingDays: days, overdue: days > ANSWER_DUE_BUSINESS_DAYS };
  }
  if (!carrierHasAnswered) return { state: 'NOT_EXPECTED', why: 'Uploaded by hand: add the carrier’s answer here if its portal gives one.' };
  const days = businessDaysSince(file.createdAt, now);
  return { state: 'WAITING', waitingDays: days, overdue: false };
}

/* ----- reading an answer in --------------------------------------------------- */


export interface IngestedAck {
  id: string;
  kind: string;
  status: string;
  controlNumber: number | null;
  fileId: string | null;
  errorCount: number;
}

const KIND_RANK: Record<string, number> = { '999': 2, '997': 2, TA1: 1 };

/** The answer that speaks for a file: the newest 999 (the transaction set) over the newest TA1 (the envelope). */
export function decidingAck<T extends { kind: string; status: string; receivedAt: Date }>(acks: T[]): T | undefined {
  return acks
    .filter((a) => a.status !== 'UNREADABLE')
    .sort((a, b) => (KIND_RANK[b.kind] ?? 0) - (KIND_RANK[a.kind] ?? 0) || b.receivedAt.getTime() - a.receivedAt.getTime())[0];
}

/** Put a file's deciding answer on it. */
export async function refreshFileAck(fileId: string): Promise<void> {
  const tenantId = tenantIdForWrite();
  const acks = await prisma.edi834Ack.findMany({ where: { tenantId, fileId, status: { not: 'UNREADABLE' } }, select: { kind: true, status: true, receivedAt: true } });
  const deciding = decidingAck(acks);
  await prisma.edi834File.updateMany({ where: { id: fileId, tenantId }, data: { ackStatus: deciding?.status ?? null, ackedAt: deciding?.receivedAt ?? null } });
}

export const uploadRef = (content: string): string => `sha256:${createHash('sha256').update(content.replace(/\s+$/, '')).digest('hex')}`;

/**
 * Read an acknowledgment file for one carrier and keep each answer in it,
 * matched to its file. Throws AckParseError (in words) when the file holds
 * no 999 or TA1. `duplicate` when this exact answer was received before:
 * nothing is written and the earlier answers are returned.
 */
export async function ingestAcknowledgment(
  carrier: { id: string },
  content: string,
  opts: { source: 'UPLOAD' | 'SFTP'; sourceRef?: string; receivedById?: string | null; now?: Date },
): Promise<{ acks: IngestedAck[]; duplicate: boolean }> {
  const tenantId = tenantIdForWrite();
  const parsed = parseAcknowledgments(content);
  const ref = opts.sourceRef ?? uploadRef(content);
  const shape = (a: { id: string; kind: string; status: string; controlNumber: number | null; fileId: string | null; errorCount: number }): IngestedAck => ({ id: a.id, kind: a.kind, status: a.status, controlNumber: a.controlNumber, fileId: a.fileId, errorCount: a.errorCount });
  const earlier = await prisma.edi834Ack.findMany({ where: { tenantId, carrierId: carrier.id, OR: [{ sourceRef: ref }, { sourceRef: { startsWith: `${ref}#` } }] }, orderBy: { receivedAt: 'asc' } });
  if (earlier.length) return { acks: earlier.map(shape), duplicate: true };

  const now = opts.now ?? new Date();
  const sealed = encryptString(content).toString('base64');
  const out: IngestedAck[] = [];
  const touched = new Set<string>();
  for (const [i, ack] of parsed.acks.entries()) {
    const file =
      ack.controlNumber !== null
        ? await prisma.edi834File.findFirst({ where: { tenantId, carrierId: carrier.id, controlNumber: ack.controlNumber }, orderBy: { createdAt: 'desc' }, select: { id: true, content: true } })
        : null;
    let errors: AckError[] = ack.errors;
    if (file && errors.some((e) => e.position)) {
      let text: string | null = null;
      try {
        text = decryptString(Buffer.from(file.content, 'base64'));
      } catch {
        text = null;
      }
      if (text) {
        errors = errors.map((e) => {
          const member = e.position ? memberAt(text!, e) : null;
          return member ? { ...e, member } : e;
        });
      }
    }
    try {
      const row = await prisma.edi834Ack.create({
        data: {
          tenantId,
          carrierId: carrier.id,
          fileId: file?.id ?? null,
          kind: ack.kind,
          status: ack.status,
          controlNumber: ack.controlNumber,
          errors: errors as unknown as Prisma.InputJsonValue,
          errorCount: errors.length,
          content: sealed,
          source: opts.source,
          sourceRef: i === 0 ? ref : `${ref}#${i + 1}`,
          receivedAt: now,
          receivedById: opts.receivedById ?? null,
        },
      });
      out.push(shape(row));
      if (file) touched.add(file.id);
    } catch (err) {
      // Two pickups of the same file at once: the other one kept it.
      if (i === 0 && err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const kept = await prisma.edi834Ack.findMany({ where: { tenantId, carrierId: carrier.id, OR: [{ sourceRef: ref }, { sourceRef: { startsWith: `${ref}#` } }] } });
        return { acks: kept.map(shape), duplicate: true };
      }
      throw err;
    }
  }
  for (const id of touched) await refreshFileAck(id);
  return { acks: out, duplicate: false };
}

/** A picked-up file that isn't an acknowledgment: kept, so it isn't read again, and shown. */
async function keepUnreadable(carrierId: string, content: string, sourceRef: string, reason: string, now: Date): Promise<void> {
  await prisma.edi834Ack.create({
    data: {
      tenantId: tenantIdForWrite(),
      carrierId,
      kind: 'UNKNOWN',
      status: 'UNREADABLE',
      errors: [{ code: 'PARSE', message: reason }] as unknown as Prisma.InputJsonValue,
      errorCount: 1,
      content: encryptString(content).toString('base64'),
      source: 'SFTP',
      sourceRef,
      receivedAt: now,
    },
  });
}

/* ----- the SFTP pickup ---------------------------------------------------------- */

export const SFTP_NOT_INSTALLED = 'SFTP isn’t installed on this server, so the carrier’s answers can’t be picked up from its folder. Upload them on Carrier feeds instead.';
/** An answer is a few kilobytes; anything past this in the folder isn't one. */
const MAX_PICKUP_BYTES = 5 * 1024 * 1024;

class PickupError extends Error {}

async function pickUpFor(carrier: { id: string; name: string }, conn: ConnectionSettings, now: Date): Promise<number> {
  const tenantId = tenantIdForWrite();
  if (!conn.host || !conn.username || !(conn.password || conn.privateKey)) throw new PickupError('The SFTP connection needs a host, a user name and a password or key.');
  const first = await prisma.edi834File.findFirst({ where: { tenantId, carrierId: carrier.id }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } });
  if (!first) return 0; // nothing made for this carrier yet, so nothing to answer
  const Client = await deliveryDeps.loadSftp();
  if (!Client) throw new PickupError(SFTP_NOT_INSTALLED);
  const client = new Client();
  const dir = (conn.inboundDir ?? '').replace(/\/+$/, '') || '/';
  const floor = first.createdAt.getTime() - 86_400_000;
  let picked = 0;
  try {
    await client.connect({ host: conn.host, port: conn.port ?? 22, username: conn.username, password: conn.password, privateKey: conn.privateKey });
    const entries = (await client.list(dir))
      .filter((e) => e.type === '-' && !e.name.startsWith('.') && e.size <= MAX_PICKUP_BYTES && !(e.modifyTime && e.modifyTime < floor))
      .sort((a, b) => (a.modifyTime ?? 0) - (b.modifyTime ?? 0) || a.name.localeCompare(b.name));
    for (const e of entries) {
      const ref = `sftp:${e.name}|${e.size}|${e.modifyTime ?? 0}`.slice(0, 590);
      const seen = await prisma.edi834Ack.findFirst({ where: { tenantId, carrierId: carrier.id, sourceRef: ref }, select: { id: true } });
      if (seen) continue;
      const body = await client.get(`${dir === '/' ? '' : dir}/${e.name}`);
      const text = Buffer.isBuffer(body) ? body.toString('utf8') : typeof body === 'string' ? body : null;
      if (text === null) continue;
      try {
        const r = await ingestAcknowledgment(carrier, text, { source: 'SFTP', sourceRef: ref, now });
        if (r.duplicate) continue;
        for (const a of r.acks) {
          enqueueAudit({ actorUserId: null, tenantId, action: 'benefits.carrier_ack_received', entityType: 'Edi834Ack', entityId: a.id, metadata: { carrierId: carrier.id, source: 'SFTP', kind: a.kind, status: a.status, controlNumber: a.controlNumber, matched: !!a.fileId } }, 'carrierAcks');
        }
      } catch (err) {
        if (!(err instanceof AckParseError)) throw err;
        await keepUnreadable(carrier.id, text, ref, `${e.name}: ${err.message}`, now);
      }
      picked += 1;
    }
  } catch (err) {
    if (err instanceof PickupError) throw err;
    if (err instanceof Prisma.PrismaClientKnownRequestError || err instanceof Prisma.PrismaClientValidationError) throw err;
    throw new PickupError(`Couldn’t read the carrier’s folder: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await client.end().catch(() => undefined);
  }
  return picked;
}

/**
 * One pass for the tenant in context: every active SFTP carrier whose
 * connection names an inbound folder. Each carrier's look is recorded
 * (ackCheckedAt, and ackCheckError in words when it failed).
 */
export async function pickUpCarrierAcks(now: Date = new Date()): Promise<{ carriers: number; picked: number; failed: number }> {
  const tenantId = tenantIdForWrite();
  const carriers = await prisma.benefitCarrier.findMany({ where: { tenantId, transport: 'SFTP', active: true, connectionEnc: { not: null } }, select: { id: true, name: true, connectionEnc: true } });
  let checked = 0;
  let picked = 0;
  let failed = 0;
  for (const c of carriers) {
    const conn = openConnection(c.connectionEnc);
    if (!conn.inboundDir) continue; // off unless an inbound folder is set
    checked += 1;
    try {
      picked += await pickUpFor(c, conn, now);
      await prisma.benefitCarrier.update({ where: { id: c.id }, data: { ackCheckedAt: now, ackCheckError: null } });
    } catch (err) {
      failed += 1;
      const message = err instanceof PickupError ? err.message : `The pickup failed: ${err instanceof Error ? err.message : String(err)}`;
      await prisma.benefitCarrier.update({ where: { id: c.id }, data: { ackCheckedAt: now, ackCheckError: message.slice(0, 500) } });
    }
  }
  return { carriers: checked, picked, failed };
}

export const CARRIER_ACK_PICKUP_JOB = 'carrierAckPickup';

/** Armed through the scheduled-jobs registry; a tick does nothing for a carrier without an inbound folder. */
export function startCarrierAckPickupCron(): void {
  armJob({
    name: CARRIER_ACK_PICKUP_JOB,
    label: 'Carrier answers to enrollment files (SFTP pickup)',
    intervalSeconds: env.CARRIER_ACK_PICKUP_INTERVAL_SECONDS,
    run: tenantJob(CARRIER_ACK_PICKUP_JOB, () => pickUpCarrierAcks()),
    immediate: false,
    note: 'CARRIER_ACK_PICKUP_INTERVAL_SECONDS; reads 999 and TA1 files from each SFTP carrier’s inbound folder. A carrier with no inbound folder is skipped.',
  });
}

export function stopCarrierAckPickupCron(): void {
  stopJob(CARRIER_ACK_PICKUP_JOB);
}

/* ----- what needs a benefits admin --------------------------------------------- */

export interface CarrierAnswersNeedingYou {
  count: number;
  rejected: number;
  waiting: number;
  preview: string[];
  carrierIds: string[];
}

/**
 * Files a carrier rejected (or partly rejected) that no newer file has
 * followed since the answer came, and files sent to an SFTP or HTTPS
 * carrier more than 3 business days ago (within the last 30 days) with no
 * answer. The Inbox item and the Carrier feeds page read the same rule.
 */
export async function carrierAnswersNeedingYou(now: Date = new Date()): Promise<CarrierAnswersNeedingYou> {
  const tenantId = tenantIdForWrite();
  const [rejectedFiles, sentFiles, newest] = await Promise.all([
    prisma.edi834File.findMany({ where: { tenantId, ackStatus: { in: ['REJECTED', 'PARTIAL'] } }, select: { carrierId: true, controlNumber: true, ackedAt: true, ackStatus: true, carrier: { select: { name: true } } }, orderBy: { ackedAt: 'desc' }, take: 500 }),
    prisma.edi834File.findMany({
      where: { tenantId, status: 'SENT', ackStatus: null, sentAt: { gte: new Date(now.getTime() - WAITING_LOOKBACK_DAYS * 86_400_000) }, carrier: { transport: { in: ['SFTP', 'HTTPS'] } } },
      select: { carrierId: true, controlNumber: true, sentAt: true, carrier: { select: { name: true } } },
      orderBy: { sentAt: 'asc' },
      take: 500,
    }),
    prisma.edi834File.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' }, distinct: ['carrierId'], select: { carrierId: true, createdAt: true } }),
  ]);
  const newestAt = new Map(newest.map((f) => [f.carrierId, f.createdAt.getTime()]));
  const rejected = rejectedFiles.filter((f) => !(f.ackedAt && (newestAt.get(f.carrierId) ?? 0) > f.ackedAt.getTime()));
  const waiting = sentFiles
    .map((f) => ({ ...f, days: businessDaysSince(f.sentAt!, now) }))
    .filter((f) => f.days > ANSWER_DUE_BUSINESS_DAYS);
  const preview = [
    ...rejected.map((f) => `${f.carrier.name} · control ${f.controlNumber} ${f.ackStatus === 'PARTIAL' ? 'partly rejected' : 'rejected'}`),
    ...waiting.map((f) => `${f.carrier.name} · control ${f.controlNumber}: no answer in ${f.days} business days`),
  ];
  return {
    count: rejected.length + waiting.length,
    rejected: rejected.length,
    waiting: waiting.length,
    preview,
    carrierIds: [...new Set([...rejected, ...waiting].map((f) => f.carrierId))],
  };
}
