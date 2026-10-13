import type { Prisma, PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';
import { prisma as defaultPrisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { enqueueAudit } from './audit.js';
import { placements } from './activeDefinition.js';

/**
 * Rate cards (Brief 1A-2): one effective-dated pay and bill rate per
 * client and role. The table is ShiftRateDefault, which used to hold one
 * undated row per (client, position); it now holds a history, and the
 * row in force on a date is the one whose [effectiveFrom, effectiveTo]
 * contains it. Every screen that prices a shift, an hour or a statement
 * resolves through here: the card for the role, else the org standard
 * from the environment (named as such), else nothing.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export interface RateCard {
  id: string;
  /** Null = an org-wide card (a direct employer's own rates, Brief 2-1b). */
  clientId: string | null;
  position: string;
  payRate: number;
  billRate: number | null;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface ResolvedRate {
  payRate: number | null;
  billRate: number | null;
  source: 'explicit' | 'card' | 'standard' | 'none';
  cardId: string | null;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const dateOnly = (s: string) => new Date(`${s}T00:00:00.000Z`);

function toCard(r: { id: string; clientId: string | null; position: string; payRate: Prisma.Decimal; billRate: Prisma.Decimal | null; effectiveFrom: Date; effectiveTo: Date | null }): RateCard {
  return { id: r.id, clientId: r.clientId, position: r.position, payRate: Number(r.payRate), billRate: r.billRate == null ? null : Number(r.billRate), effectiveFrom: ymd(r.effectiveFrom), effectiveTo: r.effectiveTo ? ymd(r.effectiveTo) : null };
}

/** Every card of these clients, newest first — the resolver picks by date in memory. */
export async function loadRateCards(db: Db, clientIds: Array<string | null>): Promise<RateCard[]> {
  const ids = [...new Set(clientIds.filter((id): id is string => id !== null))];
  // A null client (a direct employer's shift) reads the org-wide cards.
  const orgWide = clientIds.includes(null);
  if (ids.length === 0 && !orgWide) return [];
  const rows = await db.shiftRateDefault.findMany({
    where: { OR: [...(ids.length ? [{ clientId: { in: ids } }] : []), ...(orgWide ? [{ clientId: null }] : [])] },
    orderBy: [{ clientId: 'asc' }, { position: 'asc' }, { effectiveFrom: 'desc' }],
  });
  return rows.map(toCard);
}

/** The card in force for (client, position) on a date, from a loaded list. */
export function cardOn(cards: RateCard[], clientId: string | null, position: string, on: Date): RateCard | null {
  const day = ymd(on);
  for (const c of cards) {
    if (c.clientId !== clientId || c.position !== position) continue;
    if (c.effectiveFrom <= day && (c.effectiveTo === null || c.effectiveTo >= day)) return c;
  }
  return null;
}

/** The cards in force today for a client, one per position. */
export async function currentRateCards(db: Db, clientId: string, on: Date = new Date()): Promise<RateCard[]> {
  const cards = await loadRateCards(db, [clientId]);
  const out = new Map<string, RateCard>();
  for (const c of cards) {
    if (out.has(c.position)) continue;
    const hit = cardOn(cards, clientId, c.position, on);
    if (hit) out.set(c.position, hit);
  }
  return [...out.values()].sort((a, b) => a.position.localeCompare(b.position));
}

/** Pay and bill for a shift: explicit rate, else the card, else the org standard by lead flag. */
export function resolveRate(cards: RateCard[], shift: { clientId: string; position: string; startsAt: Date; payRate?: number | null; isLead?: boolean }): ResolvedRate {
  const card = cardOn(cards, shift.clientId, shift.position, shift.startsAt);
  if (shift.payRate != null) return { payRate: shift.payRate, billRate: card?.billRate ?? null, source: 'explicit', cardId: card?.id ?? null };
  if (card) return { payRate: card.payRate, billRate: card.billRate, source: 'card', cardId: card.id };
  const pay = shift.isLead ? env.DEFAULT_LEAD_PAY_RATE : env.DEFAULT_ASSOCIATE_PAY_RATE;
  const bill = shift.isLead ? env.DEFAULT_LEAD_BILL_RATE : env.DEFAULT_ASSOCIATE_BILL_RATE;
  if (pay > 0) return { payRate: pay, billRate: bill > 0 ? bill : null, source: 'standard', cardId: null };
  return { payRate: null, billRate: null, source: 'none', cardId: null };
}

export interface RateCardInput {
  clientId: string;
  position: string;
  payRate: number;
  billRate: number | null;
  /** YYYY-MM-DD; today when absent. */
  effectiveFrom?: string;
}

/**
 * Set the rate from a date. The card in force before it is closed the day
 * before; a card starting the same day is replaced in place. History is
 * never rewritten: the date may not fall before the current card's start.
 */
export async function setRateCard(db: Db, input: RateCardInput, actorUserId: string, now: Date = new Date()): Promise<RateCard> {
  const from = input.effectiveFrom ?? ymd(now);
  const current = await db.shiftRateDefault.findFirst({
    where: { clientId: input.clientId, position: input.position, effectiveTo: null },
    orderBy: { effectiveFrom: 'desc' },
  });
  const effectiveFrom = dateOnly(from);
  if (current && ymd(current.effectiveFrom) > from) {
    throw new HttpError(409, 'rate_card_history', `A rate for ${input.position} already starts ${ymd(current.effectiveFrom)}; a new rate cannot start before it.`);
  }
  let row;
  if (current && ymd(current.effectiveFrom) === from) {
    row = await db.shiftRateDefault.update({ where: { id: current.id }, data: { payRate: input.payRate, billRate: input.billRate } });
  } else {
    if (current) {
      const dayBefore = new Date(effectiveFrom.getTime() - 86_400_000);
      await db.shiftRateDefault.update({ where: { id: current.id }, data: { effectiveTo: dayBefore } });
    }
    row = await db.shiftRateDefault.create({
      data: { clientId: input.clientId, position: input.position, payRate: input.payRate, billRate: input.billRate, effectiveFrom, createdById: actorUserId },
    });
  }
  enqueueAudit(
    { actorUserId, clientId: input.clientId, action: 'scheduling.rate_default_upserted', entityType: 'ShiftRateDefault', entityId: row.id, metadata: { position: input.position, payRate: input.payRate, billRate: input.billRate, effectiveFrom: from, closed: current && ymd(current.effectiveFrom) !== from ? current.id : null } },
    'rateCards',
  );
  return toCard(row);
}

/**
 * End a card as of a date (today by default): its last day in force is the
 * day before. A card ended on the day it started never priced a day, so
 * that one is removed outright; every other card stays as history.
 * The caller writes the audit line.
 */
export async function endRateCard(db: Db, id: string, on: Date = new Date()): Promise<RateCard | null> {
  const row = await db.shiftRateDefault.findUnique({ where: { id } });
  if (!row) throw new HttpError(404, 'rate_default_not_found', 'Rate card not found.');
  if (row.effectiveTo) throw new HttpError(409, 'rate_card_ended', `This rate already ended ${ymd(row.effectiveTo)}.`);
  const lastDay = new Date(dateOnly(ymd(on)).getTime() - 86_400_000);
  if (lastDay < row.effectiveFrom) {
    await db.shiftRateDefault.delete({ where: { id } });
    return null;
  }
  return toCard(await db.shiftRateDefault.update({ where: { id }, data: { effectiveTo: lastDay } }));
}

export interface WithoutRate {
  associateId: string;
  name: string;
  clientId: string | null;
  clientName: string;
  locationId: string | null;
  position: string | null;
}

/**
 * The flag the brief asks for: every placed associate whose role has no
 * rate card at their client today (or who has no role on file at all).
 */
export async function associatesWithoutRate(db: Db = defaultPrisma, now: Date = new Date()): Promise<WithoutRate[]> {
  const placed = await placements({}, db);
  if (placed.size === 0) return [];
  const ids = [...placed.keys()];
  const clientIds = [...new Set([...placed.values()].map((p) => p.clientId))];
  const [people, cards, clients] = await Promise.all([
    db.associate.findMany({
      where: { id: { in: ids } },
      select: { id: true, firstName: true, lastName: true, applications: { where: { status: 'APPROVED', deletedAt: null }, orderBy: { approvedAt: 'desc' }, take: 1, select: { position: true } } },
    }),
    loadRateCards(db, clientIds),
    db.client.findMany({ where: { id: { in: clientIds.filter((id): id is string => id !== null) } }, select: { id: true, name: true } }),
  ]);
  const clientName = new Map(clients.map((c) => [c.id, c.name]));
  const out: WithoutRate[] = [];
  for (const p of people) {
    const placement = placed.get(p.id)!;
    const position = p.applications[0]?.position ?? null;
    if (position && cardOn(cards, placement.clientId, position, now)) continue;
    // A client-less placement (a direct employer): the org-wide card was checked above; the row names no client.
    out.push({ associateId: p.id, name: `${p.firstName} ${p.lastName}`.trim(), clientId: placement.clientId, clientName: (placement.clientId ? clientName.get(placement.clientId) : undefined) ?? '', locationId: placement.locationId, position });
  }
  return out.sort((a, b) => a.clientName.localeCompare(b.clientName) || a.name.localeCompare(b.name));
}
