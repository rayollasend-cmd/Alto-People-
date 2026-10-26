import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, CreditCard, Cpu, ExternalLink, Users as UsersIcon } from '@/components/ui/icons';
import { ApiError, apiFetch } from '@/lib/api';
import { useAuth, useTenant } from '@/lib/auth';
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
import { EmptyState } from '@/components/ui/EmptyState';

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
  /** The plan in words, from the API ("Internal", "Not invoiced", "Growth"). */
  planLabel?: string;
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
    lines: Array<{ type: WorkerType; quantity: number; unitPriceCents: number | null; amountCents: number; label?: string }>;
    holdReason: string | null;
    hostedUrl: string | null;
    lastPaymentError: string | null;
    paidAt: string | null;
  }>;
}

const TYPE: Record<WorkerType, { label: string; one: string; icon: typeof UsersIcon }> = {
  PERSON: { label: 'People', one: 'person', icon: UsersIcon },
  AGENT: { label: 'AI agents', one: 'AI agent', icon: Bot },
  ROBOT: { label: 'Robots', one: 'robot', icon: Cpu },
};
const ALL_TYPES = Object.keys(TYPE) as WorkerType[];

/** "Internal" → "Internal plan"; a plan code reads as words, not as stored. */
const planName = (plan: string) => {
  const words = plan.replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}${/plan$/.test(words) ? '' : ' plan'}` : 'No plan';
};
const STATUS: Record<BillingOverview['invoices'][number]['status'], 'pending' | 'accent' | 'success' | 'default'> = { DRAFT: 'pending', OPEN: 'accent', PAID: 'success', VOID: 'default' };
const HOLD: Record<string, string> = {
  prices_missing: 'Waiting for your plan’s prices.',
  stripe_not_configured: 'Waiting for the payment processor to be connected.',
};

export function BillingHome() {
  const q = useQuery({ queryKey: ['billing', 'overview'], queryFn: () => apiFetch<BillingOverview>('/billing') });
  const { moduleOn } = useTenant();
  const d = q.data;
  // A worker type shows when the tenant runs it or something was counted for it:
  // a "Robots 0" tile for a company with no robots said nothing (F500 audit 2026-10-26).
  const types = d
    ? ALL_TYPES.filter(
        (t) =>
          t === 'PERSON' ||
          (t === 'ROBOT' && moduleOn('robotics')) ||
          (d.running[t] ?? 0) > 0 ||
          (d.history ?? []).some((h) => (h.counts[t] ?? 0) > 0) ||
          d.invoices.some((i) => i.lines.some((l) => l.type === t && l.quantity > 0)),
      )
    : ALL_TYPES;
  return (
    <div className="space-y-5">
      <PageHeader
        title="Billing"
        subtitle="Your plan, the people and agents active each month, and your invoices."
        facts={
          d
            ? [
                { label: 'Plan', value: d.planLabel ?? planName(d.plan) },
                { label: 'Invoicing', value: d.invoiced ? (d.stripe === 'test' ? 'Monthly · test mode' : 'Monthly') : 'Not invoiced' },
                { label: 'Days counted this month', value: String(d.daysCounted) },
              ]
            : undefined
        }
      />
      {q.isError ? (
        <QueryError what="billing" query={q} />
      ) : !d ? (
        <SkeletonRows count={4} />
      ) : (
        <>
          {!d.invoiced && (
            <p className="text-sm text-ink-muted" data-testid="billing-internal">
              {planName(d.plan)} accounts aren’t invoiced. Usage is still counted below, the same way an invoiced plan counts it.
            </p>
          )}
          {d.invoiced && d.stripe === 'test' && (
            <p className="text-sm text-ink-muted">
              <Badge variant="pending" size="sm">Test mode</Badge> The payment processor is in test mode: invoices are drafts, and no card is charged.
            </p>
          )}

          {d.invoiced && d.contact && <ContactCard contact={d.contact} />}

          <section aria-labelledby="running" className="space-y-2">
            <h2 id="running" className="text-base font-semibold text-ink">
              {fmtMonth(d.month, 'long')} so far
            </h2>
            <p className="text-sm text-ink-muted">
              Each {types.map((t) => TYPE[t].one).join(', ').replace(/, ([^,]*)$/, ' and $1')} active on at least one day of the month counts once.
            </p>
            <MetricStrip label={`${fmtMonth(d.month, 'long')} so far`}>
              {types.map((t) => (
                <MetricCard key={t} icon={TYPE[t].icon} label={TYPE[t].label} value={String(d.running[t] ?? 0)} />
              ))}
            </MetricStrip>
          </section>

          <HistorySection month={d.month} running={d.running} daysCounted={d.daysCounted} history={d.history ?? []} invoices={d.invoices} types={types} />

          <section aria-labelledby="invoices" className="space-y-2">
            <h2 id="invoices" className="text-base font-semibold text-ink">Invoices</h2>
            {d.invoices.length === 0 ? (
              <EmptyState
                size="sm"
                icon={CreditCard}
                title={d.invoiced ? 'No invoices yet' : 'Not invoiced'}
                description={d.invoiced ? 'The first invoice follows the end of your first month.' : `The ${planName(d.plan).toLowerCase()} has no invoices.`}
              />
            ) : (
            <Card>
              <CardContent className="p-0">
                {(
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
                          {i.lines.map((l) => `${l.label ?? `${l.quantity} ${l.quantity === 1 ? TYPE[l.type].one : TYPE[l.type].label}`}${l.unitPriceCents !== null ? ` × ${fmtMoney(l.unitPriceCents / 100)}` : ''}`).join(' · ') || 'Nothing billable'}
                        </p>
                        {i.status === 'DRAFT' && i.holdReason && <p className="text-xs text-warning">{HOLD[i.holdReason] ?? 'Being prepared.'}</p>}
                        {i.lastPaymentError && <p className="text-xs text-alert">{i.lastPaymentError}</p>}
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
            )}
          </section>
        </>
      )}
    </div>
  );
}

/**
 * Usage month by month — this month so far, then the six before it — beside
 * the invoice each became (F500 G4). A table, always: the history used to
 * collapse into one sentence ("No activity was counted from April to
 * September"), which read as a page left unfinished. A month nothing was
 * counted in says so in its row.
 */
function HistorySection({
  month,
  running,
  daysCounted,
  history,
  invoices,
  types,
}: {
  month: string;
  running: Record<WorkerType, number>;
  daysCounted: number;
  history: NonNullable<BillingOverview['history']>;
  invoices: BillingOverview['invoices'];
  types: WorkerType[];
}) {
  const byMonth = new Map(invoices.map((i) => [i.month, i]));
  const past = history.map((h) => ({ ...h, current: false, invoice: byMonth.get(h.month) ?? null }));
  // Months with nothing counted and no invoice fold into one line under the table, not six rows of dashes.
  const quiet = past.filter((r) => r.daysCounted === 0 && !r.invoice);
  const rows = [
    { month, daysCounted, counts: running, current: true, invoice: null as BillingOverview['invoices'][number] | null },
    ...past.filter((r) => !quiet.includes(r)),
  ];
  const quietNote =
    quiet.length === 0
      ? undefined
      : quiet.length === 1
        ? `Nothing was counted in ${fmtMonth(quiet[0]!.month, 'long')}.`
        : `Nothing was counted from ${fmtMonth(quiet[quiet.length - 1]!.month, 'long')} to ${fmtMonth(quiet[0]!.month, 'long')}.`;
  const count = (t: WorkerType) => (r: (typeof rows)[number]) =>
    r.daysCounted === 0 && !r.current ? <span className="text-ink-muted">—</span> : (r.counts[t] ?? 0).toLocaleString('en-US');
  return (
    <section aria-labelledby="billing-history" className="space-y-2">
      <h2 id="billing-history" className="text-base font-semibold text-ink">
        Usage by month
      </h2>
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
        footnote={quietNote}
        columns={[
          {
            key: 'month',
            header: 'Month',
            accessor: (r) => r.month,
            primary: true,
            cell: (r) => (
              <span>
                {fmtMonth(r.month, 'long')}
                {r.current && <span className="ml-1.5 text-xs text-ink-muted">so far</span>}
              </span>
            ),
            csv: (r) => fmtMonth(r.month, 'long'),
          },
          { key: 'days', header: 'Days counted', accessor: (r) => r.daysCounted, align: 'right', className: 'tabular-nums', cell: (r) => (r.daysCounted === 0 ? <span className="text-ink-muted">None</span> : r.daysCounted) },
          ...types.map((t) => ({
            key: t,
            header: TYPE[t].label,
            accessor: (r: (typeof rows)[number]) => r.counts[t] ?? 0,
            align: 'right' as const,
            className: 'tabular-nums',
            cell: count(t),
          })),
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
              ) : r.current ? (
                <span className="text-ink-muted">After the month ends</span>
              ) : r.daysCounted === 0 ? (
                <span className="text-ink-muted">Not counted</span>
              ) : (
                <span className="text-ink-muted">Not invoiced</span>
              ),
            csv: (r) => (r.invoice ? fmtMoney(r.invoice.totalCents / 100) : ''),
          },
        ]}
      />
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
