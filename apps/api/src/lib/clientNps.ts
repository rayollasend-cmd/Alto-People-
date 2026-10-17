import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { ensureBrandingLoaded } from './branding.js';
import { publicBaseUrl, renderBrandedEmail } from './emailLayout.js';
import { generateInviteToken } from './inviteToken.js';
import { send } from './notifications.js';
import { runForEachTenant } from './tenantJobs.js';
import { tenantIdForWrite } from './tenant.js';

/**
 * Client NPS — the one question, once a quarter, to every store manager
 * with a portal account: "How likely are you to recommend us?" Answered on
 * a signed link outside the portal (the portal itself is untouched), read
 * by the executive per client and over time.
 *
 * A wave is one quarter's send. The quarterly job files it in the first
 * week of each quarter for tenants with the client portal on; a person
 * with manage:clients can send it early or send a reminder.
 */

const DAY = 86_400_000;
export const NPS_WINDOW_DAYS = 30;

export function quarterOf(d: Date): string {
  return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}

/** True in the first seven days of a quarter — when the job sends. */
export function inSendWindow(d: Date): boolean {
  const m = d.getUTCMonth();
  return m % 3 === 0 && d.getUTCDate() <= 7;
}

export interface SendWaveResult {
  waveId: string;
  quarter: string;
  invited: number;
}

/**
 * Send this quarter's wave. 409-shaped failure (`already_sent`) when the
 * quarter already has one; `nobody` when no client account can receive it.
 */
export async function sendNpsWave(
  input: { quarter?: string; sentById: string | null; now?: Date },
  prisma: PrismaClient = defaultPrisma,
): Promise<SendWaveResult | { error: 'already_sent' | 'nobody' }> {
  const now = input.now ?? new Date();
  const quarter = input.quarter ?? quarterOf(now);
  const tenantId = tenantIdForWrite();
  const existing = await prisma.clientNpsWave.findFirst({ where: { tenantId, quarter }, select: { id: true } });
  if (existing) return { error: 'already_sent' };
  const accounts = await prisma.user.findMany({
    where: {
      tenantId,
      role: 'CLIENT_PORTAL',
      status: 'ACTIVE',
      deletedAt: null,
      clientId: { not: null },
      client: { status: 'ACTIVE' },
    },
    select: { id: true, email: true, clientId: true },
    take: 2000,
  });
  if (accounts.length === 0) return { error: 'nobody' };
  const clientNames = new Map(
    (await prisma.client.findMany({ where: { id: { in: [...new Set(accounts.map((a) => a.clientId!))] } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]),
  );
  const branding = await ensureBrandingLoaded(prisma, tenantId);
  const closesAt = new Date(now.getTime() + NPS_WINDOW_DAYS * DAY);
  const wave = await prisma.clientNpsWave.create({ data: { tenantId, quarter, sentAt: now, closesAt, sentById: input.sentById } });
  const base = publicBaseUrl();
  for (const a of accounts) {
    const token = generateInviteToken();
    await prisma.clientNpsInvite.create({
      data: { tenantId, waveId: wave.id, clientId: a.clientId!, userId: a.id, email: a.email, tokenHash: token.hash, expiresAt: closesAt },
    });
    const url = `${base}/nps/${token.raw}`;
    const email = renderBrandedEmail({
      subject: `${branding.orgName}: one question about this quarter`,
      preheader: 'How likely are you to recommend us? Ten seconds, no login.',
      greeting: null,
      heading: 'How are we doing at your store?',
      paragraphs: [
        `Once a quarter we ask every ${clientNames.get(a.clientId!) ? `${clientNames.get(a.clientId!)} ` : ''}store we staff one question: how likely are you to recommend ${branding.orgName}? Your answer goes straight to our leadership.`,
      ],
      cta: { label: 'Answer in ten seconds', url },
      after: [`The link is yours alone and works until ${closesAt.toISOString().slice(0, 10)}.`],
    });
    void send({
      channel: 'EMAIL',
      category: 'client_nps',
      recipient: { userId: a.id, phone: null, email: a.email },
      subject: email.subject,
      body: email.text,
      html: email.html,
    }).catch(() => undefined);
  }
  return { waveId: wave.id, quarter, invited: accounts.length };
}

/** Nudge everyone in the open wave who has not answered. Returns how many. */
export async function remindNpsWave(prisma: PrismaClient = defaultPrisma, now = new Date()): Promise<number> {
  const tenantId = tenantIdForWrite();
  const wave = await prisma.clientNpsWave.findFirst({ where: { tenantId, closesAt: { gt: now } }, orderBy: { sentAt: 'desc' } });
  if (!wave) return 0;
  const pending = await prisma.clientNpsInvite.findMany({
    where: { waveId: wave.id, respondedAt: null, remindedAt: null },
    select: { id: true, email: true, userId: true, tokenHash: true },
  });
  // The raw token is gone (only its hash is kept), so a reminder mints a
  // fresh one for the same invite.
  const branding = await ensureBrandingLoaded(prisma, tenantId);
  for (const inv of pending) {
    const token = generateInviteToken();
    await prisma.clientNpsInvite.update({ where: { id: inv.id }, data: { tokenHash: token.hash, remindedAt: now } });
    const url = `${publicBaseUrl()}/nps/${token.raw}`;
    const email = renderBrandedEmail({
      subject: `${branding.orgName}: still one question for you`,
      preheader: 'Ten seconds, no login — your answer reaches our leadership.',
      heading: 'One question about this quarter',
      paragraphs: [`How likely are you to recommend ${branding.orgName}? Your answer goes straight to our leadership.`],
      cta: { label: 'Answer in ten seconds', url },
      after: [`The link works until ${wave.closesAt.toISOString().slice(0, 10)}.`],
    });
    void send({
      channel: 'EMAIL',
      category: 'client_nps',
      recipient: { userId: inv.userId, phone: null, email: inv.email },
      subject: email.subject,
      body: email.text,
      html: email.html,
    }).catch(() => undefined);
  }
  return pending.length;
}

export interface NpsResults {
  current: {
    waveId: string;
    quarter: string;
    sentAt: string;
    closesAt: string;
    open: boolean;
    invited: number;
    responded: number;
    responsePct: number | null;
    nps: number | null;
    promoters: number;
    passives: number;
    detractors: number;
  } | null;
  byClient: Array<{
    clientId: string;
    clientName: string;
    invited: number;
    responded: number;
    nps: number | null;
    avgScore: number | null;
    /** The previous wave's NPS for the same client, for the arrow. */
    previousNps: number | null;
    lastComment: string | null;
  }>;
  trend: Array<{ quarter: string; nps: number | null; responded: number; invited: number }>;
  comments: Array<{ clientName: string; score: number; comment: string; at: string }>;
  /** Whether this quarter's wave can still be sent (nothing sent yet). */
  canSendQuarter: string | null;
}

function npsOf(scores: number[]): number | null {
  if (scores.length === 0) return null;
  const promoters = scores.filter((s) => s >= 9).length;
  const detractors = scores.filter((s) => s <= 6).length;
  return Math.round(((promoters - detractors) / scores.length) * 100);
}

export async function computeNpsResults(prisma: PrismaClient = defaultPrisma, now = new Date()): Promise<NpsResults> {
  const tenantId = tenantIdForWrite();
  const waves = await prisma.clientNpsWave.findMany({
    where: { tenantId },
    orderBy: { sentAt: 'desc' },
    take: 8,
    include: {
      invites: {
        select: { clientId: true, score: true, comment: true, respondedAt: true, client: { select: { name: true } } },
      },
    },
  });
  const trend = [...waves].reverse().map((w) => {
    const scores = w.invites.filter((i) => i.score !== null).map((i) => i.score!);
    return { quarter: w.quarter, nps: npsOf(scores), responded: scores.length, invited: w.invites.length };
  });
  const current = waves[0] ?? null;
  const previous = waves[1] ?? null;
  const byClientFor = (w: typeof current) => {
    const m = new Map<string, { name: string; invited: number; scores: number[]; lastComment: string | null }>();
    for (const i of w?.invites ?? []) {
      const e = m.get(i.clientId) ?? { name: i.client.name, invited: 0, scores: [], lastComment: null };
      e.invited += 1;
      if (i.score !== null) e.scores.push(i.score);
      if (i.comment && !e.lastComment) e.lastComment = i.comment;
      m.set(i.clientId, e);
    }
    return m;
  };
  const cur = byClientFor(current);
  const prev = byClientFor(previous);
  const curScores = current ? current.invites.filter((i) => i.score !== null).map((i) => i.score!) : [];
  const comments = (current?.invites ?? [])
    .filter((i) => i.comment && i.score !== null)
    .sort((a, b) => (b.respondedAt?.getTime() ?? 0) - (a.respondedAt?.getTime() ?? 0))
    .slice(0, 10)
    .map((i) => ({ clientName: i.client.name, score: i.score!, comment: i.comment!, at: i.respondedAt!.toISOString() }));
  const thisQuarter = quarterOf(now);
  return {
    current: current
      ? {
          waveId: current.id,
          quarter: current.quarter,
          sentAt: current.sentAt.toISOString(),
          closesAt: current.closesAt.toISOString(),
          open: current.closesAt.getTime() > now.getTime(),
          invited: current.invites.length,
          responded: curScores.length,
          responsePct: current.invites.length ? Math.round((curScores.length / current.invites.length) * 100) : null,
          nps: npsOf(curScores),
          promoters: curScores.filter((s) => s >= 9).length,
          passives: curScores.filter((s) => s === 7 || s === 8).length,
          detractors: curScores.filter((s) => s <= 6).length,
        }
      : null,
    byClient: [...cur.entries()]
      .map(([clientId, e]) => ({
        clientId,
        clientName: e.name,
        invited: e.invited,
        responded: e.scores.length,
        nps: npsOf(e.scores),
        avgScore: e.scores.length ? Math.round((e.scores.reduce((a, b) => a + b, 0) / e.scores.length) * 10) / 10 : null,
        previousNps: npsOf(prev.get(clientId)?.scores ?? []),
        lastComment: e.lastComment,
      }))
      .sort((a, b) => (a.nps ?? 101) - (b.nps ?? 101) || a.clientName.localeCompare(b.clientName)),
    trend,
    comments,
    canSendQuarter: waves.some((w) => w.quarter === thisQuarter) ? null : thisQuarter,
  };
}

/* ===== The quarterly job ================================================== */

const SWEEP_MS = 6 * 3_600_000;
let timer: NodeJS.Timeout | null = null;

export async function quarterlyNpsSweep(now = new Date()): Promise<void> {
  if (!inSendWindow(now)) return;
  const out = await sendNpsWave({ sentById: null, now });
  if ('waveId' in out) console.log(`[alto-people/api] client NPS wave ${out.quarter} sent to ${out.invited} store manager(s)`);
}

export function startClientNpsCron(): void {
  if (timer) return;
  const tick = () => runForEachTenant('client-nps', () => quarterlyNpsSweep(), { module: 'clientPortal' });
  void tick().catch((err) => console.error('[alto-people/api] client NPS sweep failed:', err));
  timer = setInterval(() => {
    void tick().catch((err) => console.error('[alto-people/api] client NPS sweep failed:', err));
  }, SWEEP_MS);
  timer.unref();
  console.log('[alto-people/api] client NPS cron armed (quarterly per tenant, checked every 6h)');
}

export function stopClientNpsCron(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
