import type { Role } from '@alto-people/shared';
import { env } from '../config/env.js';
import { prisma } from '../db.js';
import { tenantIdForWrite } from './tenant.js';
import { hugoDay, type HugoLang } from './hugoWorkCopy.js';
import { companyWorkweek, orgDateKey } from './timeAnomalies.js';
import { zonedWallTimeToUtcInstant } from './timezone.js';

/**
 * Each person's allowance for Hugo's thinking (owner, 2026-10-29): every
 * account has its own Hugo, and what his model calls cost is charged to the
 * person they were for — a chat answer, a goal's step, a recurring brief,
 * a WhatsApp reply.
 *
 *   floor  associates, drivers, floor and shift supervisors: $1 a cycle of
 *          30 days, the cycle beginning with their first use — used up,
 *          they wait for the cycle to end. (An associate's Hugo makes no
 *          model calls at all: modelServes below.)
 *   staff  everyone else Hugo serves (the office): $10 a calendar month in
 *          the company's zone — used up, they wait for the next month.
 *
 * Used up, the registry still answers the basics (payday, shifts, ride,
 * documents, the desk): those cost nothing. The amounts and the prices are
 * settings (HUGO_ALLOWANCE_*_USD, HUGO_PRICE_*); the prices default to the
 * provider's peak rates, so the allowance never under-counts. A call is
 * allowed while anything is left, so the last one may overshoot by its own
 * cost (a cent or so).
 */

export type AllowanceClass = 'floor' | 'staff';
export type ModelPurpose = 'chat' | 'goal' | 'recurring' | 'whatsapp';
/** Whose allowance a model call is charged to, and what for. */
export interface ModelMeter {
  userId: string;
  purpose: ModelPurpose;
}

const FLOOR_ROLES: ReadonlySet<Role> = new Set<Role>(['ASSOCIATE', 'DRIVER', 'SHIFT_SUPERVISOR', 'FLOOR_SUPERVISOR']);
export const allowanceClassOf = (role: Role): AllowanceClass => (FLOOR_ROLES.has(role) ? 'floor' : 'staff');

/**
 * Whose Hugo never calls the model (owner, 2026-10-30: "the associates Hugo
 * should not be connected to deep seek"): an account whose role, or the hat
 * it is wearing, is in HUGO_MODEL_OFF_ROLES — associates by default. The
 * registry answers them everywhere (the app, WhatsApp, their repeats) and
 * nothing of theirs reaches the provider. Every way in checks it
 * (modelAvailableFor), and runModelLoop again before any call
 * (HugoNoModelError). Read per call, so a changed setting applies at once.
 */
export function modelServes(...roles: Array<Role | null | undefined>): boolean {
  const off = new Set(env.HUGO_MODEL_OFF_ROLES.split(',').map((r) => r.trim()).filter(Boolean));
  return !roles.some((r) => r && off.has(r));
}

/** Thrown before a model call for someone whose Hugo never uses it (modelServes); nothing was sent. */
export class HugoNoModelError extends Error {
  constructor() {
    super('This person’s Hugo answers without the model.');
    this.name = 'HugoNoModelError';
  }
}

const CYCLE_MS = 30 * 86_400_000;
/** One US dollar, in the ledger's unit (millionths). */
export const MICROS_PER_USD = 1_000_000;

/** Thrown before a model call when the person's allowance is used up; the caller falls back to the registry. */
export class HugoAllowanceError extends Error {
  constructor(readonly renewsAt: Date) {
    super('This period’s allowance for Hugo’s thinking is used up.');
    this.name = 'HugoAllowanceError';
  }
}

export interface AllowanceStatus {
  allowanceClass: AllowanceClass;
  capMicros: number;
  spentMicros: number;
  periodStart: Date;
  renewsAt: Date;
  exhausted: boolean;
}

/** The company's calendar month around `now`: its first midnight, and the next month's. */
function monthIn(now: Date): { start: Date; renewsAt: Date } {
  const tz = companyWorkweek().timezone;
  const [y, m] = orgDateKey(now).split('-').map(Number) as [number, number];
  const next = m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 };
  return { start: zonedWallTimeToUtcInstant(y, m, 1, 0, tz), renewsAt: zonedWallTimeToUtcInstant(next.y, next.m, 1, 0, tz) };
}

/** Where the person's allowance stands now. A floor cycle that ended (or never began) starts at the next use. */
export async function allowanceStatus(userId: string, now: Date = new Date()): Promise<AllowanceStatus> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  const allowanceClass = allowanceClassOf((user?.role ?? 'ASSOCIATE') as Role);
  const capMicros = Math.round((allowanceClass === 'floor' ? env.HUGO_ALLOWANCE_FLOOR_USD : env.HUGO_ALLOWANCE_STAFF_USD) * MICROS_PER_USD);
  let periodStart: Date;
  let renewsAt: Date;
  if (allowanceClass === 'staff') {
    ({ start: periodStart, renewsAt } = monthIn(now));
  } else {
    const profile = await prisma.hugoProfile.findFirst({ where: { userId }, select: { allowanceCycleStartedAt: true } });
    const began = profile?.allowanceCycleStartedAt ?? null;
    if (began && now.getTime() < began.getTime() + CYCLE_MS) {
      periodStart = began;
      renewsAt = new Date(began.getTime() + CYCLE_MS);
    } else {
      periodStart = now;
      renewsAt = new Date(now.getTime() + CYCLE_MS);
    }
  }
  const spent = await prisma.hugoUsage.aggregate({ where: { userId, createdAt: { gte: periodStart } }, _sum: { costMicros: true } });
  const spentMicros = spent._sum.costMicros ?? 0;
  return { allowanceClass, capMicros, spentMicros, periodStart, renewsAt, exhausted: spentMicros >= capMicros };
}

/**
 * Before a model call: may this person's Hugo use it at all (HugoNoModelError
 * if not), and is anything left (HugoAllowanceError, with when it renews)?
 */
export async function assertAllowance(userId: string, now: Date = new Date()): Promise<AllowanceStatus> {
  // No account found reads as an associate's, as allowanceStatus does: closed by default.
  const who = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, activeRole: true } });
  if (!modelServes((who?.role ?? 'ASSOCIATE') as Role, who?.activeRole as Role | null | undefined)) throw new HugoNoModelError();
  const status = await allowanceStatus(userId, now);
  if (status.exhausted) throw new HugoAllowanceError(status.renewsAt);
  return status;
}

/** "input, cached input, output" US dollars per million tokens — which is millionths of a dollar per token. */
function pricesOf(tier: 'fast' | 'deep'): { input: number; cached: number; output: number } {
  const [input = 0, cached = 0, output = 0] = (tier === 'deep' ? env.HUGO_PRICE_DEEP : env.HUGO_PRICE_FAST).split(',').map((n) => Number(n.trim()) || 0);
  return { input, cached, output };
}

export interface CallUsage {
  tier: 'fast' | 'deep';
  model: string;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
}

/** What a call cost, in millionths of a dollar — rounded up, never down. */
export function costMicrosOf(u: Pick<CallUsage, 'tier' | 'inputTokens' | 'cachedTokens' | 'outputTokens'>): number {
  const p = pricesOf(u.tier);
  return Math.ceil(u.inputTokens * p.input + u.cachedTokens * p.cached + u.outputTokens * p.output);
}

/** After a model call: charge it to the person (and begin their floor cycle on first use). */
export async function chargeModelCall(meter: ModelMeter, usage: CallUsage, now: Date = new Date()): Promise<number> {
  const tenantId = tenantIdForWrite();
  const costMicros = costMicrosOf(usage);
  const user = await prisma.user.findUnique({ where: { id: meter.userId }, select: { role: true } });
  if (allowanceClassOf((user?.role ?? 'ASSOCIATE') as Role) === 'floor') {
    const profile = await prisma.hugoProfile.findFirst({ where: { userId: meter.userId }, select: { allowanceCycleStartedAt: true } });
    const began = profile?.allowanceCycleStartedAt ?? null;
    if (!began || now.getTime() >= began.getTime() + CYCLE_MS) {
      await prisma.hugoProfile.upsert({
        where: { tenantId_userId: { tenantId, userId: meter.userId } },
        create: { tenantId, userId: meter.userId, allowanceCycleStartedAt: now },
        update: { allowanceCycleStartedAt: now },
      });
    }
  }
  await prisma.hugoUsage.create({
    data: {
      tenantId,
      userId: meter.userId,
      purpose: meter.purpose,
      tier: usage.tier,
      model: usage.model.slice(0, 40),
      inputTokens: usage.inputTokens,
      cachedTokens: usage.cachedTokens,
      outputTokens: usage.outputTokens,
      costMicros,
      createdAt: now,
    },
  });
  return costMicros;
}

/**
 * Said after an answer made without the model because the allowance is used
 * up: what still works, and the day it renews, in the person's language.
 */
export function allowanceUsedLine(lang: HugoLang, renewsAt: Date): string {
  const day = hugoDay(orgDateKey(renewsAt), lang);
  const words: Record<HugoLang, string> = {
    en: `I've used up this month's thinking time, so until ${day} I can only answer the basics — your payday, shifts, ride and documents.`,
    es: `Ya usé mi tiempo de este mes para pensar, así que hasta el ${day} solo puedo responder lo básico: tu pago, turnos, viaje y documentos.`,
    tr: `Bu ayki düşünme süremi kullandım; ${day} tarihine kadar yalnızca temel şeyleri yanıtlayabilirim: maaşın, vardiyaların, servisin ve belgelerin.`,
    ht: `Mwen fin itilize tan pou m reflechi mwa sa a, kidonk jiska ${day} mwen ka reponn sèlman sa ki debaz: peman ou, orè ou, transpò ou ak dokiman ou.`,
    pt: `Já usei meu tempo de raciocínio deste mês, então até ${day} só consigo responder o básico: seu pagamento, turnos, transporte e documentos.`,
    uk: `Я вже використав час на роздуми цього місяця, тож до ${day} можу відповідати лише на основне: оплата, зміни, поїздка й документи.`,
  };
  return words[lang];
}
