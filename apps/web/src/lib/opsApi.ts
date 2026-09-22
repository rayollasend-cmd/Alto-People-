import { apiFetch } from './api';

/**
 * Store Operations client — the shift supervisor's floor tool plus the
 * leadership library/board/scorecard. Types mirror the /ops routes.
 */

export type OpsPeriod = 'MORNING' | 'EVENING' | 'CLOSING' | 'OVERNIGHT';
export type OpsResponseType =
  | 'CHECK'
  | 'YES_NO'
  | 'YES_NO_PARTIAL'
  | 'TEXT'
  | 'NUMBER'
  | 'TEMPERATURE'
  | 'PHOTO';
export type OpsTaskStatus = 'OPEN' | 'IN_PROGRESS' | 'DONE' | 'BLOCKED';
export type OpsPriority = 'HIGH' | 'MEDIUM' | 'LOW';
export type OpsHandoverKind =
  | 'NOTE'
  | 'UNFINISHED_TASK'
  | 'SPECIAL_ORDER'
  | 'COACH_COMPLAINT'
  | 'EQUIPMENT'
  | 'STOCKING';

export interface OpsShiftHeader {
  id: string;
  clientId: string;
  clientName?: string | null;
  department: string;
  period: OpsPeriod;
  position: string;
  dateKey: string;
  status: 'ACTIVE' | 'CLOSED';
  openedAt: string;
  closedAt: string | null;
  openedByEmail?: string;
  scheduledHeadcount: number;
  actualHeadcount: number;
  templateName: string | null;
  sopTotal: number;
  sopDone: number;
  taskTotal: number;
  taskDone: number;
  closedIncomplete: boolean;
  tempAlerts: number;
  closingSummary: string | null;
  /** Store-shift SOP (opened at clock-in): its window, and when it's due. */
  windowLabel?: string | null;
  locationId?: string | null;
  /** The store, on the checklist detail (store-shift SOPs). */
  locationName?: string | null;
  dueAt?: string | null;
  incompleteReason?: string | null;
  handoverNone?: boolean;
  /** The account that opened the shift, and the account that SUBMITTED
   *  it. Usually the same login, and not always — a floor supervisor can
   *  close for the lead who ran it, and a record has to say which. */
  openedByAccount?: string | null;
  submittedByAccount?: string | null;
  /** Who runs it (must submit it), who submitted it, and — a floor
   *  supervisor covering — the lead they're covering for. On the detail. */
  runBy?: { id: string; name: string; email?: string } | null;
  submittedBy?: { id: string; name: string; email?: string } | null;
  coveringFor?: { id: string; name: string; email?: string } | null;
  /** On the board and lists. */
  coveringForName?: string | null;
}

export type OpsFollowUpOn = 'NO' | 'NO_OR_PARTIAL' | 'OUT_OF_RANGE';

export interface OpsTaskRow {
  id: string;
  source: 'SOP' | 'ADHOC' | 'CARRYOVER' | 'FOLLOWUP';
  section: string | null;
  order: number;
  title: string;
  instructions: string | null;
  priority: OpsPriority;
  status: OpsTaskStatus;
  responseType: OpsResponseType;
  required: boolean;
  photoRequired: boolean;
  tempLabel: string | null;
  tempMin: number | null;
  tempMax: number | null;
  metricKey: string | null;
  unit: string | null;
  parentTaskId: string | null;
  answerChoice: 'YES' | 'NO' | 'PARTIAL' | null;
  answerNumber: number | null;
  answerText: string | null;
  tempOutOfRange: boolean;
  note: string | null;
  blockedReason: string | null;
  completedAt: string | null;
  /** When its block is due, on this shift's clock (null: untimed). */
  dueAt: string | null;
  doneAssociate: { id: string; name: string } | null;
  photos: { id: string; filename: string; createdAt: string }[];
}

export interface OpsHandoverRow {
  id: string;
  kind: OpsHandoverKind;
  body: string;
  priority: OpsPriority;
  status: 'PENDING' | 'CARRIED' | 'DISMISSED' | 'REVIEWED';
  createdAt: string;
  decidedAt: string | null;
  from: { shiftId: string; position: string; period: OpsPeriod; dateKey: string };
  decidedByEmail: string | null;
}

export interface OpsShiftDetail {
  shift: OpsShiftHeader & { clientName: string | null };
  /** What the viewer may do: run it (submit, hand over), help on it
   *  (check items off — a floor supervisor on their lead's SOP), or read. */
  access?: 'run' | 'help' | 'view';
  tasks: OpsTaskRow[];
  handoverOut: OpsHandoverRow[];
  handoverIn: OpsHandoverRow[];
  clockedIn: { id: string; name: string }[];
}

export interface OpsLibraryTemplate {
  id: string;
  name: string;
  department: string;
  period: OpsPeriod;
  description: string | null;
  active: boolean;
  taskCount: number;
  /** Closed runs in the last 28 days + their aggregate SOP completion. */
  runs28d: number;
  avgSopPct: number | null;
  tasks: {
    id: string;
    section: string;
    order: number;
    title: string;
    instructions: string | null;
    responseType: OpsResponseType;
    required: boolean;
    photoRequired: boolean;
    tempLabel: string | null;
    tempMin: number | null;
    tempMax: number | null;
    metricKey: string | null;
    unit: string | null;
    followUpOn: OpsFollowUpOn | null;
    /** "HH:MM" — when its block is due at the store. */
    dueTime: string | null;
    /** How this LINE of the standard performs in practice (28d). */
    stats: {
      runs: number;
      done: number;
      noCount: number;
      partialCount: number;
      outOfRange: number;
    };
  }[];
}

/** Human labels for the seeded metric keys. */
export const METRIC_LABEL: Record<string, string> = {
  cases_stocked: 'Cases stocked',
  items_discarded: 'Items discarded',
  items_marked_down: 'Items marked down',
  oos_found: 'Out-of-stocks found',
  pallets_received: 'Pallets received',
  price_changes: 'Price changes',
  picks_worked: 'Picks worked',
  overstock_binned: 'Overstock binned',
  claims_processed: 'Claims processed',
  returns_worked: 'Returns worked',
  donations_logged: 'Donations logged',
  freight_left: 'Freight left',
  recorded: 'Recorded',
};

export function metricLabel(key: string): string {
  return (
    METRIC_LABEL[key] ??
    key.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
  );
}

export function getOpsLibrary(): Promise<{
  departments: string[];
  templates: OpsLibraryTemplate[];
}> {
  return apiFetch('/ops/library');
}

export function createOpsTemplate(body: {
  name: string;
  department: string;
  period: OpsPeriod;
  description?: string;
}): Promise<{ id: string }> {
  return apiFetch('/ops/library/templates', { method: 'POST', body });
}

export function patchOpsTemplate(
  id: string,
  body: { name?: string; description?: string | null; active?: boolean; retire?: boolean },
): Promise<{ ok: true }> {
  return apiFetch(`/ops/library/templates/${id}`, { method: 'PATCH', body });
}

export function addOpsTemplateTask(
  templateId: string,
  body: {
    section: string;
    title: string;
    instructions?: string;
    responseType?: OpsResponseType;
    required?: boolean;
    photoRequired?: boolean;
    tempLabel?: string;
    tempMin?: number;
    tempMax?: number;
    dueTime?: string | null;
  },
): Promise<{ id: string }> {
  return apiFetch(`/ops/library/templates/${templateId}/tasks`, { method: 'POST', body });
}

/** Time a whole block: every task in the section is due by `dueTime`. */
export function setOpsSectionDue(
  templateId: string,
  body: { section: string; dueTime: string | null },
): Promise<{ ok: true; updated: number }> {
  return apiFetch(`/ops/library/templates/${templateId}/sections`, { method: 'PATCH', body });
}

/** Edit a task in the standard (run shifts keep their snapshots). */
export function patchOpsTemplateTask(
  taskId: string,
  body: {
    section?: string;
    title?: string;
    instructions?: string | null;
    responseType?: OpsResponseType;
    required?: boolean;
    photoRequired?: boolean;
    tempLabel?: string | null;
    tempMin?: number | null;
    tempMax?: number | null;
    metricKey?: string | null;
    unit?: string | null;
    followUpOn?: OpsFollowUpOn | null;
    followUpRequirePhoto?: boolean;
    followUpTaskTitle?: string | null;
    dueTime?: string | null;
  },
): Promise<{ ok: true }> {
  return apiFetch(`/ops/library/tasks/${taskId}`, { method: 'PATCH', body });
}

export function deleteOpsTemplateTask(taskId: string): Promise<void> {
  return apiFetch(`/ops/library/tasks/${taskId}`, { method: 'DELETE' });
}

/** Today's positions to open. `clientId` is for org-wide roles (ops, HR)
 *  covering a floor; a supervisor's own client is applied server-side. */
export function getOpsOpenOptions(clientId?: string): Promise<{
  clientId: string;
  dateKey: string;
  resumeShift: { id: string; position: string; department: string } | null;
  positions: {
    position: string;
    scheduledCount: number;
    department: string | null;
    period: OpsPeriod;
  }[];
  departments: string[];
}> {
  return apiFetch(
    `/ops/open-options${clientId ? `?clientId=${encodeURIComponent(clientId)}` : ''}`,
  );
}

export function openOpsShift(body: {
  clientId?: string;
  position: string;
  department?: string;
}): Promise<{ shiftId: string; resumed: boolean }> {
  return apiFetch('/ops/shifts/open', { method: 'POST', body });
}

export function getOpsShift(id: string): Promise<OpsShiftDetail> {
  return apiFetch(`/ops/shifts/${id}`);
}

export function addOpsAdhocTask(
  shiftId: string,
  body: {
    title: string;
    instructions?: string;
    priority?: OpsPriority;
    responseType?: OpsResponseType;
  },
): Promise<{ task: OpsTaskRow }> {
  return apiFetch(`/ops/shifts/${shiftId}/tasks`, { method: 'POST', body });
}

export function patchOpsTask(
  taskId: string,
  body: {
    status?: OpsTaskStatus;
    answerChoice?: 'YES' | 'NO' | 'PARTIAL' | null;
    answerNumber?: number | null;
    answerText?: string | null;
    note?: string | null;
    blockedReason?: string | null;
    doneAssociateId?: string | null;
    priority?: OpsPriority;
  },
): Promise<{ task: OpsTaskRow; followUp?: OpsTaskRow | null }> {
  return apiFetch(`/ops/tasks/${taskId}`, { method: 'PATCH', body });
}

export async function uploadOpsTaskPhoto(
  taskId: string,
  file: File,
): Promise<{
  photo: { id: string; filename: string; createdAt: string };
  /** True when the upload completed a PHOTO-response task in one gesture. */
  autoCompleted?: boolean;
}> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`/api/ops/tasks/${taskId}/photos`, {
    method: 'POST',
    credentials: 'include',
    body: form,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw new Error(body?.error?.message ?? `Upload failed (${res.status})`);
  }
  return (await res.json()) as {
    photo: { id: string; filename: string; createdAt: string };
    autoCompleted?: boolean;
  };
}

export type OpsPacketKind = 'shift' | 'day' | 'month';

/**
 * The SOP packet, as a URL. A browser download, not a fetch: the response
 * is a PDF with a Content-Disposition, and letting the browser handle it
 * keeps the iOS behaviour the mobile doctrine asks for.
 */
export function opsPacketUrl(
  kind: OpsPacketKind,
  q: {
    shiftId?: string;
    dateKey?: string;
    month?: string;
    locationId?: string;
    clientId?: string;
    period?: string;
    department?: string;
  } = {},
): string {
  const params = new URLSearchParams({ kind });
  for (const [k, v] of Object.entries(q)) if (v) params.set(k, String(v));
  return `/api/ops/packet.pdf?${params.toString()}`;
}

export function opsPhotoUrl(photoId: string): string {
  return `/api/ops/photos/${photoId}`;
}

export function addOpsHandover(
  shiftId: string,
  items: { kind: OpsHandoverKind; body: string; priority?: OpsPriority }[],
): Promise<{ added: number }> {
  return apiFetch(`/ops/shifts/${shiftId}/handover`, { method: 'POST', body: { items } });
}

export function decideOpsHandover(
  itemId: string,
  body: { action: 'CARRY' | 'DISMISS' | 'REVIEW'; shiftId: string },
): Promise<{ ok: true; carriedTaskId: string | null }> {
  return apiFetch(`/ops/handover/${itemId}/decide`, { method: 'POST', body });
}

/**
 * Void an SOP opened by mistake — the afternoon supervisor who picked the
 * morning standard. HR only (manage:ops-library); the supervisor running
 * it cannot, or the clock-out gate would mean nothing. Lifts the gate and
 * frees the occurrence so the right SOP can be opened.
 */
export function cancelOpsShift(
  shiftId: string,
  reason: string,
): Promise<{ ok: true; id: string }> {
  return apiFetch(`/ops/shifts/${shiftId}/cancel`, {
    method: 'POST',
    body: { reason },
  });
}

/** Submit the SOP. Every submit hands over (a note on the shift, or
 *  `handoverNone`); required items still open need `incompleteReason`. */
export function closeOpsShift(
  shiftId: string,
  opts: { summary?: string; handoverNone?: boolean; incompleteReason?: string } = {},
): Promise<{ shift: OpsShiftHeader }> {
  return apiFetch(`/ops/shifts/${shiftId}/close`, {
    method: 'POST',
    body: {
      ...(opts.summary ? { summary: opts.summary } : {}),
      ...(opts.handoverNone ? { handoverNone: true } : {}),
      ...(opts.incompleteReason ? { incompleteReason: opts.incompleteReason } : {}),
    },
  });
}

export type OpsShiftRow = OpsShiftHeader & {
  clientName: string;
  openedByEmail: string;
  coveringForName?: string | null;
  /** Every department the supervisor carried, not just the filing one. */
  departments?: string[];
  /** 0-100, or null when the shift carried no checklist. */
  completionPct?: number | null;
};

/** How a list of shifts may be ordered. */
export type OpsSort = 'recent' | 'worst' | 'store';

export interface OpsHistoryQuery {
  from?: string;
  to?: string;
  locationId?: string;
  clientId?: string;
  period?: string;
  department?: string;
  status?: 'ACTIVE' | 'CLOSED';
  sort?: OpsSort;
}

/**
 * The record, not the wall: shifts over a date range, narrowed to a store,
 * a period and a department, ordered by what matters.
 */
export function getOpsHistory(q: OpsHistoryQuery = {}): Promise<{
  range: { from: string; to: string };
  generatedAt: string;
  sort: OpsSort;
  truncated: boolean;
  shifts: OpsShiftRow[];
}> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v) params.set(k, String(v));
  const qs = params.toString();
  return apiFetch(`/ops/history${qs ? `?${qs}` : ''}`);
}

/** The stores that have run an ops shift, for the board's picker. */
export function getOpsStores(): Promise<{
  stores: { id: string; name: string; clientName: string | null }[];
  /** Shifts with no store on them — the caveat on any per-store number. */
  unplaced: number;
}> {
  return apiFetch('/ops/stores');
}

export function listOpsShifts(params?: {
  clientId?: string;
  status?: 'ACTIVE' | 'CLOSED';
  dateKey?: string;
}): Promise<{ shifts: (OpsShiftHeader & { clientName: string; openedByEmail: string })[] }> {
  const q = new URLSearchParams();
  if (params?.clientId) q.set('clientId', params.clientId);
  if (params?.status) q.set('status', params.status);
  if (params?.dateKey) q.set('dateKey', params.dateKey);
  const qs = q.toString();
  return apiFetch(`/ops/shifts${qs ? `?${qs}` : ''}`);
}

export function getOpsBoard(
  filters: { locationId?: string; period?: string; department?: string } = {},
): Promise<{
  dateKey: string;
  /** When the server answered — a frozen board and a quiet floor look
   *  identical without it. */
  generatedAt: string;
  active: OpsShiftRow[];
  /** Shifts that CLOSED today, including an overnight that opened
   *  yesterday — it used to match neither list and disappear. */
  closedToday: OpsShiftRow[];
}> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
  const qs = params.toString();
  return apiFetch(`/ops/board${qs ? `?${qs}` : ''}`);
}

export interface OpsStoreWindow {
  name: string;
  liveShifts: number;
  departments: string[];
  floor: number;
  tempAlertsToday: number;
  sopPct: number | null;
  incompleteToday: number;
}

export interface OpsScopeFilters {
  locationId?: string;
  clientId?: string;
  period?: string;
  department?: string;
}

const scopeQs = (f: OpsScopeFilters) => {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v) params.set(k, String(v));
  const qs = params.toString();
  return qs ? `?${qs}` : '';
};

/** The chairman's drawn window: store snapshots, temps, rhythm, trend. */
export function getOpsInsights(filters: OpsScopeFilters = {}): Promise<{
  stores: OpsStoreWindow[];
  tempSeries: {
    at: string;
    value: number;
    min: number | null;
    max: number | null;
    out: boolean;
    label: string | null;
    store: string;
  }[];
  hourly: { hour: string; count: number }[];
  sopTrend: { dateKey: string; pct: number | null }[];
  production: { readings: number; units: number };
  /** Named production series — cases stocked ≠ items discarded. */
  metrics: { metricKey: string; unit: string | null; total: number; readings: number }[];
}> {
  return apiFetch(`/ops/insights${scopeQs(filters)}`);
}

export interface OpsFeedEvent {
  at: string;
  kind: 'task' | 'temp' | 'photo' | 'open' | 'close';
  /** The building — the client's name only when the shift has no store. */
  store: string;
  department: string;
  period: string;
  /** Every line opens the shift it came from. */
  shiftId: string;
  headline: string;
  detail: string | null;
  alert: boolean;
  photoId: string | null;
}

export interface OpsFeedPhoto {
  id: string;
  at: string;
  store: string;
  department: string;
  period: string;
  shiftId: string;
  title: string;
}

/** The live pulse: recent completions, temps, photos, opens/closes. */
export function getOpsFeed(
  filters: {
    locationId?: string;
    period?: string;
    department?: string;
    /** How far back to read, 1-72. Default 36. */
    hours?: number;
  } = {},
): Promise<{
  generatedAt: string;
  hours: number;
  events: OpsFeedEvent[];
  photos: OpsFeedPhoto[];
}> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v) params.set(k, String(v));
  const qs = params.toString();
  return apiFetch(`/ops/feed${qs ? `?${qs}` : ''}`);
}

export function getOpsScorecard(
  weeks = 4,
  sort: 'worst' | 'store' = 'worst',
  filters: OpsScopeFilters = {},
): Promise<{
  weeks: number;
  rows: {
    clientName: string;
    /** The building. Falls back to "<client> (store not recorded)". */
    storeName: string;
    locationId: string | null;
    period: string;
    department: string;
    shifts: number;
    sopPct: number | null;
    incomplete: number;
    tempAlerts: number;
  }[];
  totals: {
    shifts: number;
    tempChecks: number;
    tempInRange: number;
    tempOutOfRange: number;
    /** Every item raised, and what became of each one. "Carried" alone
     *  reads as a failure rate and is not one — the number that matters
     *  is how many were never decided at all. */
    handoverCreated: number;
    handoverCarried: number;
    handoverReviewed: number;
    handoverDismissed: number;
    handoverPending: number;
    /** Shifts that closed before their window was due, of those that had
     *  a due time at all. Submitting on time is its own standard. */
    onTime: number;
    onTimeOf: number;
  };
  /** Week by week over the window — an average cannot tell an improving
   *  store from a slipping one. */
  weekly: {
    weekKey: string;
    shifts: number;
    sopPct: number | null;
    incomplete: number;
    tempAlerts: number;
    onTime: number;
    onTimeOf: number;
  }[];
  /** Weekly named-metric series (top 4 by volume, zero-filled weeks). */
  metricTrends: {
    metricKey: string;
    unit: string | null;
    total: number;
    weeks: { weekKey: string; total: number }[];
  }[];
}> {
  return apiFetch(`/ops/scorecard?weeks=${weeks}&sort=${sort}${scopeQs(filters).replace('?', '&')}`);
}

/** The SOP the signed-in supervisor has open — the "finish your SOP"
 *  banner and the clock-out guard read it. */
export interface MySop {
  id: string;
  windowLabel: string | null;
  position: string;
  locationName: string | null;
  dueAt: string | null;
  openedAt: string;
  sopDone: number;
  sopTotal: number;
  requiredOpen: number;
  handoverCount: number;
  /** Items past their block's due time. */
  overdue?: number;
  /** The block to work now — the earliest with anything open. */
  block?: { section: string | null; dueAt: string; open: number } | null;
  /** A floor supervisor running it for their shift supervisor. */
  coveringFor?: { id: string; name: string } | null;
}

/** The running SOP a floor supervisor helps on — their shift
 *  supervisor's, or one on a shift they work. */
export interface HelpingSop {
  id: string;
  windowLabel: string | null;
  position: string;
  locationName: string | null;
  dueAt: string | null;
  sopDone: number;
  sopTotal: number;
  runBy: { id: string; name: string };
}

/** The SOP they last submitted (last 16h) when nothing is open — the
 *  end-of-shift screen reads "submitted · clock out". */
export interface SubmittedSop {
  id: string;
  windowLabel: string | null;
  position: string;
  closedAt: string;
  closedIncomplete: boolean;
}

export function getMySop(): Promise<{
  sop: MySop | null;
  submitted?: SubmittedSop | null;
  helping?: HelpingSop | null;
}> {
  return apiFetch('/ops/my-sop');
}

/** Each store's named shift windows and the SOP assigned to each. */
export interface StoreShiftSops {
  stores: Array<{
    locationId: string;
    locationName: string;
    windows: Array<{
      label: string;
      startMinute: number;
      endMinute: number;
      /** One SOP per department Alto staffs in this store. */
      templateIds: string[];
      /** The first, kept for older clients. */
      templateId: string | null;
    }>;
  }>;
  templates: Array<{ id: string; name: string; department: string; period: OpsPeriod; taskCount: number }>;
}

export function getStoreShiftSops(clientId: string): Promise<StoreShiftSops> {
  return apiFetch(`/ops/store-shifts?clientId=${encodeURIComponent(clientId)}`);
}

export function setStoreShiftSop(body: {
  locationId: string;
  label: string;
  /** Add (or replace within its department). Null clears the window. */
  templateId: string | null;
  /** Drop one department's SOP, leaving the others in place. */
  removeTemplateId?: string;
}): Promise<{ ok: true }> {
  return apiFetch('/ops/store-shifts', { method: 'PUT', body });
}
