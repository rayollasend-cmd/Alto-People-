import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { env } from '../config/env.js';
import { send } from './notifications.js';
import { ensureBrandingLoaded } from './branding.js';
import { buildPortalReport, portalScopeFor, renderPortalReportPdf } from './portalDayReport.js';
import { nextKey } from './portalMetrics.js';
import { genericNotificationTemplate } from './emailTemplates.js';
import { orgDateKey, startOfWeekUTC } from './timeAnomalies.js';

/**
 * The Saturday email — last week's service report, in the store
 * manager's inbox before the week starts.
 *
 * The org week ends Friday 24:00. On Saturday after SERVICE_REPORT_MAIL_HOUR
 * (org time), every ACTIVE portal account gets the completed week's
 * report as a PDF attachment, plus a bell row linking to History for
 * that week. One send per account per week (dedupe on the bell row).
 * The PDF is the same builder the Clients page and the portal download
 * use, so the numbers reconcile with the statement.
 */

const CATEGORY = 'portal.service_report';
const ORG_TZ = 'America/New_York';

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
  if (weekday !== 'Sat') return { sent: 0, skipped: 0, reason: 'not_saturday' };
  if (hour < env.SERVICE_REPORT_MAIL_HOUR) return { sent: 0, skipped: 0, reason: 'before_send_hour' };

  // Last completed org week: the one ending yesterday (Friday).
  const weekStart = new Date(startOfWeekUTC(now).getTime() - 7 * 24 * 3_600_000);
  const weekKey = orgDateKey(weekStart);

  const recipients = await prisma.user.findMany({
    where: { role: 'CLIENT_PORTAL', status: 'ACTIVE', deletedAt: null, clientId: { not: null } },
    select: { id: true, email: true, clientId: true, locationId: true, client: { select: { name: true } }, location: { select: { name: true } } },
    take: 500,
  });
  if (recipients.length === 0) return { sent: 0, skipped: 0, reason: 'no_recipients' };

  const branding = await ensureBrandingLoaded(prisma);
  // One build per (client, store): a store manager gets THEIR store's week.
  const pdfByScope = new Map<string, { pdf: Buffer; periodStart: string; periodEnd: string } | null>();
  const weekEndKey = nextKey(weekKey, 6);
  let sent = 0;
  let skipped = 0;
  for (const u of recipients) {
    const already = await prisma.notification.findFirst({
      where: {
        recipientUserId: u.id,
        category: CATEGORY,
        body: { contains: `[${weekKey}]` },
      },
      select: { id: true },
    });
    if (already) {
      skipped += 1;
      continue;
    }
    const scopeKey = `${u.clientId}|${u.locationId ?? ''}`;
    let built = pdfByScope.get(scopeKey);
    if (built === undefined) {
      const scope = await portalScopeFor(u.clientId!, u.locationId);
      if (scope) {
        const data = await buildPortalReport(scope, weekKey, weekEndKey, branding.orgName, now);
        built = { pdf: await renderPortalReportPdf(data), periodStart: data.from, periodEnd: data.to };
      } else built = null;
      pdfByScope.set(scopeKey, built);
    }
    if (!built) {
      skipped += 1;
      continue;
    }
    const storeName = u.location?.name ?? u.client?.name ?? 'your store';
    const subject = `${storeName}: your weekly service report (${built.periodStart} – ${built.periodEnd})`;
    const linkUrl = `/portal/history?range=lastWeek`;
    const bodyText =
      `Last week's service report for ${storeName} is attached — your store site, day by day: delivered against contract, coverage hour by hour, and every shift wave with who was on the floor.\n\n` +
      `Open History in your portal for the same week with every chart, or mark the report reviewed there. [${weekKey}]`;
    const tpl = genericNotificationTemplate({ subject, body: bodyText, linkUrl });
    let status: 'SENT' | 'FAILED' = 'SENT';
    try {
      await send({
        channel: 'EMAIL',
        recipient: { userId: u.id, phone: null, email: u.email },
        subject,
        body: tpl.text,
        html: tpl.html,
        attachments: [
          {
            filename: `service-report-${storeName.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}-${built.periodStart}.pdf`,
            content: built.pdf,
            contentType: 'application/pdf',
          },
        ],
      });
    } catch (err) {
      status = 'FAILED';
      console.warn('[service-report-mail] send failed:', err instanceof Error ? err.message : err);
    }
    // The bell row is the dedupe key AND the in-app pointer to History.
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
      },
    });
    if (status === 'SENT') sent += 1;
    else skipped += 1;
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
    `[alto-people/api] service report mail cron armed (every ${seconds}s; sends Saturdays after ${env.SERVICE_REPORT_MAIL_HOUR}:00 org time)`,
  );
}

export function stopServiceReportMailCron(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
