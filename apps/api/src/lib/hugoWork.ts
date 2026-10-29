import type { HugoShiftRef } from '@alto-people/shared';
import { prisma } from '../db.js';
import { inProcessAgent, type AgentContext } from './agents.js';
import { hugoDisclosure, toHugoLang, type HugoLang } from './hugoWorkCopy.js';
import { emitLiveEvent } from './liveEvents.js';
import { notifyUser, notifyUserOn } from './notify.js';
import { eligibleOpenShifts } from './openShiftEligibility.js';
import { windowCovers } from './openShiftInvites.js';
import { companyWorkweek } from './timeAnomalies.js';

/**
 * What Hugo's tasks (lib/hugoTasks) and notes (lib/hugoNotes) share: the
 * assistant's own identity, how a notice reaches someone, and the reads
 * both make about a person's shifts.
 */

/** Hugo, when Hugo is on for the tenant in context; null when switched off (then nothing runs). */
export function hugoAgent(tenantId?: string | null): Promise<AgentContext | null> {
  return inProcessAgent(prisma, 'whatsapp-assistant', tenantId);
}

/** The reader's language and the owner's name, for the notice and its disclosure line. */
export async function readerOf(userId: string): Promise<{ lang: HugoLang; active: boolean }> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { language: true, status: true } });
  return { lang: toHugoLang(u?.language), active: u?.status === 'ACTIVE' };
}

async function ownerName(agent: AgentContext): Promise<string | null> {
  if (!agent.ownerUserId) return null;
  const u = await prisma.user.findUnique({ where: { id: agent.ownerUserId }, select: { email: true, associate: { select: { firstName: true, lastName: true } } } });
  if (!u) return null;
  const full = u.associate ? `${u.associate.firstName} ${u.associate.lastName}`.trim() : '';
  return full || u.email;
}

export interface HugoNoticeSend {
  userId: string;
  lang: HugoLang;
  subject: string;
  body: string;
  category: 'hugo_task_done' | 'hugo_task_needs_you' | 'hugo_note';
  linkUrl: string;
  /**
   * `full`: every channel the person keeps on for the assistant's bucket
   * (bell, email, push, WhatsApp) — for what changes their day: a shift
   * covered or not, a decision only they can make. Otherwise the bell and
   * the lock screen only.
   */
  full?: boolean;
}

/** One notice from Hugo, with the AI disclosure and Hugo's id on the record (lib/agentDisclosure). */
export async function sendHugoNotice(agent: AgentContext, n: HugoNoticeSend): Promise<void> {
  const body = `${n.body}\n\n${hugoDisclosure(n.lang, agent.name, await ownerName(agent))}`;
  const opts = { subject: n.subject, body, category: n.category, linkUrl: n.linkUrl, byAgentId: agent.workerId };
  if (n.full) await notifyUser(n.userId, opts);
  else await notifyUserOn(n.userId, opts, ['IN_APP', 'PUSH']);
  emitLiveEvent(n.userId, 'hugo');
}

/** The shift as a task or a note shows it. */
export function shiftRefOf(s: {
  id: string;
  startsAt: Date;
  endsAt: Date;
  position?: string | null;
  location?: string | null;
  client?: { name: string } | null;
  locationRel?: { name: string; timezone: string | null } | null;
}): HugoShiftRef {
  return {
    id: s.id,
    startsAt: s.startsAt.toISOString(),
    endsAt: s.endsAt.toISOString(),
    timezone: s.locationRel?.timezone ?? companyWorkweek().timezone,
    site: s.locationRel?.name ?? s.client?.name ?? s.location ?? null,
    position: s.position ?? null,
  };
}

export const SHIFT_REF_SELECT = {
  id: true,
  startsAt: true,
  endsAt: true,
  position: true,
  location: true,
  client: { select: { name: true } },
  locationRel: { select: { name: true, timezone: true } },
} as const;

/**
 * Open shifts that fit this person, soonest first: the ones they could claim
 * (lib/openShiftEligibility — placed there, qualified, free, not on time
 * off), inside the availability they gave (none on file is not a "no"), and
 * not ones they already passed on. `skipInvited` leaves out shifts the
 * open-shift invite already told them about.
 */
export async function openShiftsThatFit(associateId: string, opts: { before: Date; skipInvited?: boolean; skip?: ReadonlySet<string> }): Promise<HugoShiftRef[]> {
  const eligible = await eligibleOpenShifts(associateId, { before: opts.before });
  const ids = eligible.map((s) => s.id).filter((id) => !opts.skip?.has(id));
  if (!ids.length) return [];
  const [rows, invites, windows] = await Promise.all([
    prisma.shift.findMany({ where: { id: { in: ids } }, select: SHIFT_REF_SELECT, orderBy: { startsAt: 'asc' } }),
    prisma.openShiftInvite.findMany({ where: { associateId, shiftId: { in: ids } }, select: { shiftId: true, declinedAt: true, lastSentAt: true } }),
    prisma.associateAvailability.findMany({ where: { associateId }, select: { dayOfWeek: true, startMinute: true, endMinute: true } }),
  ]);
  const inviteOf = new Map(invites.map((i) => [i.shiftId, i]));
  return rows
    .filter((s) => {
      const inv = inviteOf.get(s.id);
      if (inv?.declinedAt) return false;
      if (opts.skipInvited && inv?.lastSentAt) return false;
      return windows.length === 0 || windowCovers(windows, s, s.locationRel?.timezone ?? companyWorkweek().timezone);
    })
    .map(shiftRefOf);
}
