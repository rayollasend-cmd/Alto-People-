import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, CircleDot } from 'lucide-react';
import type { PayrollRunSummary } from '@alto-people/shared';
import { useInbox } from '@/lib/inboxApi';
import { getDisbursementWebhookStatus, getPayrollReadiness, listPayrollRuns } from '@/lib/payrollApi';
import { getDesk } from '@/lib/deductionsApi';
import { fmtCount, fmtDate, fmtDateOnlyRange } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui/Badge';
import { isSignInFailure } from './WebhookHealthTile';

/**
 * "Needs you" on the payroll home (F500 G3, P1): the open work of this
 * desk in one card, before the hero. It was spread over six pages — the
 * tax deposit owed only as a grid's "Next step", the people who can't be
 * paid on Readiness, an e-IWO on Garnishments, failing payouts as one line
 * — and a payroll person had to visit each to know what was waiting.
 *
 * Each row is a count (when there is one), one sentence and a link to the
 * list behind it, read from what already counts that work:
 *   - the payout provider's health (Payroll banking's reading);
 *   - each run's next step (GET /payroll/runs `nextStep`) that isn't done;
 *   - the Inbox's payroll queues (GET /me/inbox: missed paydays, people on
 *     no schedule, financial changes, pay notices, new-hire reports…), the
 *     queues this person owns, never the ones they only watch;
 *   - Readiness (people a run would pay who are missing something);
 *   - the garnishment desk (e-IWOs to answer, payments waiting).
 * The card is hidden when nothing is waiting.
 */

export type NeedTone = 'alert' | 'warning' | 'default';
export interface Need {
  key: string;
  count?: number;
  title: string;
  detail?: string;
  to: string;
  tone: NeedTone;
}

const RUN_NEXT_TONE: Partial<Record<NonNullable<PayrollRunSummary['nextStep']>['key'], NeedTone>> = {
  deposit: 'alert',
  held: 'alert',
  fund: 'warning',
  disburse: 'warning',
  review: 'warning',
};

/** Inbox queues the home folds in; the ones a run's own next step already names are left out. */
const INBOX_SKIP_WHEN_RUN_SAYS: Record<string, string> = { 'payroll-review': 'review' };

/** The rows, in the order a payroll person should read them: what stops money first. */
export function payrollNeeds(input: {
  payout?: { provider: string; health: string; latestError?: { at: string; notes: string | null } | null; lastEventAt?: string | null; pendingFinalizedItems: number } | null;
  runs?: PayrollRunSummary[] | null;
  inbox?: Array<{ key: string; label: string; description: string; count: number; path: string; watching?: boolean }> | null;
  readiness?: { missingCount: number } | null;
  garnishments?: { eiwoToReview: number; remittancesPending: number } | null;
}): Need[] {
  const out: Need[] = [];
  const p = input.payout;
  if (p && (p.health === 'erroring' || p.health === 'stale')) {
    const name = p.provider === 'WISE' ? 'Wise' : p.provider === 'BRANCH' ? 'Branch' : 'The payout provider';
    const at = p.health === 'erroring' ? p.latestError?.at : p.lastEventAt;
    out.push({
      key: 'payouts',
      title: p.health === 'erroring' ? 'Payouts can’t go out' : `No word from ${name}`,
      detail:
        p.health === 'erroring'
          ? `${isSignInFailure(p.latestError?.notes) ? `${name} rejected our sign-in${at ? ` on ${fmtDate(at)}` : ''}` : `${name} has been refusing payouts${at ? ` since ${fmtDate(at)}` : ''}`}${p.pendingFinalizedItems > 0 ? ` · ${fmtCount(p.pendingFinalizedItems, 'paycheck')} waiting` : ''}.`
          : `Nothing from ${name}${at ? ` since ${fmtDate(at)}` : ''}; payouts may be stuck.`,
      to: '/payroll/banking',
      tone: p.health === 'erroring' ? 'alert' : 'warning',
    });
  }
  const runSteps = new Set<string>();
  for (const r of input.runs ?? []) {
    const n = r.nextStep;
    if (!n || n.key === 'done' || n.key === 'cancelled') continue;
    runSteps.add(n.key);
    out.push({
      key: `run:${r.id}`,
      title: n.label,
      detail: `${fmtDateOnlyRange(r.periodStart, r.periodEnd)} run${n.waitingOn ? ` · waiting on ${n.waitingOn}` : ''}`,
      to: n.to,
      tone: RUN_NEXT_TONE[n.key] ?? 'default',
    });
  }
  for (const s of input.inbox ?? []) {
    if (s.count <= 0 || s.watching || !s.path.startsWith('/payroll')) continue;
    const covered = INBOX_SKIP_WHEN_RUN_SAYS[s.key];
    if (covered && runSteps.has(covered)) continue;
    out.push({
      key: `inbox:${s.key}`,
      count: s.count,
      title: s.label,
      // Short descriptions read as the sentence; long ones stay on the Inbox.
      detail: s.description.length <= 90 ? s.description : undefined,
      to: s.path,
      tone: s.key === 'payroll-missed-paydays' ? 'alert' : 'default',
    });
  }
  if (input.readiness && input.readiness.missingCount > 0) {
    out.push({
      key: 'readiness',
      count: input.readiness.missingCount,
      title: input.readiness.missingCount === 1 ? 'Person who can’t be paid yet' : 'People who can’t be paid yet',
      detail: 'Missing a W-4, a payout method, a tax state or a pay schedule.',
      to: '/payroll/readiness',
      tone: 'warning',
    });
  }
  const g = input.garnishments;
  if (g && g.eiwoToReview > 0) out.push({ key: 'eiwo', count: g.eiwoToReview, title: g.eiwoToReview === 1 ? 'e-IWO order to answer' : 'e-IWO orders to answer', detail: 'Agencies wait for your answer.', to: '/payroll/garnishments?tab=eiwo', tone: 'warning' });
  if (g && g.remittancesPending > 0) out.push({ key: 'remit', count: g.remittancesPending, title: g.remittancesPending === 1 ? 'Garnishment payment waiting' : 'Garnishment payments waiting', to: '/payroll/garnishments?tab=remittances', tone: 'default' });
  const rank: Record<NeedTone, number> = { alert: 0, warning: 1, default: 2 };
  return out.map((n, i) => ({ n, i })).sort((a, b) => rank[a.n.tone] - rank[b.n.tone] || a.i - b.i).map((x) => x.n);
}

export function PayrollNeedsYou({ canProcess }: { canProcess: boolean }) {
  const payout = useQuery({ queryKey: ['WebhookHealthTile', 'status'], queryFn: () => getDisbursementWebhookStatus(), enabled: canProcess, retry: false, staleTime: 60_000 });
  const runs = useQuery({ queryKey: ['payroll', 'runs', 'ALL'], queryFn: () => listPayrollRuns({}), enabled: canProcess, staleTime: 30_000 });
  const inbox = useInbox();
  const readiness = useQuery({ queryKey: ['payroll', 'readiness'], queryFn: getPayrollReadiness, enabled: canProcess, retry: false, staleTime: 60_000 });
  const desk = useQuery({ queryKey: ['garnishment-desk'], queryFn: getDesk, enabled: canProcess, retry: false, staleTime: 60_000 });
  if (!canProcess) return null;
  const needs = payrollNeeds({
    payout: payout.data ?? null,
    runs: runs.data?.runs ?? null,
    inbox: inbox.data?.sources ?? null,
    readiness: readiness.data ?? null,
    garnishments: desk.data?.totals ?? null,
  });
  if (needs.length === 0) return null;
  return (
    <section aria-labelledby="payroll-needs-you" className="mb-5 rounded-lg border border-line bg-surface-raised" data-testid="payroll-needs-you">
      <h2 id="payroll-needs-you" className="flex items-center gap-2 px-4 pt-3 text-sm font-semibold text-ink">
        Needs you
        <Badge variant="accent" size="sm" withDot={false} className="tabular-nums">
          {needs.length}
        </Badge>
      </h2>
      <ul className="mt-1 divide-y divide-line">
        {needs.map((n) => (
          <li key={n.key}>
            <Link to={n.to} className="group flex items-start gap-3 px-4 py-2.5 text-sm hover:bg-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent">
              {n.tone === 'default' ? (
                <CircleDot className="mt-0.5 h-4 w-4 shrink-0 text-ink-muted" aria-hidden="true" />
              ) : (
                <AlertTriangle className={cn('mt-0.5 h-4 w-4 shrink-0', n.tone === 'alert' ? 'text-alert' : 'text-warning')} aria-hidden="true" />
              )}
              <span className="min-w-0 flex-1">
                <span className="text-ink">
                  {n.count !== undefined && <span className="mr-1.5 font-semibold tabular-nums">{n.count}</span>}
                  {n.title}
                </span>
                {n.detail && <span className="block text-xs text-ink-muted">{n.detail}</span>}
              </span>
              <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-ink-muted transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
