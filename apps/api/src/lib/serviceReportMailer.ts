import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { env } from '../config/env.js';
import { EmailSuppressedError, send } from './notifications.js';
import { ensureBrandingLoaded } from './branding.js';
import { buildPortalReport, portalScopeFor, renderPortalReportPdf } from './portalDayReport.js';
import { nextKey } from './portalMetrics.js';
import { genericNotificationTemplate } from './emailTemplates.js';
import { orgDateKey, startOfWeekUTC } from './timeAnomalies.js';
import { isEmailMuted, trackNotificationWork } from './notify.js';
import { emitLiveEvent } from './liveEvents.js';
import { sendPushToUser } from './webPush.js';

/**
 * The Saturday email — last week's service report, in the manager's inbox
 * before the week starts.
 *
 * The org week ends Friday 24:00. From Saturday after
 * SERVICE_REPORT_MAIL_HOUR (org time) through Monday, every ACTIVE portal
 * account gets the completed week's report:
 *   - a store account: its store's report;
 *   - a market (client-wide) account: the client's report;
 *   - a region account: one email with a report per store in the region.
 *
 * Delivery is dependable: the bell row that marks "done for the week" is
 * written only once the email went out (or the person muted it, or the
 * address is on the do-not-email list). A failed send leaves no row, so
 * the next hourly sweep tries again; a server down all Saturday catches
 * up on Sunday or Monday. Each attempt is recorded as an EMAIL row. The
 * bell rings live and by push, like every other notification.
 */

const CATEGORY = 'portal.service_report';
const ORG_TZ = 'America/New_York';
const MAX_REGION_ATTACHMENTS = 12;

const PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: ORG_TZ,
  weekday: 'short',
  hour: 'numeric',
  hour12: false,
});

function orgWeekdayAndHour(now: Date): { weekday: string; hour: number } {
  const parts = PARTS.formatToParts(now);
  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? '';
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  return { weekday, hour };
}

const shortDate = (key: string) =>
  new Date(`${key}T12:00:00.000Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const slug = (s: string) => s.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase();

export interface ServiceReportMailResult {
  sent: number;
  skipped: number;
  reason?: 'not_saturday' | 'before_send_hour' | 'no_recipients';
}

export async function runServiceReportMailSweep(
  prisma: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<ServiceReportMailResult> {
  const { weekday, hour } = orgWeekdayAndHour(now);
  if (weekday === 'Sat' && hour < env.SERVICE_REPORT_MAIL_HOUR) return { sent: 0, skipped: 0, reason: 'before_send_hour' };
  if (weekday !== 'Sat' && weekday !== 'Sun' && weekday !== 'Mon') return { sent: 0, skipped: 0, reason: 'not_saturday' };

  // Last completed org week: Saturday → Friday, ending before this week began.
  const thisWeekStart = startOfWeekUTC(now);
  const weekStart = new Date(thisWeekStart.getTime() - 7 * 24 * 3_600_000);
  const weekKey = orgDateKey(weekStart);
  const weekEndKey = nextKey(weekKey, 6);
  const span = `${shortDate(weekKey)} – ${shortDate(weekEndKey)}`;

  const recipients = await prisma.user.findMany({
    where: {
      role: 'CLIENT_PORTAL',
      status: 'ACTIVE',
      deletedAt: null,
      OR: [{ clientId: { not: null } }, { regionId: { not: null } }],
    },
    select: {
      id: true,
      email: true,
      clientId: true,
      locationId: true,
      regionId: true,
      client: { select: { name: true } },
      location: { select: { name: true } },
      region: { select: { name: true } },
    },
    take: 500,
  });
  if (recipients.length === 0) return { sent: 0, skipped: 0, reason: 'no_recipients' };

  const branding = await ensureBrandingLoaded(prisma);
  // One build per (client, store), shared by everyone who receives it.
  const pdfByScope = new Map<string, { pdf: Buffer; filename: string } | null>();
  const reportFor = async (clientId: string, locationId: string | null) => {
    const key = `${clientId}|${locationId ?? ''}`;
    if (!pdfByScope.has(key)) {
      const scope = await portalScopeFor(clientId, locationId);
      if (!scope) pdfByScope.set(key, null);
      else {
        const data = await buildPortalReport(scope, weekKey, weekEndKey, branding.orgName, now);
        pdfByScope.set(key, {
          pdf: await renderPortalReportPdf(data),
          filename: `service-report-${slug(scope.location?.name ?? scope.client.name)}-${weekKey}.pdf`,
        });
      }
    }
    return pdfByScope.get(key)!;
  };

  let sent = 0;
  let skipped = 0;
  for (const u of recipients) {
    const already = await prisma.notification.findFirst({
      where: { recipientUserId: u.id, category: CATEGORY, channel: 'IN_APP', createdAt: { gte: thisWeekStart } },
      select: { id: true },
    });
    if (already) {
      skipped += 1;
      continue;
    }

    let attachments: Array<{ filename: string; content: Buffer; contentType: string }> = [];
    let subject: string;
    let bodyText: string;
    let linkUrl: string;
    if (!u.clientId && u.regionId) {
      const stores = await prisma.location.findMany({
        where: { regionId: u.regionId, deletedAt: null, isActive: true },
        select: { id: true, clientId: true },
        orderBy: { name: 'asc' },
        take: MAX_REGION_ATTACHMENTS,
      });
      for (const s of stores) {
        const r = await reportFor(s.clientId, s.id);
        if (r) attachments.push({ filename: r.filename, content: r.pdf, contentType: 'application/pdf' });
      }
      const regionName = u.region?.name ?? 'Your region';
      subject = `${regionName}: last week's service reports (${span})`;
      bodyText =
        `Last week's service reports for the ${attachments.length} ${attachments.length === 1 ? 'store' : 'stores'} in ${regionName} are attached, one PDF per store.\n\n` +
        'Your command center has every store on one screen.';
      linkUrl = '/';
    } else {
      const r = await reportFor(u.clientId!, u.locationId);
      if (r) attachments = [{ filename: r.filename, content: r.pdf, contentType: 'application/pdf' }];
      const storeName = u.location?.name ?? u.client?.name ?? 'your store';
      subject = `${storeName}: your service report for ${span}`;
      bodyText =
        `Last week's service report for ${storeName} is attached — your dashboard, day by day.\n\n` +
        'Open History in your portal for the same week with every chart, or mark the report reviewed there.';
      linkUrl = '/portal/history?range=lastWeek';
    }
    if (attachments.length === 0) {
      skipped += 1;
      continue;
    }

    const muted = await isEmailMuted(u.id, CATEGORY);
    let outcome: 'SENT' | 'FAILED' | 'SUPPRESSED' | 'MUTED' = 'MUTED';
    let failureReason: string | null = null;
    if (!muted) {
      const tpl = genericNotificationTemplate({ subject, body: bodyText, linkUrl });
      try {
        await send({
          channel: 'EMAIL',
          // This caller writes its own Notification row for the attempt.
          audit: false,
          recipient: { userId: u.id, phone: null, email: u.email },
          subject,
          body: tpl.text,
          html: tpl.html,
          attachments,
        });
        outcome = 'SENT';
      } catch (err) {
        failureReason = err instanceof Error ? err.message : String(err);
        outcome = err instanceof EmailSuppressedError ? 'SUPPRESSED' : 'FAILED';
      }
      await prisma.notification.create({
        data: {
          channel: 'EMAIL',
          status: outcome === 'SENT' ? 'SENT' : 'FAILED',
          recipientUserId: u.id,
          recipientEmail: u.email,
          subject,
          body: bodyText,
          category: CATEGORY,
          failureReason,
          sentAt: outcome === 'SENT' ? now : null,
          createdAt: now,
        },
      });
    }
    if (outcome === 'FAILED') {
      // No "done" row: the next hourly sweep tries again.
      console.warn('[service-report-mail] send failed, will retry:', failureReason);
      skipped += 1;
      continue;
    }

    // Done for the week: the bell row (also the dedupe key), live, and push.
    await prisma.notification.create({
      data: {
        channel: 'IN_APP',
        status: 'SENT',
        recipientUserId: u.id,
        subject,
        body: bodyText,
        category: CATEGORY,
        linkUrl,
        sentAt: now,
        // Stamped with the sweep's clock: the weekly dedupe reads it.
        createdAt: now,
      },
    });
    emitLiveEvent(u.id, 'notification');
    if (!muted) void trackNotificationWork(sendPushToUser(u.id, { title: subject, body: bodyText.split('\n')[0] ?? subject, url: linkUrl }));
    sent += 1;
  }
  return { sent, skipped };
}

let timer: NodeJS.Timeout | null = null;

export function startServiceReportMailCron(): void {
  if (timer) return;
  const seconds = env.SERVICE_REPORT_MAIL_INTERVAL_SECONDS;
  if (seconds <= 0) return;
  const run = () => {
    void runServiceReportMailSweep().catch((err) => {
      console.error('[alto-people/api] service report mail sweep failed:', err);
    });
  };
  run();
  timer = setInterval(run, seconds * 1000);
  timer.unref();
  console.log(
    `[alto-people/api] service report mail cron armed (every ${seconds}s; Saturdays after ${env.SERVICE_REPORT_MAIL_HOUR}:00 org time, catching up through Monday)`,
  );
}

export function stopServiceReportMailCron(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
