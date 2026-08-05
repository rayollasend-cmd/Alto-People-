import type {
  PrismaClient,
  Report,
  ReportScheduleCadence,
} from '@prisma/client';
import { toCsv } from '@alto-people/shared';
import { prisma as defaultPrisma } from '../db.js';
import { env } from '../config/env.js';
import { send } from './notifications.js';
import { enqueueAudit } from './audit.js';
import { scheduledReportTemplate } from './emailTemplates.js';
import { ENTITY_COLUMNS, SpecSchema, runReport } from './reportRun.js';
import type { SessionUser } from '../types/express.js';

/**
 * Scheduled-report delivery sweep.
 *
 * ReportSchedule rows were persisted by POST /reports/:id/schedules but
 * nothing ever executed them — cadence/recipients/nextRunAt were stored
 * and silently never delivered. This runner closes that loop:
 *
 *   - every tick, pick schedules with nextRunAt <= now (active only,
 *     report not soft-deleted),
 *   - execute the report AS ITS CREATOR so the same tenant scoping that
 *     guards the /run route guards the emailed CSV (an orphaned or
 *     deactivated creator fails the schedule instead of running unscoped),
 *   - serialize rows to CSV via the shared @alto-people/shared helper
 *     (RFC-4180 quoting + UTF-8 BOM + formula-injection guard — byte-
 *     identical to the web's Export CSV button),
 *   - email the CSV as an attachment to each stored recipient (plain
 *     email; recipients were validated as users at schedule-create time
 *     but delivery does NOT require a User row to still exist),
 *   - advance nextRunAt from the schedule's CURRENT nextRunAt (never from
 *     `now` — that would drift the delivery time later on every run), and
 *     if the schedule is overdue by multiple periods, catch up by
 *     advancing until the result is in the future,
 *   - stamp lastRunAt/lastStatus. Failures also advance nextRunAt so a
 *     permanently-broken schedule fails once per period instead of
 *     hot-looping every tick.
 *
 * Dedupe/advancement is driven purely by the schedule's own stamps
 * (nextRunAt / lastRunAt), never createdAt — the function takes an
 * injected `now` and must behave identically regardless of when rows
 * were inserted.
 */

/** Hard cap on rows in an emailed CSV, independent of the spec's limit. */
export const REPORT_SCHEDULE_ROW_CAP = 10_000;

/** Schedules processed per sweep tick; the rest stay due for the next tick. */
const BATCH = 50;

// Fixed cadence periods, matching nextRunFor() in routes/reports96.ts
// (MONTHLY is "roughly 30 days" there too — keep the two in agreement).
const PERIOD_MS: Record<ReportScheduleCadence, number> = {
  DAILY: 24 * 3600 * 1000,
  WEEKLY: 7 * 24 * 3600 * 1000,
  MONTHLY: 30 * 24 * 3600 * 1000,
};

/**
 * Advance from the CURRENT nextRunAt by whole cadence periods until the
 * result is strictly in the future. Anchoring on the stored nextRunAt
 * (not `now`) keeps the delivery time stable run-over-run; the loop
 * catches up a schedule that was overdue across several periods (e.g.
 * the API was down for a week) without queueing make-up sends.
 */
export function advanceNextRunAt(
  current: Date,
  cadence: ReportScheduleCadence,
  now: Date,
): Date {
  const period = PERIOD_MS[cadence];
  let next = current.getTime();
  do {
    next += period;
  } while (next <= now.getTime());
  return new Date(next);
}

/**
 * Serialize report rows to CSV text. Header row is the spec's public
 * column keys; values are read through the ENTITY_COLUMNS map because
 * runReport() returns rows keyed by the underlying Prisma field (e.g.
 * public "clockIn" → row.clockInAt). Cell rendering mirrors the web's
 * Export CSV (null/undefined → '', numbers pass through, objects
 * JSON-stringified) with server-side additions for values that reach the
 * wire pre-serialized in the browser: Date → ISO string, Prisma Decimal →
 * its numeric string. Quoting/BOM/formula-guarding come from the shared
 * toCsv helper, so the emailed file is byte-identical to a browser export.
 */
export function buildReportCsv(
  entity: string,
  columns: string[],
  rows: Array<Record<string, unknown>>,
): string {
  const colMap = ENTITY_COLUMNS[entity] ?? {};
  const cell = (v: unknown): string | number => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return v;
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'object') {
      // Prisma Decimal (duck-typed via toFixed) serializes to its numeric
      // string on the JSON wire — match that here.
      if (typeof (v as { toFixed?: unknown }).toFixed === 'function') {
        return String(v);
      }
      return JSON.stringify(v);
    }
    return String(v);
  };
  return toCsv([
    columns,
    ...rows.map((r) => columns.map((c) => cell(r[colMap[c] ?? c]))),
  ]);
}

export interface ScheduleRunError {
  scheduleId: string;
  error: string;
}

export interface RunDueSchedulesResult {
  /** Due schedules picked up this tick. */
  scanned: number;
  /** Schedules whose report ran and reached at least one recipient. */
  delivered: number;
  /** Schedules that failed (owner gone, bad spec, all sends failed, ...). */
  failed: number;
  errors: ScheduleRunError[];
}

/**
 * Resolve the SessionUser the report executes as: its creator, who must
 * still be an ACTIVE, non-deleted user. Throwing here fails the schedule
 * (status recorded, nextRunAt advanced) rather than running unscoped.
 */
async function resolveRunAsUser(
  prisma: PrismaClient,
  report: Report,
): Promise<SessionUser> {
  if (!report.createdById) {
    throw new Error('report_owner_missing: report has no creator to run as');
  }
  const u = await prisma.user.findFirst({
    where: { id: report.createdById, status: 'ACTIVE', deletedAt: null },
  });
  if (!u) {
    throw new Error('report_owner_inactive: report creator is not an active user');
  }
  return {
    id: u.id,
    email: u.email,
    role: u.role,
    status: u.status,
    clientId: u.clientId,
    associateId: u.associateId,
    tokenVersion: u.tokenVersion,
    firstName: null,
    lastName: null,
    photoUrl: null,
    timezone: u.timezone,
    mfaEnabled: u.mfaEnabledAt !== null,
  };
}

export async function runDueReportSchedules(
  prisma: PrismaClient = defaultPrisma,
  now: Date = new Date(),
  opts: { rowCap?: number } = {},
): Promise<RunDueSchedulesResult> {
  const rowCap = opts.rowCap ?? REPORT_SCHEDULE_ROW_CAP;

  const due = await prisma.reportSchedule.findMany({
    where: {
      isActive: true,
      nextRunAt: { lte: now },
      report: { is: { deletedAt: null } },
    },
    include: { report: true },
    orderBy: { nextRunAt: 'asc' },
    take: BATCH,
  });

  const errors: ScheduleRunError[] = [];
  let delivered = 0;
  let failed = 0;

  for (const schedule of due) {
    const nextRunAt = advanceNextRunAt(schedule.nextRunAt, schedule.cadence, now);
    try {
      const report = schedule.report;
      const runAs = await resolveRunAsUser(prisma, report);
      const spec = SpecSchema.parse(report.spec);

      // Fetch one row past the cap so truncation is detected exactly,
      // then trim. The spec's own limit still applies when smaller.
      const cap = Math.min(spec.limit, rowCap);
      const fetched = (await runReport(
        report.entity,
        { ...spec, limit: cap + 1 },
        runAs,
        prisma,
      )) as Array<Record<string, unknown>>;
      const truncated = fetched.length > cap;
      const rows = truncated ? fetched.slice(0, cap) : fetched;

      const csv = buildReportCsv(report.entity, spec.columns, rows);
      const runDate = now.toISOString().slice(0, 10);
      const tpl = scheduledReportTemplate({
        reportName: report.name,
        runDate,
        cadence: schedule.cadence,
        rowCount: rows.length,
        truncated,
        rowCap: cap,
        reportsUrl: `${env.APP_BASE_URL}/reports`,
      });
      const filename = `${report.name.replace(/[^A-Za-z0-9_-]+/g, '_')}-${runDate}.csv`;
      const attachment = {
        filename,
        content: Buffer.from(csv, 'utf8'),
        contentType: 'text/csv',
      };

      const recipients = schedule.recipients
        .split(/[,;]/)
        .map((e) => e.trim())
        .filter(Boolean);
      let sent = 0;
      const sendFailures: string[] = [];
      for (const email of recipients) {
        let failureReason: string | null = null;
        let externalRef: string | null = null;
        try {
          const r = await send({
            channel: 'EMAIL',
            recipient: { userId: null, phone: null, email },
            subject: tpl.subject,
            body: tpl.text,
            html: tpl.html,
            attachments: [attachment],
          });
          externalRef = r.externalRef;
        } catch (err) {
          failureReason = err instanceof Error ? err.message : String(err);
        }
        await prisma.notification.create({
          data: {
            channel: 'EMAIL',
            status: failureReason ? 'FAILED' : 'SENT',
            recipientUserId: null,
            recipientEmail: email,
            subject: tpl.subject,
            body: tpl.text,
            category: 'reports.schedule_delivered',
            externalRef,
            failureReason,
            sentAt: failureReason ? null : now,
          },
        });
        if (failureReason) sendFailures.push(`${email}: ${failureReason}`);
        else sent++;
      }

      if (sent === 0) {
        throw new Error(
          `all sends failed — ${sendFailures.join('; ')}`.slice(0, 500),
        );
      }

      const lastStatus =
        sent === recipients.length
          ? 'SUCCESS'
          : `PARTIAL (${sent}/${recipients.length} delivered)`;
      await prisma.reportSchedule.update({
        where: { id: schedule.id },
        data: { lastRunAt: now, lastStatus, nextRunAt },
      });
      enqueueAudit(
        {
          actorUserId: null,
          clientId: null,
          action: 'reports.schedule_delivered',
          entityType: 'ReportSchedule',
          entityId: schedule.id,
          metadata: {
            reportId: report.id,
            reportName: report.name,
            cadence: schedule.cadence,
            recipientCount: recipients.length,
            deliveredCount: sent,
            rowCount: rows.length,
            truncated,
          },
        },
        'runDueReportSchedules',
      );
      delivered++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ scheduleId: schedule.id, error: msg });
      failed++;
      // Record the failure AND advance nextRunAt — a broken schedule
      // retries next period, not on every 5-minute tick.
      try {
        await prisma.reportSchedule.update({
          where: { id: schedule.id },
          data: {
            lastRunAt: now,
            lastStatus: `FAILED: ${msg}`.slice(0, 500),
            nextRunAt,
          },
        });
      } catch (updateErr) {
        console.error(
          '[alto-people/api] failed to record report-schedule failure',
          schedule.id,
          updateErr,
        );
      }
    }
  }

  return { scanned: due.length, delivered, failed, errors };
}

let timer: NodeJS.Timeout | null = null;

export function startReportScheduleCron(): void {
  if (timer) return;
  const seconds = env.REPORT_SCHEDULE_INTERVAL_SECONDS;
  if (seconds <= 0) return;
  const tick = () => {
    void runDueReportSchedules().catch((err) => {
      console.error('[alto-people/api] report schedule sweep failed:', err);
    });
  };
  tick();
  timer = setInterval(tick, seconds * 1000);
  timer.unref();
  console.log(
    `[alto-people/api] report schedule cron armed (every ${seconds}s; row cap ${REPORT_SCHEDULE_ROW_CAP})`,
  );
}

export function stopReportScheduleCron(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
