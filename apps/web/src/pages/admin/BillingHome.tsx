import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, CreditCard, Cpu, ExternalLink, Users as UsersIcon } from 'lucide-react';
import { ApiError, apiFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtMoney, fmtMonth } from '@/lib/format';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { toast } from '@/components/ui/Toaster';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryError } from '@/components/ui/QueryError';
import { SkeletonRows } from '@/components/ui';
import { DataGrid } from '@/components/ui/DataGrid';
import { MetricCard } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';

/**
 * Brief 2-6 step 4 — Billing: the plan, this month's billable count so far
 * by worker type (people, AI agents, robots active on at least one day,
 * decision 1), and the invoices with their hosted links. Counts and prices
 * only; who was active stays in the daily evidence and never reaches the
 * payment processor. The internal plan is never invoiced.
 */

type WorkerType = 'PERSON' | 'AGENT' | 'ROBOT';

interface BillingContact {
  name: string | null;
  email: string | null;
  paymentMethod: { kind: 'card' | 'bank' | 'other'; label: string } | null;
  paymentMethodNote: 'stripe_off' | 'no_customer' | 'error' | null;
}

interface BillingOverview {
  contact?: BillingContact;
  plan: string;
  invoiced: boolean;
  stripe: 'test' | 'live' | 'off';
  month: string;
  daysCounted: number;
  running: Record<WorkerType, number>;
  /** The six months before this one, newest first: each id active on a day counts once. */
  history?: Array<{ month: string; daysCounted: number; counts: Record<WorkerType, number> }>;
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

const TYPE: Record<WorkerType, { label: string; one: string; icon: typeof UsersIcon }> = {
  PERSON: { label: 'People', one: 'Person', icon: UsersIcon },
  AGENT: { label: 'AI agents', one: 'AI agent', icon: Bot },
  ROBOT: { label: 'Robots', one: 'Robot', icon: Cpu },
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
      <PageHeader title="Billing" subtitle="Your plan, this month’s active workers by type, and your invoices." />
      {q.isError ? (
        <QueryError what="billing" query={q} />
      ) : !d ? (
        <SkeletonRows count={4} />
      ) : (
        <>
          <Card>
            <CardContent className="flex flex-wrap items-center gap-3 text-sm">
              <span className="text-silver">Plan</span>
              <span className="font-semibold capitalize text-white">{d.plan}</span>
              {!d.invoiced && <Badge variant="default" size="sm">Not invoiced</Badge>}
              {d.invoiced && d.stripe === 'test' && <Badge variant="pending" size="sm">Payment processor in test mode</Badge>}
            </CardContent>
          </Card>

          {d.invoiced && d.contact && <ContactCard contact={d.contact} />}

          <section aria-labelledby="running" className="space-y-2">
            <h2 id="running" className="text-base font-semibold text-white">
              {fmtMonth(d.month, 'long')} so far
            </h2>
            <p className="text-sm text-silver">Each person, agent and robot active on at least one day of the month counts once. {d.daysCounted} day{d.daysCounted === 1 ? '' : 's'} counted so far.</p>
            <MetricStrip label={`${fmtMonth(d.month, 'long')} so far`}>
              {(Object.keys(TYPE) as WorkerType[]).map((t) => (
                <MetricCard key={t} icon={TYPE[t].icon} label={TYPE[t].label} value={String(d.running[t] ?? 0)} hint={(d.running[t] ?? 0) === 1 ? `1 ${TYPE[t].one.toLowerCase()} active` : undefined} />
              ))}
            </MetricStrip>
          </section>

          {d.history && d.history.length > 0 && <HistorySection history={d.history} invoices={d.invoices} />}

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
                          <span className="font-medium text-white">{fmtMonth(i.month, 'long')}</span>
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

/** The last six months, month by month, beside the invoice each became (F500 G4). */
function HistorySection({ history, invoices }: { history: NonNullable<BillingOverview['history']>; invoices: BillingOverview['invoices'] }) {
  const byMonth = new Map(invoices.map((i) => [i.month, i]));
  const rows = history.map((h) => ({ ...h, invoice: byMonth.get(h.month) ?? null }));
  // Six rows of zeros say less than one line (a new account, or counting began this month).
  const nothingCounted = rows.every((r) => r.daysCounted === 0 && !r.invoice);
  return (
    <section aria-labelledby="billing-history" className="space-y-2">
      <h2 id="billing-history" className="text-base font-semibold text-white">
        The last six months
      </h2>
      {nothingCounted ? (
        <p className="text-sm text-ink-muted">No activity was counted from {fmtMonth(rows[rows.length - 1]!.month, 'long')} to {fmtMonth(rows[0]!.month, 'long')}.</p>
      ) : (
      <DataGrid
        id="billing-history"
        caption="Billable workers by month"
        noun={{ one: 'month', many: 'months' }}
        rows={rows}
        rowKey={(r) => r.month}
        search={false}
        urlState={false}
        columnChooser={false}
        exportCsv={{ filename: 'billing-history' }}
        columns={[
          { key: 'month', header: 'Month', accessor: (r) => r.month, primary: true, cell: (r) => fmtMonth(r.month, 'long'), csv: (r) => fmtMonth(r.month, 'long') },
          { key: 'people', header: 'People', accessor: (r) => r.counts.PERSON ?? 0, align: 'right', className: 'tabular-nums' },
          { key: 'agents', header: 'AI agents', accessor: (r) => r.counts.AGENT ?? 0, align: 'right', className: 'tabular-nums' },
          { key: 'robots', header: 'Robots', accessor: (r) => r.counts.ROBOT ?? 0, align: 'right', className: 'tabular-nums' },
          {
            key: 'invoice',
            header: 'Invoice',
            accessor: (r) => r.invoice?.totalCents ?? -1,
            align: 'right',
            className: 'tabular-nums',
            cell: (r) =>
              r.invoice ? (
                <span className="inline-flex items-center gap-2">
                  <Badge variant={STATUS[r.invoice.status]} size="sm">
                    {r.invoice.status === 'OPEN' ? 'Due' : r.invoice.status.charAt(0) + r.invoice.status.slice(1).toLowerCase()}
                  </Badge>
                  {fmtMoney(r.invoice.totalCents / 100)}
                </span>
              ) : r.daysCounted === 0 ? (
                <span className="text-ink-muted">No activity counted</span>
              ) : (
                <span className="text-ink-muted">Not invoiced</span>
              ),
            csv: (r) => (r.invoice ? fmtMoney(r.invoice.totalCents / 100) : ''),
          },
        ]}
      />
      )}
    </section>
  );
}

const PM_NOTE: Record<NonNullable<BillingContact['paymentMethodNote']>, string> = {
  stripe_off: 'The payment processor isn’t connected yet, so no payment method can be on file.',
  no_customer: 'None yet — your first invoice comes with a link to add one.',
  error: 'Couldn’t reach the payment processor just now. Try again in a moment.',
};

/** Who the invoices go to, and the card or bank on file at the payment processor (audit 2026-10-21, Tier 3). */
function ContactCard({ contact }: { contact: BillingContact }) {
  const { can } = useAuth();
  const edit = can('manage:org');
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const save = useMutation({
    mutationFn: () => apiFetch<{ stripeUpdated: boolean }>('/billing/contact', { method: 'PUT', body: { name: name.trim() || null, email: email.trim() || null } }),
    onSuccess: (r) => {
      toast.success(r.stripeUpdated ? 'Billing contact saved — the payment processor has it too.' : 'Billing contact saved.');
      setEditing(false);
      void qc.invalidateQueries({ queryKey: ['billing', 'overview'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save the contact.'),
  });
  return (
    <section aria-labelledby="billing-contact" className="space-y-2">
      <h2 id="billing-contact" className="text-base font-semibold text-ink">
        Billing contact and payment method
      </h2>
      <Card>
        <CardContent className="space-y-3 text-sm">
          {editing ? (
            <form
              className="grid gap-3 sm:grid-cols-2"
              onSubmit={(e) => {
                e.preventDefault();
                save.mutate();
              }}
            >
              <Field label="Name on invoices">{(p) => <Input value={name} maxLength={160} onChange={(e) => setName(e.target.value)} {...p} />}</Field>
              <Field label="Invoices go to">{(p) => <Input type="email" value={email} maxLength={254} placeholder="ap@yourcompany.com" onChange={(e) => setEmail(e.target.value)} {...p} />}</Field>
              <div className="flex gap-2 sm:col-span-2">
                <Button type="submit" size="sm" loading={save.isPending}>
                  Save contact
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[auto_1fr]">
              <dt className="text-ink-muted">Name on invoices</dt>
              <dd className="text-ink">{contact.name ?? 'Not set'}</dd>
              <dt className="text-ink-muted">Invoices go to</dt>
              <dd className="text-ink">{contact.email ?? 'Not set'}</dd>
              <dt className="text-ink-muted">Payment method</dt>
              <dd className="flex items-center gap-2 text-ink">
                {contact.paymentMethod ? (
                  <>
                    <CreditCard className="h-4 w-4 text-ink-muted" aria-hidden="true" />
                    {contact.paymentMethod.label}
                  </>
                ) : (
                  <span className={contact.paymentMethodNote === 'error' ? 'text-warning' : 'text-ink-muted'}>{contact.paymentMethodNote ? PM_NOTE[contact.paymentMethodNote] : 'None on file.'}</span>
                )}
              </dd>
            </dl>
          )}
          {edit && !editing && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setName(contact.name ?? '');
                setEmail(contact.email ?? '');
                setEditing(true);
              }}
            >
              Edit contact
            </Button>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
