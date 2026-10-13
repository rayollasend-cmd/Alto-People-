/**
 * Brief 1A-1 — every place on the platform that computes an "active"
 * count (or "on the floor", "scheduled", "staffed"), and the rule each
 * one uses. Compiled from a read of the code on 2026-10-13; the
 * reconciliation report prints it so the drift between screens is on the
 * record until Brief 1A-2 moves them all onto src/lib/activeDefinition.ts.
 *
 * Keep this list current when a site changes: the test in
 * src/__tests__/lib/reconcilePayroll.test.ts checks that every file named
 * here still exists.
 */

export interface ActiveCountSite {
  surface: string;
  /** Repo-relative path. */
  file: string;
  line: number;
  label: string;
  rule: string;
  /** Brief 1A-2: reads lib/activeDefinition.ts now (the rule column says what it read before). */
  shared?: boolean;
}

const API = 'apps/api/src';
const WEB = 'apps/web/src';

export const ACTIVE_COUNT_SITES: ActiveCountSite[] = [
  // The one shared definition
  { surface: 'Shared definition', file: `${API}/lib/activeDefinition.ts`, line: 24, label: 'activeAssociateIds', rule: 'Open assignment at the site; not deleted, separated or deactivated; a non-rejected clock-in in the trailing 14 days OR a future ASSIGNED shift (at any site). Comment promises an approved-application fallback the code lacks; erasedAt not checked.' },
  { surface: 'Season planner', file: `${API}/lib/seasonPlanner.ts`, line: 186, label: 'Active now (table, PDF, CSV)', rule: 'Shared definition', shared: true },
  { surface: 'Season planner', file: `${API}/lib/seasonPlanner.ts`, line: 219, label: 'LOCAL recruiting pipeline', rule: 'Shared definition, minus associates on a visa program', shared: true },

  // Dashboard and analytics
  { surface: 'Dashboard', file: `${API}/routes/analytics.ts`, line: 147, label: 'Admin dashboard and Analytics "Active associates"', rule: 'Every associate with deletedAt null (separated, deactivated and onboarding all count); site supervisors see open assignment at their client, else an approved application there', shared: true },
  { surface: 'Dashboard', file: `${API}/routes/analytics.ts`, line: 155, label: '"Clocked in right now"', rule: 'Count of TimeEntry rows with status ACTIVE' },
  { surface: 'Dashboard', file: `${API}/routes/analytics.ts`, line: 347, label: 'Retention by store "Active"', rule: 'separatedAt null and an open assignment (deactivated still counts; store = first assignment)', shared: true },
  { surface: 'Dashboard', file: `${API}/routes/analytics.ts`, line: 369, label: 'Monthly headcount and turnover', rule: 'Hired (hireDate, else createdAt) before the date and not separated before it' },
  { surface: 'Dashboard', file: `${API}/routes/team.ts`, line: 117, label: 'Team and manager dashboard "direct reports"', rule: 'managerId in the covering managers and deletedAt null (separated and deactivated count)', shared: true },
  { surface: 'Dashboard', file: `${WEB}/pages/ManagerDashboard.tsx`, line: 137, label: '"On the clock now"', rule: 'Direct reports with an ACTIVE time entry, counted in the browser' },
  { surface: 'Dashboard', file: `${API}/routes/workforceOverview.ts`, line: 67, label: 'Workforce dashboard "on floor"', rule: 'Count of ACTIVE time entries (not distinct people), capped at 1,000' },
  { surface: 'Dashboard', file: `${API}/routes/workforceOverview.ts`, line: 352, label: 'Workforce scheduledNow', rule: 'Published OPEN/ASSIGNED/COMPLETED shifts (not OPEN) running now' },
  { surface: 'Dashboard', file: `${API}/routes/workforceOverview.ts`, line: 233, label: 'Rebalance "bench"', rule: 'Distinct associates with any time entry in the last 30 days (no status filter), employed, minus those with an ASSIGNED shift that day' },
  { surface: 'Dashboard', file: `${API}/routes/scheduling.ts`, line: 1848, label: 'Labor costs live floor board', rule: 'ACTIVE time entries per store; punches without a locationId dropped' },
  { surface: 'Dashboard', file: `${API}/routes/time.ts`, line: 771, label: 'Live time board headcount per client', rule: 'ACTIVE time entries, capped at 100' },

  // People directory and headcount
  { surface: 'People directory', file: `${API}/routes/directory.ts`, line: 155, label: 'ACTIVE / PENDING / INACTIVE badge and ?status filter', rule: 'Deactivated → INACTIVE; separated with no newer approval → INACTIVE; APPROVED application → ACTIVE; DRAFT/SUBMITTED/IN_REVIEW → PENDING; else INACTIVE', shared: true },
  { surface: 'People directory', file: `${WEB}/pages/people/PeopleDirectory.tsx`, line: 454, label: 'Tiles "Total", "Active", "Pending onboarding"', rule: 'Directory statuses counted in the browser over loaded pages only (500 per page)', shared: true },
  { surface: 'People directory', file: `${WEB}/pages/kiosk/KioskAdmin.tsx`, line: 2111, label: 'Kiosk PIN issue: eligible count', rule: 'Directory status ACTIVE, in the browser', shared: true },
  { surface: 'Headcount page', file: `${API}/routes/headcount110.ts`, line: 24, label: '"Active headcount", by department and employment type', rule: 'deletedAt null only (comment wrongly treats deletedAt as separation)', shared: true },
  { surface: 'Headcount page', file: `${API}/routes/headcount110.ts`, line: 30, label: 'Headcount by client', rule: 'Count of applications per client (any status), not people', shared: true },
  { surface: 'Headcount page', file: `${API}/routes/headcount110.ts`, line: 111, label: 'Turnover denominator', rule: 'deletedAt null; "terminations" are deletedAt in the window, not separatedAt', shared: true },
  { surface: 'Org', file: `${API}/routes/org.ts`, line: 108, label: 'Department / cost center / job profile "Associates"', rule: 'deletedAt null, grouped', shared: true },
  { surface: 'Vaccination', file: `${API}/routes/vaccination121.ts`, line: 127, label: 'Coverage total', rule: 'deletedAt null', shared: true },

  // Client portal and region
  { surface: 'Client portal', file: `${API}/routes/clientPortal.ts`, line: 259, label: 'Portal home "on the floor" hero', rule: 'ACTIVE time entries for the client or store (punch location or the shift location)' },
  { surface: 'Client portal', file: `${API}/routes/clientPortal.ts`, line: 798, label: '"on of scheduled"', rule: "Today's published shifts, not OPEN, running now" },
  { surface: 'Client portal', file: `${API}/routes/clientPortal.ts`, line: 733, label: 'Per-store onFloor / scheduledNow / openToday', rule: 'ACTIVE entries matched to a store; published shifts running now' },
  { surface: 'Client portal', file: `${API}/routes/clientPortal.ts`, line: 457, label: 'Today roster filled/open and states', rule: 'Shift state: OPEN → open; assignee with an ACTIVE entry → on-floor; then done / confirmed / unconfirmed' },
  { surface: 'Client portal', file: `${API}/routes/clientPortal.ts`, line: 1205, label: 'Day view onFloorNow and summary', rule: 'Every ACTIVE entry including walk-ins; summary from roster states' },
  { surface: 'Client portal', file: `${API}/routes/clientPortal.ts`, line: 1683, label: 'Request "who is this about" picker', rule: 'Assignees of published shifts from 14 days back to 14 days ahead' },
  { surface: 'Client portal', file: `${WEB}/pages/portal/PortalToday.tsx`, line: 326, label: 'Today "on / expected"', rule: 'onFloorNow narrowed to "my shift" windows, in the browser' },
  { surface: 'Client portal', file: `${WEB}/pages/SupervisorDashboard.tsx`, line: 355, label: 'Supervisor hero "on floor / target"', rule: 'Rows that are on-floor or not-in, in the browser' },
  { surface: 'Region', file: `${API}/lib/storeSnapshot.ts`, line: 89, label: 'Store cards now.onFloor / short / present, leads on floor', rule: 'ACTIVE entries for the store; present = running shifts whose assignee is clocked in; short = expected + open − present' },
  { surface: 'Region', file: `${API}/routes/region.ts`, line: 147, label: 'Region hero totals.onFloor', rule: 'Sum of store snapshot onFloor' },
  { surface: 'Client portal', file: `${API}/lib/portalDayReport.ts`, line: 625, label: 'Day report hero onFloorNow', rule: 'Distinct associates with an ACTIVE, COMPLETED or APPROVED entry covering now (differs from the live onFloor)' },
  { surface: 'Client portal', file: `${API}/lib/portalMetrics.ts`, line: 254, label: 'Delivered vs contracted hours', rule: 'Distinct associates with a punch covering the top of each hour, capped at the target' },
  { surface: 'Client portal', file: `${API}/lib/portalReadiness.ts`, line: 58, label: '"N of M associates have no photo"', rule: 'associatesOfClient with deletedAt null (separated and deactivated count)', shared: true },
  { surface: 'Client portal', file: `${API}/lib/portalDigest.ts`, line: 146, label: 'Digest "N on the schedule / staffed"', rule: 'Published OPEN/ASSIGNED/COMPLETED shifts, filled or open' },

  // Executive
  { surface: 'Executive', file: `${API}/lib/executiveSummary.ts`, line: 192, label: '"Active associates" tile, pie, board pack, AI summary', rule: 'Not deleted, erased, separated or deactivated, and at least one APPROVED non-deleted application', shared: true },
  { surface: 'Executive', file: `${API}/lib/executiveSummary.ts`, line: 201, label: '"paused"', rule: 'deletedAt null and deactivatedAt set' },
  { surface: 'Executive', file: `${API}/lib/executiveSummary.ts`, line: 223, label: 'Per-client "N placed"', rule: 'Count of open assignments per client, no employment check', shared: true },
  { surface: 'Executive', file: `${API}/lib/executiveSummary.ts`, line: 113, label: 'Weekly headsWorked', rule: 'Distinct associates with APPROVED or COMPLETED entries that week' },
  { surface: 'Executive', file: `${API}/routes/executive.ts`, line: 407, label: 'Targets headcount and turnover denominator', rule: 'Same as the executive "Active associates" rule', shared: true },
  { surface: 'Executive', file: `${API}/lib/executiveBriefing.ts`, line: 190, label: '"on the bench"', rule: 'Employed, APPROVED application, no open assignment' },
  { surface: 'Executive', file: `${API}/lib/executiveBriefing.ts`, line: 212, label: '"J-1 associates"', rule: 'Not deleted, separated or deactivated, and j1Status true' },
  { surface: 'Executive', file: `${API}/lib/executiveDecisions.ts`, line: 164, label: '"approved associates unplaced for 2+ weeks"', rule: 'Bench rule, approved more than 14 days ago' },

  // Finance, store ops, reports
  { surface: 'Finance', file: `${API}/lib/financeCockpit.ts`, line: 137, label: 'Billing week workers', rule: 'Timesheet rows from the last Sat–Fri week with a client, Fieldglass data and hours > 0' },
  { surface: 'Store ops', file: `${API}/lib/storeShiftSop.ts`, line: 256, label: 'OpsShift scheduled / actual headcount (frozen at open)', rule: 'scheduled = shifts in the window incl. OPEN and DRAFT; actual = ACTIVE entries at the client or store' },
  { surface: 'Store ops', file: `${WEB}/pages/ops/OpsBoard.tsx`, line: 412, label: 'Ops board "On the floor"', rule: 'Sum of frozen per-shift actualHeadcount (double counts across departments, goes stale)' },
  { surface: 'Store ops', file: `${API}/routes/opsShifts.ts`, line: 2548, label: 'Ops insights per-store floor', rule: 'ACTIVE entries grouped by client (stores of one client share the total)' },
  { surface: 'Reports', file: `${API}/lib/clientServiceReport.ts`, line: 271, label: 'Service report "on the floor now"', rule: 'ACTIVE entries for the client' },
  { surface: 'Reports', file: `${API}/lib/clientServiceReport.ts`, line: 124, label: '"Your team this week (N)"', rule: 'Distinct assignees of non-cancelled shifts that week; publication not checked' },
  { surface: 'Reports', file: `${API}/lib/opsStoreReport.ts`, line: 397, label: 'Store report "shifts ran short-staffed"', rule: 'Frozen ops shift numbers' },
  { surface: 'Integrations', file: `${API}/routes/integrationsV1.ts`, line: 393, label: 'KPIs clockedInRightNow / distinctAssociatesScheduled', rule: 'ACTIVE entries without clock-out; distinct assignees of any shift in the window (cancelled and draft count), capped at 100' },
  { surface: 'Audit packet', file: `${API}/routes/auditPacket.ts`, line: 253, label: '"Active workforce" roster and counsel population', rule: 'Executive "Active associates" rule', shared: true },
  { surface: 'Compliance', file: `${API}/routes/complianceScorecard.ts`, line: 122, label: 'Scorecard "N active", PDF, daily snapshot, score scaling', rule: 'APPROVED non-deleted application and associate not deleted; no separated or deactivated check; cached 5 s per client (star = whole org)', shared: true },
  { surface: 'Clients', file: `${API}/lib/associateClients.ts`, line: 96, label: 'Clients list and detail "Active"', rule: 'Not deleted, separated or deactivated, and open assignment at the client or APPROVED application there with no open assignment; comment says "or erased", code does not', shared: true },

  // Payroll and scheduling
  { surface: 'Payroll', file: `${API}/routes/payroll.ts`, line: 3278, label: 'Pay schedules "associates"', rule: 'Associates linked to the schedule, no active filter' },
  { surface: 'Payroll', file: `${API}/routes/payroll.ts`, line: 3917, label: 'Year-to-date "Associates"', rule: 'Rows with pay stubs' },
  { surface: 'Scheduling', file: `${API}/routes/scheduling.ts`, line: 245, label: 'Grid rows, availability, auto-fill and offer pools', rule: 'Not deleted, separated or deactivated; login not DISABLED; APPROVED application (deleted ones not excluded) or open assignment' },
  { surface: 'Scheduling', file: `${API}/lib/shiftAutofill.ts`, line: 55, label: 'Bench broadcast and backup suggestions', rule: 'Employed, atClient (approved only), no clashing shift; auto-fill also needs an ACTIVE login' },

  // Sweeps and jobs
  { surface: 'Sweeps', file: `${API}/lib/dormancySweep.ts`, line: 79, label: 'Auto-deactivation', rule: 'The inverse: no clock-in, shift, claim, kiosk punch or approved time off in 30 days; employed associates with a hireDate only' },
  { surface: 'Workers', file: `${API}/lib/workers.ts`, line: 86, label: 'Worker status sync and Workers page "People"', rule: 'Separated → OFFBOARDED, deactivated → SUSPENDED, else ACTIVE; deletedAt ignored' },
  { surface: 'Sweeps', file: `${API}/lib/onboardingPurge.ts`, line: 248, label: 'Ghost-invite purge', rule: 'INVITED user with no password; employed; no hireDate' },
  { surface: 'Emergency', file: `${API}/lib/emergency.ts`, line: 123, label: 'Roll call totals', rule: 'Open assignment at the site or an assigned shift in scope; no employment check' },
  { surface: 'Portal alerts', file: `${API}/lib/portalCoverageAlert.ts`, line: 91, label: 'Short-staffed alerts', rule: 'Published OPEN/ASSIGNED shifts running now vs ACTIVE/COMPLETED/APPROVED punches' },
];

/** The distinct rules above, with how many sites use each. */
export const DISTINCT_ACTIVE_RULES: { rule: string; sites: number }[] = [
  { rule: 'Open time entry (status ACTIVE) = "on the floor / clocked in"', sites: 20 },
  { rule: 'Shift-based "scheduled / expected / filled" (published, not OPEN, running now or that day)', sites: 12 },
  { rule: 'deletedAt null only', sites: 8 },
  { rule: 'Not deleted, erased, separated or deactivated, plus an APPROVED application (executive rule)', sites: 5 },
  { rule: 'Scheduling pool: employed, login not DISABLED, approved application or open assignment', sites: 5 },
  { rule: 'Distinct shift assignees in a window (loose status filters)', sites: 4 },
  { rule: 'Directory rule (approved application; later re-approval overrides separation; deactivation wins)', sites: 3 },
  { rule: 'Worked recently: distinct people with time entries in a window', sites: 3 },
  { rule: 'Shared definition (activeDefinition.ts)', sites: 2 },
  { rule: 'Bench: employed, approved, no open assignment', sites: 2 },
  { rule: 'J-1: employed plus j1Status', sites: 2 },
  { rule: 'Count of open assignments, no employment check', sites: 2 },
  { rule: 'associatesOfClient with deletedAt null only', sites: 2 },
  { rule: 'Not deleted, separated or deactivated, plus open assignment or approved application at the client (clients list)', sites: 1 },
  { rule: 'APPROVED application only, no separated or deactivated check (compliance scorecard)', sites: 1 },
  { rule: 'Not separated plus an open assignment (retention)', sites: 1 },
  { rule: 'Hired before the date and not separated before it (point-in-time)', sites: 1 },
  { rule: 'Worker.status ACTIVE (ignores deletedAt)', sites: 1 },
  { rule: 'Dormancy: no activity of any kind in 30 days (the inverse)', sites: 1 },
  { rule: 'Emergency scope: open assignment or assigned shift at the site, no employment check', sites: 1 },
];
