import { useQuery } from '@tanstack/react-query';
import { Bot, Cpu, ExternalLink, Users as UsersIcon } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { fmtMoney } from '@/lib/format';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryError } from '@/components/ui/QueryError';
import { SkeletonRows } from '@/components/ui';

/**
 * Brief 2-6 step 4 — Billing: the plan, this month's billable count so far
 * by worker type (people, AI agents, robots active on at least one day,
 * decision 1), and the invoices with their hosted links. Counts and prices
 * only; who was active stays in the daily evidence and never reaches the
 * payment processor. The internal plan is never invoiced.
 */

type WorkerType = 'PERSON' | 'AGENT' | 'ROBOT';

interface BillingOverview {
  plan: string;
  invoiced: boolean;
  stripe: 'test' | 'live' | 'off';
  month: string;
  daysCounted: number;
  running: Record<WorkerType, number>;
  invoices: Array<{
    id: string;
    month: string;
    status: 'DRAFT' | 'OPEN' | 'PAID' | 'VOID';
    totalCents: number;
    lines: Array<{ type: WorkerType; quantity: number; unitPriceCents: number | null; amountCents: number }>;
    holdReason: string | null;
    hostedUrl: string | null;
    lastPaymentError: string | null;
    paidAt: string | null;
  }>;
}

const TYPE: Record<WorkerType, { label: string; icon: typeof UsersIcon }> = {
  PERSON: { label: 'People', icon: UsersIcon },
  AGENT: { label: 'AI agents', icon: Bot },
  ROBOT: { label: 'Robots', icon: Cpu },
};
const STATUS: Record<BillingOverview['invoices'][number]['status'], 'pending' | 'accent' | 'success' | 'default'> = { DRAFT: 'pending', OPEN: 'accent', PAID: 'success', VOID: 'default' };
const HOLD: Record<string, string> = {
  prices_missing: 'Waiting for your plan’s prices.',
  stripe_not_configured: 'Waiting for the payment processor to be connected.',
};

export function BillingHome() {
  const q = useQuery({ queryKey: ['billing', 'overview'], queryFn: () => apiFetch<BillingOverview>('/billing') });
  const d = q.data;
  return (
    <div className="space-y-5">
      <PageHeader title="Billing" subtitle="Your plan, this month’s active workers by type, and your invoices." breadcrumbs={[{ label: 'Settings & trust', to: '/admin' }, { label: 'Billing' }]} />
      {q.isError ? (
        <QueryError what="billing" query={q} />
      ) : !d ? (
        <SkeletonRows count={4} />
      ) : (
        <>
          <Card>
            <CardContent className="flex flex-wrap items-center gap-3 p-4 text-sm">
              <span className="text-silver">Plan</span>
              <span className="font-semibold capitalize text-white">{d.plan}</span>
              {!d.invoiced && <Badge variant="default" size="sm">Not invoiced</Badge>}
              {d.invoiced && d.stripe === 'test' && <Badge variant="pending" size="sm">Payment processor in test mode</Badge>}
            </CardContent>
          </Card>

          <section aria-labelledby="running" className="space-y-2">
            <h2 id="running" className="text-base font-semibold text-white">
              {d.month}, so far
            </h2>
            <p className="text-sm text-silver">Each person, agent and robot active on at least one day of the month counts once. {d.daysCounted} day{d.daysCounted === 1 ? '' : 's'} counted so far.</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {(Object.keys(TYPE) as WorkerType[]).map((t) => {
                const Icon = TYPE[t].icon;
                return (
                  <Card key={t}>
                    <CardContent className="flex items-center gap-3 p-4">
                      <Icon className="h-5 w-5 text-silver" aria-hidden="true" />
                      <div>
                        <div className="text-2xl font-semibold text-white">{d.running[t] ?? 0}</div>
                        <div className="text-xs text-silver">{TYPE[t].label}</div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </section>

          <section aria-labelledby="invoices" className="space-y-2">
            <h2 id="invoices" className="text-base font-semibold text-white">Invoices</h2>
            <Card>
              <CardContent className="p-0">
                {d.invoices.length === 0 ? (
                  <p className="p-6 text-sm text-silver">{d.invoiced ? 'No invoice yet: the first follows the end of your first month.' : 'Your plan is not invoiced.'}</p>
                ) : (
                  <ul className="divide-y divide-navy-secondary">
                    {d.invoices.map((i) => (
                      <li key={i.id} className="space-y-1 px-4 py-3 text-sm">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-white">{i.month}</span>
                          <Badge variant={STATUS[i.status]} size="sm">
                            {i.status === 'OPEN' ? 'Due' : i.status.charAt(0) + i.status.slice(1).toLowerCase()}
                          </Badge>
                          <span className="ml-auto font-semibold text-white">{fmtMoney(i.totalCents / 100)}</span>
                          {i.hostedUrl && (
                            <a className="inline-flex items-center gap-1 text-gold underline underline-offset-2" href={i.hostedUrl} target="_blank" rel="noreferrer">
                              View <ExternalLink className="h-3 w-3" aria-hidden="true" />
                            </a>
                          )}
                        </div>
                        <p className="text-xs text-silver">
                          {i.lines.map((l) => `${l.quantity} ${TYPE[l.type].label.toLowerCase()}${l.unitPriceCents !== null ? ` × ${fmtMoney(l.unitPriceCents / 100)}` : ''}`).join(' · ') || 'Nothing billable'}
                        </p>
                        {i.status === 'DRAFT' && i.holdReason && <p className="text-xs text-warning">{HOLD[i.holdReason] ?? 'Being prepared.'}</p>}
                        {i.lastPaymentError && <p className="text-xs text-alert">{i.lastPaymentError}</p>}
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </section>
        </>
      )}
    </div>
  );
}
