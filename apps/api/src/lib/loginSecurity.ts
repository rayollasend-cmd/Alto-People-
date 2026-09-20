import { prisma } from '../db.js';
import { logger } from './logger.js';
import { notifyUser } from './notify.js';

/**
 * "WAS THAT YOU?"
 *
 * Account lockout already stops a password being guessed. What it cannot
 * do is tell the owner that somebody signed in successfully from a network
 * they have never used — the case where the password was not guessed but
 * already known.
 *
 * So every successful sign-in records the network it came from, and the
 * FIRST time an account is used from somewhere new, its owner is told.
 * Deliberately only the owner: a security alert that also fans out to an
 * admin desk is a notification nobody reads by the second week, and this
 * one has to be read.
 *
 * The very first sign-in on an account is never flagged. Everyone's first
 * network is new, and an alert that fires for every new hire teaches people
 * to ignore it.
 *
 * Category is `security`, which is mandatory in NOTIFICATION_CATEGORIES —
 * it cannot be muted on either channel, which is the point.
 */

export interface SignInContext {
  userId: string;
  ip: string | null;
  userAgent: string | null;
  /** IANA zone the browser reported, when it offered one. */
  timezone: string | null;
}

export interface SignInAssessment {
  /** False for the first sign-in ever, and for a network already on file. */
  newNetwork: boolean;
  knownNetworks: number;
}

/**
 * Record the network and say whether it is new. Never throws: a sign-in
 * must not fail because its bookkeeping did.
 */
export async function noteSuccessfulSignIn(ctx: SignInContext): Promise<SignInAssessment> {
  const quiet: SignInAssessment = { newNetwork: false, knownNetworks: 0 };
  if (!ctx.ip) return quiet;
  try {
    const known = await prisma.userKnownIp.findUnique({
      where: { userId_ip: { userId: ctx.userId, ip: ctx.ip } },
      select: { id: true },
    });

    if (known) {
      await prisma.userKnownIp.update({
        where: { id: known.id },
        data: {
          lastSeenAt: new Date(),
          logins: { increment: 1 },
          // A browser that only just started reporting its zone still fills
          // the gap; one that stops reporting does not blank what we had.
          ...(ctx.timezone ? { timezone: ctx.timezone } : {}),
        },
      });
      const knownNetworks = await prisma.userKnownIp.count({ where: { userId: ctx.userId } });
      return { newNetwork: false, knownNetworks };
    }

    // Count BEFORE inserting, so "is this their first ever?" is answerable.
    const priorNetworks = await prisma.userKnownIp.count({ where: { userId: ctx.userId } });
    await prisma.userKnownIp.create({
      data: { userId: ctx.userId, ip: ctx.ip, timezone: ctx.timezone },
    });
    return { newNetwork: priorNetworks > 0, knownNetworks: priorNetworks + 1 };
  } catch (err) {
    logger.warn({ err, userId: ctx.userId }, 'login security: could not record network');
    return quiet;
  }
}

/** A user agent trimmed to something a person can read in a sentence. */
export function describeDevice(userAgent: string | null): string {
  if (!userAgent) return 'an unrecognised device';
  const ua = userAgent;
  const os = /iPhone|iPad/.test(ua)
    ? 'an iPhone or iPad'
    : /Android/.test(ua)
      ? 'an Android device'
      : /Mac OS X/.test(ua)
        ? 'a Mac'
        : /Windows/.test(ua)
          ? 'a Windows PC'
          : 'an unrecognised device';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Chrome\//.test(ua)
      ? 'Chrome'
      : /Safari\//.test(ua)
        ? 'Safari'
        : /Firefox\//.test(ua)
          ? 'Firefox'
          : null;
  return browser ? `${os} using ${browser}` : os;
}

/**
 * Tell the owner about a sign-in from a network they have not used before.
 * Fire-and-forget; notifyUser never rejects.
 */
export function alertNewNetwork(ctx: SignInContext): void {
  const where = ctx.timezone ? ` (time zone ${ctx.timezone})` : '';
  void notifyUser(ctx.userId, {
    subject: 'New sign-in to your Alto People account',
    body:
      `Your account was just signed in to from ${describeDevice(ctx.userAgent)} ` +
      `on a network we have not seen before${where}. ` +
      `If that was you, nothing to do. If it was not, change your password now ` +
      `and sign out other sessions from Settings.`,
    category: 'security',
    linkUrl: '/settings',
  });
}
