import type { ProductEventKind, ProductEventsResponse } from '@alto-people/shared';
import { prisma } from '../db.js';
import { logger } from './logger.js';
import { platformJob } from './tenantJobs.js';

/**
 * The three behaviour events (ux-upgrade §6), rolled up like the web vitals:
 * buffered in memory, flushed on a timer, never on the request path. A row per
 * UTC day, role and kind holds a count and, for the first decision, the summed
 * milliseconds. No user id is kept: the question is "how long does a session
 * take to reach a decision", not "who decided what".
 */

const FLUSH_MS = 60_000;
const MAX_KEYS = 2_000;

type Bucket = { day: string; role: string; kind: ProductEventKind; count: number; sum: number };

const buffer = new Map<string, Bucket>();
let timer: NodeJS.Timeout | null = null;

const dayKey = (at: Date) => at.toISOString().slice(0, 10);

/** Record one event. Synchronous, cheap, never throws. */
export function recordProductEvent(role: string, kind: ProductEventKind, value = 0, at: Date = new Date()): void {
  if (!Number.isFinite(value) || value < 0) return;
  const day = dayKey(at);
  const key = `${day}|${role}|${kind}`;
  let b = buffer.get(key);
  if (!b) {
    if (buffer.size >= MAX_KEYS) return;
    b = { day, role, kind, count: 0, sum: 0 };
    buffer.set(key, b);
  }
  b.count += 1;
  b.sum += value;
}

export async function flushProductEvents(): Promise<void> {
  if (buffer.size === 0) return;
  const batch = [...buffer.values()];
  buffer.clear();
  for (const b of batch) {
    try {
      const day = new Date(`${b.day}T00:00:00.000Z`);
      await prisma.productEventDaily.upsert({
        where: { day_role_kind: { day, role: b.role, kind: b.kind } },
        create: { day, role: b.role, kind: b.kind, count: b.count, sum: b.sum },
        update: { count: { increment: b.count }, sum: { increment: b.sum } },
      });
    } catch (err) {
      logger.warn({ err, kind: b.kind }, 'product events: flush failed');
    }
  }
}

export function startProductEventsFlusher(): void {
  if (timer) return;
  timer = setInterval(() => {
    void platformJob('productEvents', flushProductEvents)();
  }, FLUSH_MS);
  timer.unref?.();
}

export function stopProductEventsFlusher(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Test-only. */
export async function flushProductEventsForTests(): Promise<void> {
  await flushProductEvents();
}

export function resetProductEventsForTests(): void {
  buffer.clear();
}

const ONE_DAY_MS = 86_400_000;

/** The three measures over the window, from the rollup. */
export async function productEventsReport(days: number, now: Date = new Date()): Promise<ProductEventsResponse> {
  const today = new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
  const from = new Date(today.getTime() - (days - 1) * ONE_DAY_MS);
  const rows = await prisma.productEventDaily.groupBy({ by: ['role', 'kind'], where: { day: { gte: from } }, _sum: { count: true, sum: true } });
  const n = (role: string | null, kind: ProductEventKind) =>
    rows.filter((r) => r.kind === kind && (role === null || r.role === role)).reduce((s, r) => s + (r._sum.count ?? 0), 0);
  const firstSessions = n(null, 'first_decision');
  const firstSum = rows.filter((r) => r.kind === 'first_decision').reduce((s, r) => s + (r._sum.sum ?? 0), 0);
  const roles = [...new Set(rows.map((r) => r.role))].sort();
  const decisionsPerSession = roles
    .map((role) => {
      const sessions = n(role, 'session_start');
      const decisions = n(role, 'decision');
      return { role, sessions, decisions, perSession: sessions > 0 ? Math.round((decisions / sessions) * 100) / 100 : null };
    })
    .filter((r) => r.sessions > 0 || r.decisions > 0)
    .sort((a, b) => b.decisions - a.decisions);
  const sessions = n(null, 'session_start');
  const searches = n(null, 'settings_search');
  return {
    days,
    firstDecision: { sessions: firstSessions, avgMs: firstSessions > 0 ? Math.round(firstSum / firstSessions) : null },
    decisionsPerSession,
    settingsSearches: { count: searches, sessions, perHundredSessions: sessions > 0 ? Math.round((searches / sessions) * 10_000) / 100 : null },
  };
}
