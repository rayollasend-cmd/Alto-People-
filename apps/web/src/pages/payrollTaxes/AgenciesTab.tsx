import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Building2, ClipboardList, History, Plus } from 'lucide-react';
import {
  createTaxAccount,
  getAgency,
  listAgencies,
  rebuildLiabilities,
  updateTaxAccount,
  type AgencyAccount,
  type AgencyKind,
  type AgencySummary,
  type DepositFrequency,
  type RegistrationNeed,
} from '@/lib/payrollTaxesApi';
import { fmtDate, fmtMoney } from '@/lib/format';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Drawer, DrawerBody, DrawerDescription, DrawerHeader, DrawerTitle } from '@/components/ui/Drawer';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { QueryError } from '@/components/ui/QueryError';
import { Select } from '@/components/ui/Select';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { FREQUENCY_LABEL, KIND_SHORT, LiabilityBadge, NoticeBadge, PaymentBadge, ReturnBadge, localToday } from './taxShared';

/** Every agency payroll owes, its account, and the drill-down into one. */
export function AgenciesTab({ registrations }: { registrations: RegistrationNeed[] }) {
  const q = useQuery({ queryKey: ['payroll-taxes', 'agencies'], queryFn: listAgencies });
  const [open, setOpen] = useState<{ kind: AgencyKind; jurisdiction: string } | null>(null);
  const [adding, setAdding] = useState<Partial<AgencyAccount> | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const columns: GridColumn<AgencySummary>[] = [
    { key: 'agency', header: 'Agency', primary: true, accessor: (a) => a.agency, cell: (a) => <span className="font-medium text-ink">{a.agency}</span>, sortable: true },
    { key: 'kind', header: 'Tax', accessor: (a) => KIND_SHORT[a.kind], cardMeta: true },
    { key: 'account', header: 'Account', accessor: (a) => a.accountNumber ?? '', cell: (a) => (a.accountStatus === 'PENDING_REGISTRATION' ? <Badge variant="pending">Register</Badge> : a.accountNumber ?? <span className="text-ink-muted">—</span>) },
    { key: 'schedule', header: 'Deposits', accessor: (a) => (a.depositFrequency ? (FREQUENCY_LABEL[a.depositFrequency] ?? a.depositFrequency) : '') },
    { key: 'open', header: 'Owed', accessor: (a) => a.open, cell: (a) => fmtMoney(a.open), align: 'right', className: 'tabular-nums', sortable: true },
    { key: 'next', header: 'Next due', accessor: (a) => a.nextDue ?? '', cell: (a) => (a.nextDue ? fmtDate(a.nextDue) : <span className="text-ink-muted">—</span>), sortable: true },
  ];
  return (
    <div className="space-y-4">
      {registrations.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Register in a new state</CardTitle>
            <CardDescription>Each one needs an account before payroll can pay it. Enter the account number when the agency assigns it.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-navy-secondary">
              {registrations.map((r) => (
                <li key={`${r.kind}|${r.jurisdiction}`} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-ink">{r.agencyName}</p>
                    <p className="text-xs text-ink-muted">{r.reason}</p>
                    <ol className="mt-1.5 list-decimal space-y-0.5 pl-5 text-sm text-ink-muted">
                      {r.steps.map((s) => (
                        <li key={s}>{s}</li>
                      ))}
                    </ol>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="shrink-0"
                    onClick={() => (r.accountId ? setOpen({ kind: r.kind, jurisdiction: r.jurisdiction }) : setAdding({ kind: r.kind, jurisdiction: r.jurisdiction, agencyName: r.agencyName }))}
                  >
                    Enter account
                  </Button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => setRebuilding(true)}>
          <History className="mr-1.5 h-4 w-4" aria-hidden /> Post past payrolls
        </Button>
        <Button size="sm" onClick={() => setAdding({})}>
          <Plus className="mr-1.5 h-4 w-4" aria-hidden /> Add an account
        </Button>
      </div>
      <DataGrid<AgencySummary>
        id="payroll-taxes-agencies"
        caption="Tax agencies"
        noun={{ one: 'agency', many: 'agencies' }}
        rows={q.data?.agencies}
        loading={q.isLoading}
        error={q.isError ? (q.error as Error).message : null}
        onRetry={() => void q.refetch()}
        columns={columns}
        rowKey={(a) => `${a.kind}|${a.jurisdiction}`}
        onRowClick={(a) => setOpen({ kind: a.kind, jurisdiction: a.jurisdiction })}
        rowActionLabel={(a) => `Open ${a.agency}`}
        empty={{ icon: Building2, title: 'No agencies yet', description: 'Agencies appear when payroll posts its first taxes, or add an account now.' }}
      />
      {open && <AgencyDrawer kind={open.kind} jurisdiction={open.jurisdiction} onClose={() => setOpen(null)} />}
      {adding && <AccountDialog initial={adding} onClose={() => setAdding(null)} />}
      {rebuilding && <RebuildDialog onClose={() => setRebuilding(false)} />}
    </div>
  );
}

function AgencyDrawer({ kind, jurisdiction, onClose }: { kind: AgencyKind; jurisdiction: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ['payroll-taxes', 'agency', kind, jurisdiction], queryFn: () => getAgency(kind, jurisdiction) });
  const [editing, setEditing] = useState<AgencyAccount | null>(null);
  const a = q.data;
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} width="max-w-2xl">
      <DrawerHeader>
        <DrawerTitle>{a?.agency ?? 'Agency'}</DrawerTitle>
        <DrawerDescription>{a?.kindLabel ?? ' '}</DrawerDescription>
      </DrawerHeader>
      <DrawerBody>
        {q.isError ? (
          <QueryError what="this agency" query={q} />
        ) : !a ? (
          <SkeletonRows count={6} />
        ) : (
          <div className="space-y-6">
            <section aria-label="Account" className="space-y-2">
              <p className="text-sm font-medium text-ink">Account</p>
              {a.accounts.length === 0 ? (
                <EmptyState size="sm" icon={ClipboardList} title="No account on file" />
              ) : (
                a.accounts.map((acct) => (
                  <div key={acct.id} className="rounded-md border border-navy-secondary p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm text-ink">{acct.accountNumber ? `Account ${acct.accountNumber}` : 'Account number not entered'}</p>
                        <p className="text-xs text-ink-muted">
                          {`${FREQUENCY_LABEL[acct.depositFrequency] ?? acct.depositFrequency} deposits${acct.depositFrequency === 'MONTHLY' ? `, due the ${acct.dueDayOfMonth}th` : ''}`}
                          {acct.rate !== null ? ` · rate ${(acct.rate * 100).toFixed(3)}%${acct.rateYear ? ` for ${acct.rateYear}` : ''}` : ''}
                          {acct.wageBase !== null ? ` · wage base ${fmtMoney(acct.wageBase)}` : ''}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {acct.status === 'PENDING_REGISTRATION' && <Badge variant="pending">Waiting on registration</Badge>}
                        {acct.status === 'CLOSED' && <Badge variant="outline">Closed</Badge>}
                        <Button size="xs" variant="outline" onClick={() => setEditing(acct)}>
                          Edit
                        </Button>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </section>

            <section aria-label="Taxes posted" className="space-y-2">
              <p className="text-sm font-medium text-ink">Taxes posted</p>
              {a.liabilities.length === 0 ? (
                <EmptyState size="sm" icon={ClipboardList} title="No taxes posted" />
              ) : (
                <ul className="divide-y divide-navy-secondary text-sm">
                  {a.liabilities.slice(0, 20).map((l) => (
                    <li key={l.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                      <span className="min-w-0 flex-1">{`Payday ${fmtDate(l.liabilityDate)} · due ${fmtDate(l.dueDate)}`}</span>
                      <span className="tabular-nums">{fmtMoney(l.amount)}</span>
                      <LiabilityBadge status={l.status} />
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-label="Payments" className="space-y-2">
              <p className="text-sm font-medium text-ink">Payments</p>
              {a.payments.length === 0 ? (
                <EmptyState size="sm" icon={ClipboardList} title="No payments" />
              ) : (
                <ul className="divide-y divide-navy-secondary text-sm">
                  {a.payments.slice(0, 20).map((p) => (
                    <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                      <span className="min-w-0 flex-1">{`${p.periodLabel} · ${p.paidAt ? `paid ${fmtDate(p.paidAt)}` : `due ${fmtDate(p.dueDate)}`}${p.confirmationNumber ? ` · ${p.confirmationNumber}` : ''}`}</span>
                      <span className="tabular-nums">{fmtMoney(p.amount)}</span>
                      <PaymentBadge status={p.status} />
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-label="Returns" className="space-y-2">
              <p className="text-sm font-medium text-ink">Returns</p>
              {a.returns.filter((r) => r.status !== 'SUPERSEDED').length === 0 ? (
                <EmptyState size="sm" icon={ClipboardList} title="No returns prepared" />
              ) : (
                <ul className="divide-y divide-navy-secondary text-sm">
                  {a.returns.filter((r) => r.status !== 'SUPERSEDED').slice(0, 12).map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                      <span className="min-w-0 flex-1">{`${r.label} · ${r.periodLabel}`}</span>
                      <ReturnBadge status={r.status} />
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-label="Notices" className="space-y-2">
              <p className="text-sm font-medium text-ink">Notices</p>
              {a.notices.length === 0 ? (
                <EmptyState size="sm" icon={ClipboardList} title="No notices from this agency" />
              ) : (
                <ul className="divide-y divide-navy-secondary text-sm">
                  {a.notices.map((n) => (
                    <li key={n.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                      <span className="min-w-0 flex-1">{`${n.noticeType} · ${fmtDate(n.noticeDate)}`}</span>
                      <NoticeBadge status={n.status} />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </DrawerBody>
      {editing && <AccountDialog initial={editing} onClose={() => setEditing(null)} />}
    </Drawer>
  );
}

const KIND_OPTIONS: Array<{ value: AgencyKind; label: string }> = [
  { value: 'FEDERAL_WITHHOLDING', label: 'Federal withholding and FICA (941)' },
  { value: 'FEDERAL_UNEMPLOYMENT', label: 'Federal unemployment (940)' },
  { value: 'STATE_WITHHOLDING', label: 'State withholding' },
  { value: 'STATE_UNEMPLOYMENT', label: 'State unemployment' },
  { value: 'LOCAL', label: 'Local tax' },
];

function AccountDialog({ initial, onClose }: { initial: Partial<AgencyAccount>; onClose: () => void }) {
  const qc = useQueryClient();
  const editing = !!initial.id;
  const [kind, setKind] = useState<AgencyKind>(initial.kind ?? 'STATE_WITHHOLDING');
  const [jurisdiction, setJurisdiction] = useState(initial.jurisdiction ?? '');
  const [agencyName, setAgencyName] = useState(initial.agencyName ?? '');
  const [accountNumber, setAccountNumber] = useState(initial.accountNumber ?? '');
  const [frequency, setFrequency] = useState<DepositFrequency>(initial.depositFrequency ?? (kind === 'STATE_UNEMPLOYMENT' ? 'QUARTERLY' : 'MONTHLY'));
  const [dueDay, setDueDay] = useState(String(initial.dueDayOfMonth ?? 15));
  const [rate, setRate] = useState(initial.rate === null || initial.rate === undefined ? '' : String(+(initial.rate * 100).toFixed(4)));
  const [rateYear, setRateYear] = useState(String(initial.rateYear ?? localToday().slice(0, 4)));
  const [wageBase, setWageBase] = useState(initial.wageBase === null || initial.wageBase === undefined ? '' : String(initial.wageBase));
  const [status, setStatus] = useState(initial.status ?? 'ACTIVE');
  const [error, setError] = useState<string | null>(null);
  const isFederal = kind.startsWith('FEDERAL');
  const isUi = kind === 'STATE_UNEMPLOYMENT';
  const save = useMutation({
    mutationFn: () => {
      const body = {
        agencyName: agencyName.trim() || undefined,
        accountNumber: accountNumber.trim() || null,
        depositFrequency: frequency,
        dueDayOfMonth: Number(dueDay),
        rate: isUi && rate.trim() ? Number(rate) / 100 : isUi ? null : undefined,
        rateYear: isUi && rateYear.trim() ? Number(rateYear) : undefined,
        wageBase: isUi && wageBase.trim() ? Number(wageBase) : isUi ? null : undefined,
        ...(editing ? { status } : {}),
      };
      return editing ? updateTaxAccount(initial.id!, body) : createTaxAccount({ ...body, kind, jurisdiction: isFederal ? 'US' : jurisdiction.trim() });
    },
    onSuccess: () => {
      toast.success(editing ? 'Account saved.' : 'Account added.');
      void qc.invalidateQueries({ queryKey: ['payroll-taxes'] });
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${initial.agencyName}` : 'Add an agency account'}</DialogTitle>
          <DialogDescription>The account number, how often the agency wants deposits and, for unemployment, this year’s rate and wage base.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            if (!editing && !isFederal && jurisdiction.trim().length < 2) {
              setError(kind === 'LOCAL' ? 'Enter the local, like PA:Philadelphia.' : 'Enter the state, like CA.');
              return;
            }
            save.mutate();
          }}
        >
          {!editing && (
            <>
              <Field label="Tax" required>
                {(p) => (
                  <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as AgencyKind)}>
                    {KIND_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </Select>
                )}
              </Field>
              {!isFederal && (
                <Field label={kind === 'LOCAL' ? 'Local' : 'State'} required hint={kind === 'LOCAL' ? 'State and name, like PA:Philadelphia.' : 'Two letters, like CA.'}>
                  {(p) => <Input {...p} value={jurisdiction} maxLength={80} onChange={(e) => setJurisdiction(kind === 'LOCAL' ? e.target.value : e.target.value.toUpperCase())} />}
                </Field>
              )}
            </>
          )}
          <Field label="Agency name" className="sm:col-span-2" hint={editing ? undefined : 'Leave empty for the usual name.'}>
            {(p) => <Input {...p} value={agencyName} maxLength={160} onChange={(e) => setAgencyName(e.target.value)} />}
          </Field>
          <Field label="Account number" hint="Entering it completes a registration.">
            {(p) => <Input {...p} value={accountNumber} maxLength={60} autoComplete="off" onChange={(e) => setAccountNumber(e.target.value)} />}
          </Field>
          <Field label="Deposit schedule">
            {(p) => (
              <Select {...p} value={frequency} onChange={(e) => setFrequency(e.target.value as DepositFrequency)}>
                {Object.entries(FREQUENCY_LABEL).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </Select>
            )}
          </Field>
          {frequency === 'MONTHLY' && (
            <Field label="Due day of the next month" hint="The IRS and most states use the 15th.">
              {(p) => <Input {...p} type="number" min="1" max="28" value={dueDay} onChange={(e) => setDueDay(e.target.value)} />}
            </Field>
          )}
          {isUi && (
            <>
              <Field label="Your rate (%)" hint="From the state’s rate notice.">
                {(p) => <Input {...p} type="number" inputMode="decimal" min="0" max="20" step="0.001" value={rate} onChange={(e) => setRate(e.target.value)} />}
              </Field>
              <Field label="Rate year">
                {(p) => <Input {...p} type="number" min="2000" max="2100" value={rateYear} onChange={(e) => setRateYear(e.target.value)} />}
              </Field>
              <Field label="Wage base" hint="Wages per person the rate applies to.">
                {(p) => <Input {...p} type="number" inputMode="decimal" min="0" step="1" value={wageBase} onChange={(e) => setWageBase(e.target.value)} />}
              </Field>
            </>
          )}
          {editing && (
            <Field label="Status">
              {(p) => (
                <Select {...p} value={status} onChange={(e) => setStatus(e.target.value as AgencyAccount['status'])}>
                  <option value="ACTIVE">Active</option>
                  <option value="PENDING_REGISTRATION">Waiting on registration</option>
                  <option value="CLOSED">Closed</option>
                </Select>
              )}
            </Field>
          )}
          {error && <p className="text-sm text-alert sm:col-span-2" role="alert">{error}</p>}
          <DialogFooter className="sm:col-span-2">
            <Button type="button" variant="ghost" onClick={onClose}>Not now</Button>
            <Button type="submit" loading={save.isPending}>{editing ? 'Save' : 'Add account'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RebuildDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const year = localToday().slice(0, 4);
  const [from, setFrom] = useState(`${year}-01-01`);
  const [to, setTo] = useState(localToday());
  const run = useMutation({
    mutationFn: () => rebuildLiabilities(from, to),
    onSuccess: (r) => {
      toast.success(`Posted taxes for ${r.runs} payroll${r.runs === 1 ? '' : 's'}.`);
      void qc.invalidateQueries({ queryKey: ['payroll-taxes'] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Post past payrolls</DialogTitle>
          <DialogDescription>Adds the taxes for payrolls paid in these dates. Taxes already paid or being paid are left alone.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Paid from">{(p) => <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
          <Field label="Paid through">{(p) => <Input {...p} type="date" value={to} max={localToday()} onChange={(e) => setTo(e.target.value)} />}</Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Not now</Button>
          <Button onClick={() => run.mutate()} loading={run.isPending}>Post taxes</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
