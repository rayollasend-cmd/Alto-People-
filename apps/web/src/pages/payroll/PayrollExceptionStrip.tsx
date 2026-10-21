import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, ExternalLink, Info, Loader2, ShieldAlert } from 'lucide-react';
import type { PayrollException, PayrollExceptionsResponse } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { bulkApproveTimeEntries, listAdminTimeEntries } from '@/lib/timeApi';
import { cn } from '@/lib/cn';
import { parseYmd, ymdLocal } from '@/lib/format';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { toast } from '@/components/ui/Toaster';

/* -------------------------------------------------------------------------- *
 *  Pre-flight exception strip — shared by the run wizard and the payroll
 *  hero. Blocking → warning → info, expanded on its own when anything
 *  blocks. Each row's Fix link lands on the right page with the run's
 *  period already applied, and unapproved time is approved in place: the
 *  clean entries (no flags) for the people it names, in this period.
 * -------------------------------------------------------------------------- */

export const EXCEPTION_COPY: Partial<Record<string, { label: string }>> = {
  MISSING_W4: { label: 'Missing W-4' },
  MISSING_BANK_ACCOUNT: { label: 'No payout method' },
  TERMINATED_IN_RUN: { label: 'Terminated in period' },
  OT_SPIKE: { label: 'OT spike' },
  UNSUPPORTED_STATE: { label: 'State tax not supported' },
  UNAPPROVED_TIME: { label: 'Unapproved time' },
  MISSING_COMP_RECORD: { label: 'No comp record' },
  RETRO_PAY: { label: 'Retroactive pay' },
  STATE_W4_INCOMPLETE: { label: 'State certificate incomplete' },
  LOCAL_TAX_REVIEW: { label: 'Local tax not reviewed' },
  LOCAL_TAX_UNRESOLVED: { label: 'Home jurisdiction unknown' },
  BELOW_PREVAILING_WAGE: { label: 'Below prevailing wage' },
  APPRENTICE_RATIO: { label: 'Apprentice ratio' },
  WAGE_STATEMENT_INCOMPLETE: { label: 'Paystub missing a state item' },
  ROTH_CATCH_UP: { label: 'Catch-up must be Roth' },
  DEFERRAL_LIMIT: { label: 'Annual limit reached' },
};

export interface ExceptionPeriod {
  start: string;
  end: string;
}

/** The day after a YMD, for the time queue's end-exclusive window. */
function dayAfter(ymd: string): string {
  const d = parseYmd(ymd);
  if (!d) return ymd;
  d.setDate(d.getDate() + 1);
  return ymdLocal(d);
}

/**
 * Best fix surface per exception kind, with the run's period carried
 * along where the page reads one: unapproved time opens that person's
 * timesheet on the period's window; pay-setup gaps open their record's
 * Pay tab; a termination its Employment tab. Opened in a new tab so the
 * in-progress wizard survives.
 */
export function fixHref(ex: PayrollException, period?: ExceptionPeriod | null): string {
  const person = (tab: string) => `/people/${ex.associateId}?tab=${tab}`;
  switch (ex.kind) {
    case 'UNAPPROVED_TIME':
    case 'OT_SPIKE': {
      const qs = new URLSearchParams({ tab: 'queue', associate: ex.associateId, name: ex.associateName });
      if (period) {
        qs.set('from', period.start);
        qs.set('to', period.end);
      }
      return `/time-attendance?${qs.toString()}`;
    }
    case 'WAGE_STATEMENT_INCOMPLETE':
      return '/payroll/compliance?tab=paystubs';
    case 'ROTH_CATCH_UP':
    case 'DEFERRAL_LIMIT':
      return '/payroll/compliance?tab=roth';
    case 'LOCAL_TAX_REVIEW':
      return '/payroll/tax-jurisdictions';
    case 'UNSUPPORTED_STATE':
      return '/payroll/state-tax';
    case 'TERMINATED_IN_RUN':
      return person('employment');
    case 'MISSING_W4':
    case 'MISSING_BANK_ACCOUNT':
    case 'MISSING_COMP_RECORD':
    case 'STATE_W4_INCOMPLETE':
    case 'LOCAL_TAX_UNRESOLVED':
    case 'RETRO_PAY':
      return person('pay');
    default:
      return `/people/${ex.associateId}`;
  }
}

const SEVERITY_LABEL: Record<PayrollException['severity'], string> = {
  BLOCKING: 'Blocks the run',
  WARNING: 'Warning',
  INFO: 'Note',
};

/** Colour carries the severity for sighted readers; the label is spoken for everyone else. */
export function SeverityDot({ severity }: { severity: PayrollException['severity'] }) {
  const cls = severity === 'BLOCKING' ? 'bg-alert' : severity === 'WARNING' ? 'bg-warning' : 'bg-silver/50';
  return (
    <span className="inline-flex items-center" title={SEVERITY_LABEL[severity] ?? severity}>
      <span className={cn('h-2 w-2 rounded-full inline-block', cls)} aria-hidden="true" />
      <span className="sr-only">{SEVERITY_LABEL[severity] ?? severity}</span>
    </span>
  );
}

/**
 * Approve the clean time (finished, no flags) these people have in the
 * period. Flagged entries stay for a person to read on the timesheet.
 * Resolves with what happened so the caller can re-check.
 */
export async function approveCleanTime(
  associateIds: string[],
  period: ExceptionPeriod,
): Promise<{ approved: number; failed: number; flagged: number }> {
  const want = new Set(associateIds);
  const res = await listAdminTimeEntries({ status: 'COMPLETED', from: period.start, to: dayAfter(period.end) });
  const theirs = res.entries.filter((e) => want.has(e.associateId));
  const clean = theirs.filter((e) => (e.anomalies?.length ?? 0) === 0).map((e) => e.id);
  const flagged = theirs.length - clean.length;
  if (clean.length === 0) return { approved: 0, failed: 0, flagged };
  const done = await bulkApproveTimeEntries({ entryIds: clean });
  return { approved: done.succeeded, failed: done.failed, flagged };
}

export function ExceptionStrip({
  exceptions,
  loading,
  onRecheck,
  paychecks,
  period,
  onTimeApproved,
  defaultOpen,
}: {
  exceptions: PayrollExceptionsResponse | null;
  loading: boolean;
  onRecheck?: () => void;
  /** People with a paycheck in this run: the all-clear is only said about real people. */
  paychecks: number;
  /** The run's period — carried on Fix links and used to approve time in place. */
  period?: ExceptionPeriod | null;
  /** Approved time changes the paychecks — the caller re-runs its preview. */
  onTimeApproved?: () => void;
  /** Open regardless of severity (the hero's pill opens it on request). */
  defaultOpen?: boolean;
}) {
  // null = follow the data: open while anything blocks.
  const [openChoice, setOpenChoice] = useState<boolean | null>(defaultOpen ? true : null);
  const [approving, setApproving] = useState(false);
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs2 text-silver/70 py-2">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Checking pre-flight exceptions…
      </div>
    );
  }
  if (!exceptions || exceptions.exceptions.length === 0) {
    if (paychecks === 0) return null;
    return (
      <div className="flex items-center gap-2 rounded border border-success/20 bg-success/5 px-3 py-2 text-xs2 text-success">
        <CheckCircle2 className="h-3.5 w-3.5" />
        <span className="flex-1">
          No exceptions for the {paychecks} {paychecks === 1 ? 'person' : 'people'} in this run — each has a W-4, a payout method and a supported state.
        </span>
        {onRecheck && exceptions && (
          <button type="button" onClick={onRecheck} className="shrink-0 text-2xs text-gold hover:underline" title="Re-run the pre-flight scan">
            Re-check
          </button>
        )}
      </div>
    );
  }
  const { blocking, warning, info } = exceptions.counts;
  const open = openChoice ?? blocking > 0;
  const tone = blocking > 0 ? 'border-alert/40 bg-alert/5 text-alert' : warning > 0 ? 'border-warning/30 bg-warning/5 text-warning' : 'border-silver/20 bg-black/40 text-silver';
  const Icon = blocking > 0 ? ShieldAlert : warning > 0 ? AlertTriangle : Info;
  const unapprovedIds = [...new Set(exceptions.exceptions.filter((e) => e.kind === 'UNAPPROVED_TIME').map((e) => e.associateId))];

  const approve = async () => {
    if (!period || approving || unapprovedIds.length === 0) return;
    setApproving(true);
    try {
      const r = await approveCleanTime(unapprovedIds, period);
      const parts: string[] = [];
      if (r.approved > 0) parts.push(`${r.approved} time ${r.approved === 1 ? 'entry' : 'entries'} approved`);
      if (r.flagged > 0) parts.push(`${r.flagged} flagged — read ${r.flagged === 1 ? 'it' : 'them'} on the timesheet`);
      if (r.failed > 0) parts.push(`${r.failed} could not be approved`);
      if (parts.length === 0) parts.push('No clean time left to approve in this period');
      (r.failed > 0 ? toast.error : toast.success)(`${parts.join(' · ')}.`);
      if (r.approved > 0) onTimeApproved?.();
      else onRecheck?.();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not approve the time.');
    } finally {
      setApproving(false);
    }
  };

  return (
    <div className={cn('rounded border', tone.split(' ').slice(0, 2).join(' '))}>
      <div className="flex items-center gap-1">
        <button type="button" onClick={() => setOpenChoice(!open)} className="flex-1 flex items-center justify-between gap-2 px-3 py-2 text-left" aria-expanded={open}>
          <span className={cn('flex items-center gap-2 text-xs', tone.split(' ')[2])}>
            <Icon className="h-4 w-4" />
            <span className="font-medium">
              {blocking > 0
                ? `${blocking} blocking ${blocking === 1 ? 'issue' : 'issues'}`
                : `${exceptions.exceptions.length} ${exceptions.exceptions.length === 1 ? 'issue' : 'issues'} to review`}
            </span>
            <span className="text-silver/70">
              {warning > 0 && ` · ${warning} warning${warning === 1 ? '' : 's'}`}
              {info > 0 && ` · ${info} info`}
            </span>
          </span>
          {open ? <ChevronDown className="h-4 w-4 text-silver/70" /> : <ChevronRight className="h-4 w-4 text-silver/70" />}
        </button>
        {onRecheck && (
          <button type="button" onClick={onRecheck} className="shrink-0 px-2 py-2 text-2xs text-gold hover:underline" title="Re-run the pre-flight scan after fixing issues in another tab">
            Re-check
          </button>
        )}
      </div>
      {open && period && unapprovedIds.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-t border-silver/10 px-3 py-2 text-xs">
          <span className="flex-1 text-silver">
            {unapprovedIds.length} {unapprovedIds.length === 1 ? 'person has' : 'people have'} unapproved time in this period — it won’t be paid until approved.
          </span>
          <Button size="xs" onClick={() => void approve()} loading={approving}>
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
            Approve clean time for {unapprovedIds.length === 1 ? 'this person' : `these ${unapprovedIds.length} people`}
          </Button>
        </div>
      )}
      {open && (
        <ul className="border-t border-silver/10 divide-y divide-silver/5 max-h-56 overflow-y-auto">
          {exceptions.exceptions.map((ex, i) => (
            <li key={`${ex.associateId}-${ex.kind}-${i}`} className="px-3 py-2 text-xs">
              <div className="flex items-center gap-2">
                <SeverityDot severity={ex.severity} />
                <span className="text-ink">{ex.associateName}</span>
                <Badge variant={ex.severity === 'BLOCKING' ? 'destructive' : ex.severity === 'WARNING' ? 'pending' : 'default'} className="text-2xs">
                  {EXCEPTION_COPY[ex.kind]?.label ?? ex.kind}
                </Badge>
                <Link
                  to={fixHref(ex, period)}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-auto inline-flex items-center gap-1 text-2xs text-gold hover:underline"
                  title="Fix in a new tab — re-checked when you come back"
                >
                  Fix <ExternalLink className="h-2.5 w-2.5" />
                </Link>
              </div>
              <div className="text-silver/70 mt-0.5 ml-4">{ex.message}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
