import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { enqueueAudit } from './audit.js';
import { getBlobStore, tenantBlobKey } from './blobStore.js';
import { getBrandingSync } from './branding.js';
import { hashSignedPdf, renderSignedAgreement } from './esign.js';
import { RIDE_AUTHORIZATION_VERSION, rideAuthorizationBody, rideAuthorizationTitle, toRideAuthLang, type RideAuthLang } from './rideAuthorizationContent.js';
import { tenantIdForWrite } from './tenant.js';
import { fmtDay } from './humanDates.js';

/**
 * Van ride charge authorization (Brief 1A-3).
 *
 *   An associate is charged for a ride only with a signed written
 *   authorization on file that names the rate in force. Signing rides the
 *   e-sign rails: the typed name, the rendered PDF, its hash, a
 *   DocumentRecord and a Signature row. The authorization is current when
 *   it is signed, not withdrawn, on the current version of the words, and
 *   names the fare and fee in force on the day in question. A rate change
 *   or a wording change therefore asks every rider to sign again before
 *   any new ride is charged.
 *
 *   Rates are effective-dated (TransportRate): a change never reprices a
 *   past ride.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export interface RideRate {
  id: string;
  fareCents: number;
  noShowFeeCents: number;
  effectiveFrom: string;
  effectiveTo: string | null;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const dateOnly = (s: string) => new Date(`${s}T00:00:00.000Z`);

function toRate(r: { id: string; fareCents: number; noShowFeeCents: number; effectiveFrom: Date; effectiveTo: Date | null }): RideRate {
  return { id: r.id, fareCents: r.fareCents, noShowFeeCents: r.noShowFeeCents, effectiveFrom: ymd(r.effectiveFrom), effectiveTo: r.effectiveTo ? ymd(r.effectiveTo) : null };
}

/** The rate in force on a date (today by default). Null when none has been set. */
export async function rideRateOn(db: Db, on: Date = new Date()): Promise<RideRate | null> {
  const day = dateOnly(ymd(on));
  const row = await db.transportRate.findFirst({
    where: { effectiveFrom: { lte: day }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: day } }] },
    orderBy: { effectiveFrom: 'desc' },
  });
  if (row) return toRate(row);
  // No rate at all yet (a fresh database): the first one comes from the
  // settings row, dated so every ride on file falls under it — the same
  // seed the migration wrote.
  if ((await db.transportRate.count()) === 0) {
    const settings = await db.transportSettings.findUnique({ where: { tenantId: tenantIdForWrite() } });
    const seeded = await db.transportRate.create({
      data: { fareCents: settings?.fareCents ?? 500, noShowFeeCents: settings?.noShowFeeCents ?? 100, effectiveFrom: dateOnly('2024-01-01') },
    });
    return ymd(seeded.effectiveFrom) <= ymd(day) ? toRate(seeded) : null;
  }
  return null;
}

export async function rideRateHistory(db: Db): Promise<RideRate[]> {
  return (await db.transportRate.findMany({ orderBy: { effectiveFrom: 'desc' } })).map(toRate);
}

/** A new rate from a date; the rate before it ends the day before. History is never rewritten. */
export async function setRideRate(db: Db, input: { fareCents: number; noShowFeeCents: number; effectiveFrom?: string }, actorUserId: string, now: Date = new Date()): Promise<RideRate> {
  const from = input.effectiveFrom ?? ymd(now);
  const current = await db.transportRate.findFirst({ where: { effectiveTo: null }, orderBy: { effectiveFrom: 'desc' } });
  if (current && ymd(current.effectiveFrom) > from) {
    throw new HttpError(409, 'rate_history', `A rate already starts ${fmtDay(current.effectiveFrom, { year: true })}; a new rate cannot start before it.`);
  }
  let row;
  if (current && ymd(current.effectiveFrom) === from) {
    row = await db.transportRate.update({ where: { id: current.id }, data: { fareCents: input.fareCents, noShowFeeCents: input.noShowFeeCents } });
  } else {
    if (current) await db.transportRate.update({ where: { id: current.id }, data: { effectiveTo: new Date(dateOnly(from).getTime() - 86_400_000) } });
    row = await db.transportRate.create({ data: { fareCents: input.fareCents, noShowFeeCents: input.noShowFeeCents, effectiveFrom: dateOnly(from), createdById: actorUserId } });
  }
  // The settings row mirrors the rate in force today so older readers keep working.
  const today = await rideRateOn(db, now);
  if (today) await db.transportSettings.upsert({ where: { tenantId: tenantIdForWrite() }, create: { tenantId: tenantIdForWrite(), fareCents: today.fareCents, noShowFeeCents: today.noShowFeeCents }, update: { fareCents: today.fareCents, noShowFeeCents: today.noShowFeeCents } });
  enqueueAudit({ actorUserId, clientId: null, action: 'transport.rate_set', entityType: 'TransportRate', entityId: row.id, metadata: { fareCents: input.fareCents, noShowFeeCents: input.noShowFeeCents, effectiveFrom: from } }, 'transport');
  return toRate(row);
}

export interface RideAuthorizationStatus {
  /** Signed, not withdrawn, current words, and the rate in force today. */
  current: boolean;
  signedAt: string | null;
  signedName: string | null;
  version: number | null;
  fareCents: number | null;
  noShowFeeCents: number | null;
  withdrawnAt: string | null;
  documentId: string | null;
  /** Why it is not current, in words, or null. */
  reason: string | null;
  /** The words to sign now, in the associate's language, with the rate in force. */
  agreement: { title: string; body: string; version: number; lang: RideAuthLang; fareCents: number; noShowFeeCents: number } | null;
}

/** Taken rides whose fare is held for the rider's signature (lib/transport rideHeldForSignature). */
export const HELD_FOR_SIGNATURE = (associateId: string): Prisma.RideWhereInput => ({
  associateId,
  status: { in: ['BOARDED', 'COMPLETED'] },
  chargeCents: { gt: 0 },
  waivedAt: null,
  chargedRunId: null,
  authorizedSignatureId: null,
});

async function consentRow(db: Db, associateId: string) {
  return db.rideConsent.findUnique({ where: { associateId } });
}

/** Is the associate's authorization good for a ride at `rate` on `on`? */
export function authorizationCovers(
  c: { signatureId: string | null; withdrawnAt: Date | null; version: number | null; fareCents: number; noShowFeeCents: number; acceptedAt: Date } | null,
  rate: { fareCents: number; noShowFeeCents: number } | null,
  on: Date,
): { ok: boolean; reason: string | null } {
  if (!c || !c.signatureId) return { ok: false, reason: 'No signed authorization on file.' };
  if (c.withdrawnAt && c.withdrawnAt <= on) return { ok: false, reason: `Authorization withdrawn ${fmtDay(c.withdrawnAt, { year: true })}.` };
  if (c.version !== RIDE_AUTHORIZATION_VERSION) return { ok: false, reason: 'The authorization wording changed; a new signature is needed.' };
  if (c.acceptedAt > on) return { ok: false, reason: 'Signed after the ride.' };
  if (!rate) return { ok: false, reason: 'No ride rate is set.' };
  // The signature authorizes deductions UP TO the amounts signed for: a ride
  // booked at a lower fare (or a rate that went down) is still covered; a
  // higher one needs a new signature.
  if (rate.fareCents > c.fareCents || rate.noShowFeeCents > c.noShowFeeCents) return { ok: false, reason: 'The rate went up since it was signed; a new signature is needed.' };
  return { ok: true, reason: null };
}

export async function rideAuthorizationStatus(db: Db, associate: { id: string; language?: string | null }, now: Date = new Date()): Promise<RideAuthorizationStatus> {
  const [c, rate] = await Promise.all([consentRow(db, associate.id), rideRateOn(db, now)]);
  const check = authorizationCovers(c, rate, now);
  const lang = toRideAuthLang(associate.language);
  const orgName = getBrandingSync().orgName;
  return {
    current: check.ok,
    signedAt: c?.signatureId ? c.acceptedAt.toISOString() : null,
    signedName: c?.signedName ?? null,
    version: c?.signatureId ? c.version : null,
    fareCents: c?.signatureId ? c.fareCents : null,
    noShowFeeCents: c?.signatureId ? c.noShowFeeCents : null,
    withdrawnAt: c?.withdrawnAt?.toISOString() ?? null,
    documentId: c?.documentId ?? null,
    reason: check.reason,
    agreement: rate ? { title: rideAuthorizationTitle(lang), body: rideAuthorizationBody(lang, { fareCents: rate.fareCents, noShowFeeCents: rate.noShowFeeCents, orgName }), version: RIDE_AUTHORIZATION_VERSION, lang, fareCents: rate.fareCents, noShowFeeCents: rate.noShowFeeCents } : null,
  };
}

/** True when the associate may be charged for a ride on `on` at the ride's own rate. */
export async function rideChargeAuthorized(db: Db, associateId: string, ride: { fareCents: number; noShowFeeCents: number }, on: Date): Promise<{ ok: boolean; reason: string | null; version: number | null }> {
  const c = await consentRow(db, associateId);
  const check = authorizationCovers(c, ride, on);
  return { ...check, version: c?.version ?? null };
}

/**
 * Sign: render the PDF with the typed name, store it, keep the document and
 * the signature, and make the authorization current for the rate in force.
 */
export async function signRideAuthorization(
  db: PrismaClient,
  input: { associateId: string; userId: string; typedName: string; language?: string | null; ipAddress: string | null; userAgent: string | null },
  now: Date = new Date(),
): Promise<RideAuthorizationStatus> {
  const typedName = input.typedName.trim();
  if (typedName.length < 2 || typedName.length > 200) throw new HttpError(400, 'invalid_typed_name', 'Type your full name to sign.');
  const [associate, rate] = await Promise.all([
    db.associate.findUnique({ where: { id: input.associateId }, select: { id: true, firstName: true, lastName: true, email: true } }),
    rideRateOn(db, now),
  ]);
  if (!associate) throw new HttpError(404, 'associate_not_found', 'No such associate.');
  if (!rate) throw new HttpError(409, 'no_ride_rate', 'No ride rate is set yet; ask the transportation director.');
  const lang = toRideAuthLang(input.language);
  const orgName = getBrandingSync().orgName;
  const title = rideAuthorizationTitle(lang);
  const body = rideAuthorizationBody(lang, { fareCents: rate.fareCents, noShowFeeCents: rate.noShowFeeCents, orgName });
  const agreementId = `ride-authorization-v${RIDE_AUTHORIZATION_VERSION}-${rate.id}`;
  const pdf = await renderSignedAgreement({
    agreement: { id: agreementId, title, body },
    signer: { fullName: `${associate.firstName} ${associate.lastName}`, email: associate.email },
    signedAt: now,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
    typedName,
  });
  const pdfHash = hashSignedPdf(pdf);
  const relativeKey = tenantBlobKey(`esign/ride-authorization/${associate.id}/${pdfHash.slice(0, 16)}.pdf`);
  await getBlobStore().put(relativeKey, pdf, 'application/pdf');

  let released = { count: 0 };
  await db.$transaction(async (tx) => {
    const doc = await tx.documentRecord.create({
      data: {
        associateId: associate.id,
        kind: 'SIGNED_AGREEMENT',
        s3Key: relativeKey,
        filename: `van-ride-authorization-v${RIDE_AUTHORIZATION_VERSION}.pdf`,
        mimeType: 'application/pdf',
        size: pdf.byteLength,
        status: 'VERIFIED',
        verifiedById: input.userId,
        verifiedAt: now,
      },
    });
    const sig = await tx.signature.create({
      data: { documentId: doc.id, signerUserId: input.userId, associateId: associate.id, signedAt: now, ipAddress: input.ipAddress, userAgent: input.userAgent, signatureS3Key: relativeKey, typedName, pdfHash },
    });
    await tx.rideConsent.upsert({
      where: { associateId: associate.id },
      create: { associateId: associate.id, fareCents: rate.fareCents, noShowFeeCents: rate.noShowFeeCents, acceptedAt: now, ip: input.ipAddress, signatureId: sig.id, documentId: doc.id, version: RIDE_AUTHORIZATION_VERSION, signedName: typedName, rateId: rate.id, withdrawnAt: null },
      update: { fareCents: rate.fareCents, noShowFeeCents: rate.noShowFeeCents, acceptedAt: now, ip: input.ipAddress, signatureId: sig.id, documentId: doc.id, version: RIDE_AUTHORIZATION_VERSION, signedName: typedName, rateId: rate.id, withdrawnAt: null },
    });
    // Item 5: rides taken while no authorization covered them were held, not
    // waived — this signature lets payroll take them, at the price booked.
    released = await tx.ride.updateMany({ where: HELD_FOR_SIGNATURE(associate.id), data: { authorizedSignatureId: sig.id } });
  });
  enqueueAudit(
    { actorUserId: input.userId, clientId: null, action: 'transport.authorization_signed', entityType: 'Associate', entityId: associate.id, metadata: { version: RIDE_AUTHORIZATION_VERSION, fareCents: rate.fareCents, noShowFeeCents: rate.noShowFeeCents, lang, pdfHash, heldRidesReleased: released.count } },
    'transport',
  );
  return rideAuthorizationStatus(db, { id: associate.id, language: input.language }, now);
}

/** Withdraw: no new ride is booked or charged; rides already taken are still owed. */
export async function withdrawRideAuthorization(db: Db, associateId: string, userId: string, now: Date = new Date()): Promise<void> {
  const c = await consentRow(db, associateId);
  if (!c || !c.signatureId) throw new HttpError(404, 'no_authorization', 'There is no authorization to withdraw.');
  if (c.withdrawnAt) throw new HttpError(409, 'already_withdrawn', 'Already withdrawn.');
  await db.rideConsent.update({ where: { associateId }, data: { withdrawnAt: now } });
  enqueueAudit({ actorUserId: userId, clientId: null, action: 'transport.authorization_withdrawn', entityType: 'Associate', entityId: associateId, metadata: { version: c.version } }, 'transport');
}

export { defaultPrisma as rideAuthorizationDb };

/**
 * Which of these upcoming rides would go uncharged today for want of a
 * current signed authorization covering their fare — so the driver and
 * transportation see it before the rider boards, and the rider can be
 * asked to sign. One query for all the riders.
 */
export async function ridesNeedingSignature(
  db: Db,
  rides: Array<{ id: string; associateId: string; fareCents: number; noShowFeeCents: number; status: string }>,
  now: Date = new Date(),
): Promise<Map<string, string>> {
  const open = rides.filter((r) => r.status === 'REQUESTED' || r.status === 'SCHEDULED');
  const out = new Map<string, string>();
  if (open.length === 0) return out;
  const consents = await db.rideConsent.findMany({ where: { associateId: { in: [...new Set(open.map((r) => r.associateId))] } } });
  const byAssociate = new Map(consents.map((c) => [c.associateId, c]));
  for (const r of open) {
    // A free ride (an evacuation) needs nothing signed.
    if (r.fareCents === 0 && r.noShowFeeCents === 0) continue;
    const check = authorizationCovers(byAssociate.get(r.associateId) ?? null, r, now);
    if (!check.ok) out.set(r.id, check.reason ?? 'No signed authorization on file.');
  }
  return out;
}

/** The people who still need to sign: anyone with an open ride in the next `days` whose authorization doesn't cover it. */
export async function ridersNeedingSignature(db: Db, now: Date = new Date(), days = 14) {
  const rides = await db.ride.findMany({
    where: { status: { in: ['REQUESTED', 'SCHEDULED'] }, targetAt: { gte: new Date(now.getTime() - 3_600_000), lt: new Date(now.getTime() + days * 86_400_000) } },
    select: { id: true, associateId: true, fareCents: true, noShowFeeCents: true, status: true, targetAt: true, associate: { select: { firstName: true, lastName: true, user: { select: { id: true } } } } },
    orderBy: { targetAt: 'asc' },
  });
  const need = await ridesNeedingSignature(db, rides, now);
  const people = new Map<string, { associateId: string; name: string; userId: string | null; nextRideAt: string | null; rides: number; reason: string; atRiskCents: number; heldCents: number; heldRides: number }>();
  for (const r of rides) {
    const reason = need.get(r.id);
    if (!reason) continue;
    const p = people.get(r.associateId) ?? { associateId: r.associateId, name: `${r.associate.firstName} ${r.associate.lastName}`, userId: r.associate.user?.id ?? null, nextRideAt: r.targetAt.toISOString(), rides: 0, reason, atRiskCents: 0, heldCents: 0, heldRides: 0 };
    p.rides += 1;
    p.atRiskCents += r.fareCents;
    people.set(r.associateId, p);
  }
  // …and everyone with a fare already held for their signature, upcoming rides or not.
  const held = await db.ride.findMany({
    where: { status: { in: ['BOARDED', 'COMPLETED'] }, chargeCents: { gt: 0 }, waivedAt: null, chargedRunId: null, authorizedSignatureId: null },
    select: { associateId: true, chargeCents: true, associate: { select: { firstName: true, lastName: true, user: { select: { id: true } } } } },
  });
  for (const r of held) {
    const p = people.get(r.associateId) ?? { associateId: r.associateId, name: `${r.associate.firstName} ${r.associate.lastName}`, userId: r.associate.user?.id ?? null, nextRideAt: null, rides: 0, reason: 'Rides taken are held until they sign.', atRiskCents: 0, heldCents: 0, heldRides: 0 };
    p.heldCents += r.chargeCents;
    p.heldRides += 1;
    people.set(r.associateId, p);
  }
  return [...people.values()];
}
