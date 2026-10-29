import type { Prisma, PrismaClient, PunchPhotoRule } from '@prisma/client';
import { tenantIdForWrite } from './tenant.js';
import { dayBoundsInTz, siteTimeZone, todayInTz } from './siteDay.js';

/**
 * A photo at every kiosk punch, where a rule says so (2027-01).
 *
 * Rules sit at four levels — the company, a client, a store (site), one
 * person — and the most specific rule in force wins, so "required at this
 * store" can be relaxed for one person and "not required anywhere" can be
 * tightened for one person. A person-level rule carries its reason and,
 * usually, an end date: singling someone out is on the record and time-
 * bound. Ended rules stay as history.
 *
 * Enforcement (routes/kiosk99.ts): a punch that must carry a photo and
 * doesn't is refused — unless the kiosk says its camera isn't working, in
 * which case it's kept (refusing would be unpaid work) and flagged
 * NO_PHOTO for a supervisor to confirm. The photo is stored even without
 * face-matching consent: a picture isn't a face template; matching still
 * needs consent.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export type PhotoScope = 'COMPANY' | 'CLIENT' | 'SITE' | 'ASSOCIATE';
const RANK: Record<PhotoScope, number> = { ASSOCIATE: 4, SITE: 3, CLIENT: 2, COMPANY: 1 };

const dateOnly = (s: string) => new Date(`${s}T00:00:00.000Z`);

export interface PhotoPolicy {
  required: boolean;
  /** The rule that decided it, or null (no rule anywhere → not required). */
  rule: Pick<PunchPhotoRule, 'id' | 'scope' | 'required' | 'reason' | 'startsOn' | 'endsOn' | 'createdById'> | null;
}

/** A rule's where-clause for "in force on `on`". */
export function inForceOn(on: string): Prisma.PunchPhotoRuleWhereInput {
  return { endedAt: null, startsOn: { lte: dateOnly(on) }, OR: [{ endsOn: null }, { endsOn: { gte: dateOnly(on) } }] };
}

/**
 * Whether this person's punch at this store (of this client) needs a
 * photo today. One query: every rule in force that could touch them.
 */
export async function photoPolicyFor(
  db: Db,
  target: { associateId: string; siteId: string | null; clientId: string | null },
  on: Date = new Date(),
): Promise<PhotoPolicy> {
  const tenantId = tenantIdForWrite();
  // "Today" is the punch's store day (its zone, else the company's), never UTC's.
  const day = todayInTz(await siteTimeZone(target.siteId, db), on);
  const rules = await db.punchPhotoRule.findMany({
    where: {
      tenantId,
      ...inForceOn(day),
      AND: [
        {
          OR: [
            { scope: 'COMPANY' },
            ...(target.clientId ? [{ scope: 'CLIENT', clientId: target.clientId }] : []),
            ...(target.siteId ? [{ scope: 'SITE', siteId: target.siteId }] : []),
            { scope: 'ASSOCIATE', associateId: target.associateId },
          ],
        },
      ],
    },
    select: { id: true, scope: true, required: true, reason: true, startsOn: true, endsOn: true, createdById: true, createdAt: true },
  });
  if (rules.length === 0) return { required: false, rule: null };
  // Most specific first; at one level, the newest.
  const winner = [...rules].sort((a, b) => RANK[b.scope as PhotoScope] - RANK[a.scope as PhotoScope] || b.createdAt.getTime() - a.createdAt.getTime())[0]!;
  const { createdAt: _c, ...rule } = winner;
  return { required: winner.required, rule };
}

/** What the kiosk says to someone whose punches need a photo — plain, and never the reason itself (that's HR's record). */
export function kioskPhotoNotice(policy: PhotoPolicy): string | null {
  if (!policy.required || !policy.rule) return null;
  switch (policy.rule.scope) {
    case 'ASSOCIATE':
      return policy.rule.endsOn
        ? `A photo is required at each of your punches through ${policy.rule.endsOn.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' })}.`
        : 'A photo is required at each of your punches.';
    case 'SITE':
      return 'A photo is required at every punch at this location.';
    default:
      return 'A photo is required at every punch.';
  }
}

/** Plain words for where a rule applies, for records and the audit log. */
export function ruleLabel(r: { scope: string; required: boolean }, names: { client?: string | null; site?: string | null; person?: string | null } = {}): string {
  const what = r.required ? 'Photo required' : 'Photo not required';
  switch (r.scope) {
    case 'COMPANY':
      return `${what} at every punch, company-wide`;
    case 'CLIENT':
      return `${what} at every ${names.client ?? 'client'} location`;
    case 'SITE':
      return `${what} at ${names.site ?? 'this location'}`;
    default:
      return `${what} for ${names.person ?? 'this person'}`;
  }
}

/**
 * A kiosk took a photo-required punch with its camera down: tell the HR
 * and operations admins once per kiosk per day, so it's fixed before the
 * next shift — every punch until then is one more for a supervisor to confirm.
 */
export async function noticeCameraDown(db: PrismaClient, deviceId: string, now: Date = new Date()): Promise<void> {
  const tenantId = tenantIdForWrite();
  const device = await db.kioskDevice.findFirst({ where: { id: deviceId, tenantId }, select: { name: true, locationId: true, location: { select: { name: true } } } });
  if (!device) return;
  const linkUrl = `/time-attendance/kiosk?camera=${deviceId}`;
  // Once per store day: midnight on the kiosk's store clock, not UTC's.
  const tz = await siteTimeZone(device.locationId, db);
  const since = dayBoundsInTz(todayInTz(tz, now), tz).start;
  const already = await db.notification.findFirst({ where: { linkUrl, createdAt: { gte: since } }, select: { id: true } });
  if (already) return;
  const { notifyUser } = await import('./notify.js');
  const admins = await db.user.findMany({ where: { tenantId, status: 'ACTIVE', deletedAt: null, role: { in: ['HR_ADMINISTRATOR', 'OPERATIONS_MANAGER'] } }, select: { id: true }, take: 25 });
  const where = device.location?.name ? `${device.name} at ${device.location.name}` : device.name;
  for (const u of admins) {
    void notifyUser(u.id, {
      subject: `Kiosk camera not working: ${where}`,
      body: `${where} took a punch that needs a photo without one — its camera didn’t start. Punches are still recorded and sent to supervisors to confirm, but check the tablet’s camera before the next shift.`,
      category: 'kiosk_device_alert',
      linkUrl,
    });
  }
}
