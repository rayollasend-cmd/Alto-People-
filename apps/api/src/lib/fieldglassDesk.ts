import ExcelJS from 'exceljs';
import type { PrismaClient } from '@prisma/client';
import type {
  FieldglassStatus,
  TimesheetIssue,
  TimesheetRow,
  TimesheetWeekResponse,
} from '@alto-people/shared';
import { zonedWallTimeToUtcInstant } from './timezone.js';
import { round2 } from './payroll.js';

/**
 * The Fieldglass desk — how Alto gets paid for a SOW worker's week:
 *
 *   register   the worker exists in the buyer's Fieldglass under the right
 *              client, with the Worker ID Fieldglass gave them
 *   enter      finance enters each worker's week into Fieldglass before the
 *              buyer's deadline (Monday 2:00 PM Pacific for the week ending
 *              the Friday before)
 *   approve    the buyer approves it in Fieldglass — approved is invoiced
 *   reconcile  the buyer's timesheet list, exported from Fieldglass and
 *              imported here, says what was approved, rejected or changed
 *
 * Hours for a worker who isn't registered can't be billed at all; a
 * rejected timesheet or a difference in hours is money at risk until it's
 * fixed. This module attaches all of that to the weekly timesheet.
 */

/** When the week's timesheets are due in Fieldglass: the Monday after the
 *  week-ending Friday, 2:00 PM Pacific (the Walmart SOW's cutoff). */
export const FIELDGLASS_DUE = { daysAfterWeekEnd: 3, minute: 14 * 60, timeZone: 'America/Los_Angeles' };

export function fieldglassDueAt(weekEndIso: string): Date {
  const [y, m, d] = weekEndIso.split('-').map(Number) as [number, number, number];
  const due = new Date(Date.UTC(y, m - 1, d + FIELDGLASS_DUE.daysAfterWeekEnd));
  return zonedWallTimeToUtcInstant(
    due.getUTCFullYear(),
    due.getUTCMonth() + 1,
    due.getUTCDate(),
    FIELDGLASS_DUE.minute,
    FIELDGLASS_DUE.timeZone,
  );
}

/** A Fieldglass status word, as the buyer's list writes it, in our terms. */
export function normalizeFieldglassStatus(raw: string | null | undefined): FieldglassStatus | null {
  const s = (raw ?? '').trim().toLowerCase();
  if (!s) return null;
  if (/invoic|paid|consumed/.test(s)) return 'INVOICED';
  if (/reject|return|recall/.test(s)) return 'REJECTED';
  // Before "approved": "Pending Approval" is waiting, not approved.
  if (/submit|pending|await|review/.test(s)) return 'SUBMITTED';
  if (/approv/.test(s)) return 'APPROVED';
  if (/draft|saved|not submitted|open/.test(s)) return 'DRAFT';
  return null;
}

type Db = Pick<PrismaClient, 'fieldglassRegistration' | 'fieldglassTimesheet' | 'client' | 'user'>;

/**
 * A worker's week in billing terms, in hours: approved by the buyer (what's
 * invoiced — Fieldglass's hours once it has them), awaiting the buyer, and
 * at risk — not registered, rejected, not entered yet, or fewer hours in
 * Fieldglass than worked.
 */
export function fieldglassHours(w: {
  registered: boolean;
  status: FieldglassStatus | null;
  entered: boolean;
  fgHours: number | null;
  total: number;
}): { approved: number; awaiting: number; atRisk: number } {
  const out = { approved: 0, awaiting: 0, atRisk: 0 };
  const billed = w.fgHours ?? w.total;
  if (!w.registered || w.status === 'REJECTED') out.atRisk = w.total;
  else if (w.status === 'APPROVED' || w.status === 'INVOICED') {
    out.approved = billed;
    if (billed < w.total) out.atRisk = w.total - billed;
  } else if (w.entered || w.status === 'SUBMITTED' || w.status === 'DRAFT') out.awaiting = w.total;
  else out.atRisk = w.total;
  return out;
}

/**
 * Attach each row's Fieldglass state, the NOT_IN_FIELDGLASS issues, and the
 * week's Fieldglass summary. `money` only when the sheet is one client with
 * a bill rate and the caller may see revenue.
 */
export async function attachFieldglass(
  db: Db,
  input: {
    rows: TimesheetRow[];
    weekStart: string;
    weekEndIso: string;
    clientId?: string;
    showMoney: boolean;
  },
): Promise<{ rows: TimesheetRow[]; issues: TimesheetIssue[]; summary: NonNullable<TimesheetWeekResponse['fieldglass']> }> {
  const ids = [...new Set(input.rows.map((r) => r.associateId))];
  const weekStartDate = new Date(`${input.weekStart}T00:00:00Z`);
  const [regs, sheets, client] = await Promise.all([
    ids.length
      ? db.fieldglassRegistration.findMany({
          where: { associateId: { in: ids } },
          select: { associateId: true, clientId: true, workerId: true },
        })
      : Promise.resolve([]),
    ids.length
      ? db.fieldglassTimesheet.findMany({
          where: { weekStart: weekStartDate, associateId: { in: ids } },
        })
      : Promise.resolve([]),
    input.clientId
      ? db.client.findUnique({ where: { id: input.clientId }, select: { fieldglassBillRate: true } })
      : Promise.resolve(null),
  ]);
  const enteredByIds = [...new Set(sheets.map((s) => s.enteredById).filter((x): x is string => !!x))];
  const users = enteredByIds.length
    ? await db.user.findMany({
        where: { id: { in: enteredByIds } },
        select: { id: true, email: true, associate: { select: { firstName: true, lastName: true } } },
      })
    : [];
  const nameOf = new Map(
    users.map((u) => [u.id, u.associate ? `${u.associate.firstName} ${u.associate.lastName}` : u.email]),
  );
  const regOf = new Map(regs.map((r) => [r.associateId, r]));
  const sheetOf = new Map(sheets.map((s) => [`${s.associateId}|${s.clientId}`, s]));

  const issues: TimesheetIssue[] = [];
  let entered = 0;
  let notRegistered = 0;
  let submitted = 0;
  let approved = 0;
  let rejected = 0;
  let variances = 0;
  let syncedAt: Date | null = null;
  const hoursBy = { approved: 0, awaiting: 0, atRisk: 0 };

  const rows = input.rows.map((row) => {
    if (!row.clientId) return { ...row, fieldglass: null };
    const reg = regOf.get(row.associateId);
    const registered = !!reg && reg.clientId === row.clientId;
    const sheet = sheetOf.get(`${row.associateId}|${row.clientId}`);
    const status = (sheet?.fgStatus as FieldglassStatus | null | undefined) ?? null;
    const fgHours = sheet?.fgHours != null ? Number(sheet.fgHours) : null;
    if (sheet?.fgSyncedAt && (!syncedAt || sheet.fgSyncedAt > syncedAt)) syncedAt = sheet.fgSyncedAt;
    if (!registered && row.total > 0) {
      notRegistered += 1;
      issues.push({
        kind: 'NOT_IN_FIELDGLASS',
        associateId: row.associateId,
        worker: row.worker,
        detail: reg
          ? `${row.total.toFixed(2)}h here, but they're registered in Fieldglass under another client — move them before you enter the week.`
          : `${row.total.toFixed(2)}h can't be billed — they aren't registered in Fieldglass yet.`,
      });
    }
    if (sheet?.enteredAt) entered += 1;
    if (status === 'SUBMITTED') submitted += 1;
    if (status === 'APPROVED' || status === 'INVOICED') approved += 1;
    if (status === 'REJECTED') rejected += 1;
    const differs = fgHours !== null && Math.abs(fgHours - row.total) >= 0.01;
    if (differs) variances += 1;
    const h = fieldglassHours({ registered, status, entered: !!sheet?.enteredAt, fgHours, total: row.total });
    hoursBy.approved += h.approved;
    hoursBy.awaiting += h.awaiting;
    hoursBy.atRisk += h.atRisk;
    return {
      ...row,
      fieldglass: {
        registered,
        workerId: registered ? (reg?.workerId ?? null) : null,
        enteredAt: sheet?.enteredAt?.toISOString() ?? null,
        enteredBy: sheet?.enteredById ? (nameOf.get(sheet.enteredById) ?? null) : null,
        enteredHours: sheet?.enteredHours != null ? Number(sheet.enteredHours) : null,
        status,
        timesheetId: sheet?.fgTimesheetId ?? null,
        revision: sheet?.fgRevision ?? null,
        hours: fgHours,
        syncedAt: sheet?.fgSyncedAt?.toISOString() ?? null,
        comment: sheet?.fgComment ?? null,
        resubmittedAt: sheet?.resubmittedAt?.toISOString() ?? null,
        note: sheet?.note ?? null,
      },
    };
  });

  const rate = client?.fieldglassBillRate != null ? Number(client.fieldglassBillRate) : null;
  return {
    rows,
    issues,
    summary: {
      dueAt: fieldglassDueAt(input.weekEndIso).toISOString(),
      workers: rows.filter((r) => r.fieldglass).length,
      entered,
      notRegistered,
      submitted,
      approved,
      rejected,
      variances,
      syncedAt: (syncedAt as Date | null)?.toISOString() ?? null,
      money:
        input.showMoney && rate !== null
          ? {
              billRate: rate,
              approved: round2(hoursBy.approved * rate),
              awaiting: round2(hoursBy.awaiting * rate),
              atRisk: round2(hoursBy.atRisk * rate),
            }
          : null,
    },
  };
}

/* ----- The buyer's timesheet list, imported back ------------------------- */

export interface FieldglassListRow {
  status: FieldglassStatus | null;
  statusText: string;
  timesheetId: string | null;
  revision: number | null;
  worker: string;
  workerId: string | null;
  site: string | null;
  /** The week-ending date, YYYY-MM-DD. */
  weekEnd: string;
  hours: number;
  /** The buyer's comment — often why it was rejected. */
  comment: string | null;
}

/** The list's columns, by the names Fieldglass (and buyers' custom
 *  views) give them. */
const HEADERS = {
  status: /^status$|timesheet status/,
  timesheetId: /^id$|timesheet id|timesheet #|^timesheet$/,
  revision: /^rev(ision)?$/,
  worker: /^worker$|worker name|^name$/,
  workerId: /worker id|worker #/,
  site: /^site$|location/,
  end: /^end$|end date|week ending|period end|period$/,
  total: /^total$|total hours|billable hours|^hours$/,
  comment: /comment|reason|^notes?$/,
};

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    const o = v as { text?: string; result?: unknown; richText?: Array<{ text: string }> };
    if (o.richText) return o.richText.map((r) => r.text).join('');
    if (o.text !== undefined) return String(o.text);
    if (o.result !== undefined) return cellText(o.result);
  }
  return String(v).trim();
}

function isoDate(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const t = cellText(v);
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (m) return `${m[3]}-${m[1]!.padStart(2, '0')}-${m[2]!.padStart(2, '0')}`;
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

function csvRows(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',' || c === '\t') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      out.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    out.push(row);
  }
  return out;
}

/** Read the buyer's Fieldglass timesheet list (.xlsx or .csv): finds the
 *  header row by its column names, so letterheads and extra columns are
 *  fine. Rows without a worker, week-ending date or hours are skipped. */
export async function parseFieldglassList(buf: Buffer, filename: string): Promise<FieldglassListRow[]> {
  let grid: unknown[][];
  if (/\.csv$|\.txt$/i.test(filename)) {
    grid = csvRows(buf.toString('utf8'));
  } else {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    grid = [];
    ws?.eachRow({ includeEmpty: false }, (r) => {
      const vals = r.values as unknown[];
      grid.push(vals.slice(1));
    });
  }
  const headerAt = grid.findIndex((r) => {
    const t = r.map((c) => cellText(c).toLowerCase());
    return t.some((x) => HEADERS.worker.test(x)) && t.some((x) => HEADERS.total.test(x) || HEADERS.end.test(x));
  });
  if (headerAt < 0) return [];
  const header = grid[headerAt]!.map((c) => cellText(c).toLowerCase());
  const col = (re: RegExp) => header.findIndex((h) => re.test(h));
  const at = {
    status: col(HEADERS.status),
    id: col(HEADERS.timesheetId),
    rev: col(HEADERS.revision),
    worker: col(HEADERS.worker),
    workerId: col(HEADERS.workerId),
    site: col(HEADERS.site),
    end: col(HEADERS.end),
    total: col(HEADERS.total),
    comment: col(HEADERS.comment),
  };
  const out: FieldglassListRow[] = [];
  for (const r of grid.slice(headerAt + 1)) {
    const worker = at.worker >= 0 ? cellText(r[at.worker]) : '';
    const weekEnd = at.end >= 0 ? isoDate(r[at.end]) : null;
    const hoursText = at.total >= 0 ? cellText(r[at.total]).replace(/[^0-9.]/g, '') : '';
    if (!worker || !weekEnd || hoursText === '') continue;
    const statusText = at.status >= 0 ? cellText(r[at.status]) : '';
    const rev = at.rev >= 0 ? Number.parseInt(cellText(r[at.rev]), 10) : Number.NaN;
    out.push({
      status: normalizeFieldglassStatus(statusText),
      statusText,
      timesheetId: at.id >= 0 ? cellText(r[at.id]) || null : null,
      revision: Number.isFinite(rev) ? rev : null,
      worker,
      workerId: at.workerId >= 0 ? cellText(r[at.workerId]) || null : null,
      site: at.site >= 0 ? cellText(r[at.site]) || null : null,
      weekEnd,
      hours: round2(Number(hoursText)),
      comment: at.comment >= 0 ? cellText(r[at.comment]).slice(0, 500) || null : null,
    });
  }
  return out;
}

/** "Nelson, Aaliyah M." / "Aaliyah Nelson" → a comparable key. */
export function workerKey(name: string): string {
  const clean = name.toLowerCase().replace(/[^a-z,\s'-]/g, ' ').replace(/\s+/g, ' ').trim();
  const [last, first] = clean.includes(',')
    ? clean.split(',').map((x) => x.trim())
    : (() => {
        const parts = clean.split(' ');
        return [parts.at(-1) ?? '', parts.slice(0, -1).join(' ')];
      })();
  return `${last}|${(first ?? '').split(' ')[0] ?? ''}`;
}
