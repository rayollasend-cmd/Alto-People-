import { createHash, randomBytes } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { getBlobStore } from './blobStore.js';
import { hashSignedPdf, renderSignedAgreement } from './esign.js';

/**
 * A candidate's offer: what it pays, whether that pay needs approval, the
 * letter it is written from, and the signature that accepts it.
 *
 * An offer used to be a record plus a plain-text email. Nothing checked
 * its pay against the client's band, the candidate "accepted" by replying
 * and a recruiter clicking Accepted on their behalf, and nothing was
 * signed. These are the pieces that change that.
 */

type Money = Prisma.Decimal | number | string;

/** "$16.50 per hour" / "$42,000.00 per year". */
export function offerPay(o: { hourlyRate: Money | null; salary: Money | null; currency: string }): string {
  const fmt = (n: Money) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: o.currency || 'USD' }).format(Number(n));
  if (o.hourlyRate != null) return `${fmt(o.hourlyRate)} per hour`;
  if (o.salary != null) return `${fmt(o.salary)} per year`;
  return 'to be discussed';
}

/** "Monday, October 5, 2026" — a start date, as a letter says it. */
export function letterDate(ymd: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(ymd);
}

/**
 * What an offer-letter template can say. `associate.*` mirrors
 * `candidate.*` so the templates HR already wrote for new hires — which
 * speak of {{associate.firstName}} — render for a candidate unchanged.
 */
export function offerLetterContext(input: {
  candidate: { firstName: string; lastName: string; email: string; phone: string | null };
  offer: {
    jobTitle: string;
    startDate: Date;
    hourlyRate: Money | null;
    salary: Money | null;
    currency: string;
  };
  clientName: string;
}): Record<string, unknown> {
  const person = {
    ...input.candidate,
    fullName: `${input.candidate.firstName} ${input.candidate.lastName}`,
    jobTitle: input.offer.jobTitle,
  };
  return {
    candidate: person,
    associate: person,
    offer: {
      jobTitle: input.offer.jobTitle,
      startDate: letterDate(input.offer.startDate),
      pay: offerPay(input.offer),
      hourlyRate: input.offer.hourlyRate?.toString() ?? null,
      salary: input.offer.salary?.toString() ?? null,
      currency: input.offer.currency,
    },
    client: { name: input.clientName },
    today: letterDate(new Date(new Date().toISOString().slice(0, 10))),
  };
}

export interface BandCheck {
  band: { name: string; min: number; max: number; payType: 'HOURLY' | 'SALARY' } | null;
  /** Set when the pay falls outside the band: why it needs approval. */
  outsideNote: string | null;
}

/**
 * The client's pay band for this job, and whether the offer is inside it.
 *
 * A band is matched by name to the job title (or to its job profile's
 * title); failing that, a client with exactly one band for this pay type
 * uses it. No band means nothing to check against — never a reason to
 * hold the offer.
 */
export async function checkBand(input: {
  clientId: string;
  jobTitle: string;
  payType: 'HOURLY' | 'SALARY';
  amount: number;
  currency: string;
}): Promise<BandCheck> {
  const now = new Date();
  const bands = await prisma.compBand.findMany({
    where: {
      clientId: input.clientId,
      payType: input.payType,
      deletedAt: null,
      effectiveFrom: { lte: now },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
    },
    include: { jobProfile: { select: { title: true } } },
  });
  const title = input.jobTitle.trim().toLowerCase();
  const pick =
    bands.find((b) => b.name.trim().toLowerCase() === title) ??
    bands.find((b) => b.jobProfile?.title.trim().toLowerCase() === title) ??
    (bands.length === 1 ? bands[0] : undefined);
  if (!pick) return { band: null, outsideNote: null };
  const min = Number(pick.minAmount);
  const max = Number(pick.maxAmount);
  const band = { name: pick.name, min, max, payType: input.payType };
  if (input.amount >= min && input.amount <= max) return { band, outsideNote: null };
  const unit = input.payType === 'HOURLY' ? '/hr' : '/yr';
  const f = (n: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: input.currency || 'USD' }).format(n);
  return {
    band,
    outsideNote: `${f(input.amount)}${unit} is ${input.amount > max ? 'above' : 'below'} the ${pick.name} band (${f(min)}–${f(max)}${unit}).`,
  };
}

/* ----- The candidate's link ----------------------------------------------- */

export function hashAcceptToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** A fresh private link token: the raw value goes in the email, only its
 *  hash is stored — the same posture as invite and reset links. */
export function mintAcceptToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('base64url');
  return { raw, hash: hashAcceptToken(raw) };
}

/** How long an offer link lasts when the offer set no expiry of its own. */
export const DEFAULT_OFFER_DAYS = 14;

/* ----- The signature ------------------------------------------------------ */

/**
 * Render the accepted letter as a signed PDF — the in-house e-sign
 * renderer, with its audit panel of typed name, time, IP and browser —
 * and store it. Returns the blob key and the PDF's sha256.
 */
export async function renderSignedOffer(input: {
  offerId: string;
  title: string;
  body: string;
  signer: { fullName: string; email: string };
  typedName: string;
  signedAt: Date;
  ip: string | null;
  userAgent: string | null;
}): Promise<{ key: string; hash: string; pdf: Buffer }> {
  const pdf = await renderSignedAgreement({
    agreement: { id: input.offerId, title: input.title, body: input.body },
    signer: { fullName: input.signer.fullName, email: input.signer.email },
    signedAt: input.signedAt,
    ipAddress: input.ip,
    userAgent: input.userAgent,
    typedName: input.typedName,
  });
  const key = `offers/${input.offerId}-signed.pdf`;
  await getBlobStore().put(key, pdf, 'application/pdf');
  return { key, hash: hashSignedPdf(pdf), pdf };
}
