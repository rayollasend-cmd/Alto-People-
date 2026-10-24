import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CheckCircle2, Download, FileUp, Inbox, Landmark, Plus, Scale, Send } from '@/components/ui/icons';
import {
  acceptEiwo,
  createNotice,
  deleteLevyParameter,
  deleteStateRule,
  downloadAck,
  downloadAdvicePdf,
  downloadNotice,
  getDesk,
  listEiwo,
  listLevyParameters,
  listNotices,
  listRemittances,
  markNoticeSent,
  markRemittanceSent,
  rejectEiwo,
  requestPayeeBank,
  saveLevyParameter,
  saveOrderDetails,
  saveStateRule,
  sendRemittances,
  uploadEiwo,
  type DeskOrder,
  type EiwoDoc,
  type GarnishmentKind,
  type LevyParameter,
  type PendingRemittance,
  type RemitMethod,
  type StateRule,
} from '@/lib/deductionsApi';
import { useTerm } from '@/lib/auth';
import { useConfirm, usePrompt } from '@/lib/confirm';
import { fmtDate, fmtMoney } from '@/lib/format';
import { ListTemplate } from '@/components/templates';
import { AssociatePicker, type PickedAssociate } from '@/components/ui/AssociatePicker';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Drawer, DrawerBody, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from '@/components/ui/Drawer';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { MetricCard } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { useUrlParam } from '@/lib/useUrlState';
import { QueryError } from '@/components/ui/QueryError';
import { Select } from '@/components/ui/Select';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import { CreateGarnishmentDialog } from '../payroll/GarnishmentsView';

/**
 * The garnishment desk: every withholding order with what's left to pay,
 * when the next payment is due and where it goes; the e-IWO inbox where
 * agencies' orders arrive and get answered; the remittance queue with
 * electronic payment to State Disbursement Units; and the state rules and
 * IRS levy tables the withholding math reads.
 */

type Tab = 'orders' | 'eiwo' | 'remittances' | 'rules';
const TABS: Tab[] = ['orders', 'eiwo', 'remittances', 'rules'];

export const KIND_LABEL: Record<GarnishmentKind, string> = {
  CHILD_SUPPORT: 'Child support',
  TAX_LEVY: 'Tax levy',
  STUDENT_LOAN: 'Student loan',
  BANKRUPTCY: 'Bankruptcy',
  CREDITOR: 'Creditor',
  OTHER: 'Other',
};
const METHOD_LABEL: Record<RemitMethod, string> = { CHECK: 'Check', ACH: 'ACH', EFT_SDU: 'SDU electronic', PORTAL: 'Agency site' };
const ACTION_LABEL: Record<EiwoDoc['documentActionCode'], string> = { ORG: 'New order', AMD: 'Amended', TRM: 'Ends withholding', LUM: 'Lump sum' };
const FILING_LABEL: Record<string, string> = {
  SINGLE: 'Single',
  MARRIED_FILING_JOINTLY: 'Married filing jointly',
  MARRIED_FILING_SEPARATELY: 'Married filing separately',
  HEAD_OF_HOUSEHOLD: 'Head of household',
  QUALIFYING_SURVIVING_SPOUSE: 'Qualifying surviving spouse',
};

const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const nextWeekday = () => {
  const d = new Date();
  do d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function StatusBadge({ status }: { status: DeskOrder['status'] }) {
  const map = { ACTIVE: ['success', 'Active'], SUSPENDED: ['pending', 'Paused'], COMPLETED: ['default', 'Paid off'], TERMINATED: ['default', 'Ended'] } as const;
  const [variant, label] = map[status];
  return <Badge variant={variant}>{label}</Badge>;
}

export function GarnishmentDesk() {
  // A tab is a place: in the URL, and Back returns to the last one.
  const [tab, setTab] = useUrlParam<Tab>('tab', 'orders', TABS, { history: 'push' });
  const desk = useQuery({ queryKey: ['garnishment-desk'], queryFn: getDesk });
  const [adding, setAdding] = useState(false);
  const qc = useQueryClient();
  const t = desk.data?.totals;

  return (
    <ListTemplate
      title="Garnishments"
      subtitle="Withholding orders, what each still owes and when its next payment is due, and the e-IWO orders agencies send."
      actions={[{ key: 'add', label: 'Add an order', icon: Plus, primary: true, onSelect: () => setAdding(true) }]}
      // The numbers span the tabs (e-IWO to answer, payments waiting), so they sit above them (F500 G3).
      summary={
        t ? (
          <MetricStrip label="Garnishments at a glance">
            <MetricCard label="Active orders" value={String(t.active)} hint="Withholding every paycheck" onClick={() => setTab('orders')} selected={tab === 'orders'} />
            <MetricCard label="e-IWO to answer" value={String(t.eiwoToReview)} hint="Agencies wait for your acknowledgment" tone={t.eiwoToReview ? 'warning' : 'default'} onClick={() => setTab('eiwo')} selected={tab === 'eiwo'} />
            <MetricCard label="Payments waiting" value={fmtMoney(t.remittancesPendingAmount)} hint={`${t.remittancesPending} to send`} onClick={() => setTab('remittances')} selected={tab === 'remittances'} />
            <MetricCard label="Late payments" value={String(t.overdue)} hint="Past 7 business days from payday" tone={t.overdue ? 'alert' : 'default'} onClick={() => setTab('remittances')} />
          </MetricStrip>
        ) : null
      }
    >
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <div className="-mx-1 overflow-x-auto px-1">
          <TabsList>
            <TabsTrigger value="orders">Orders</TabsTrigger>
            <TabsTrigger value="eiwo">{desk.data?.totals.eiwoToReview ? `e-IWO inbox (${desk.data.totals.eiwoToReview})` : 'e-IWO inbox'}</TabsTrigger>
            <TabsTrigger value="remittances">Payments</TabsTrigger>
            <TabsTrigger value="rules">State rules and levies</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="orders">
          <OrdersTab query={desk} onTab={setTab} />
        </TabsContent>
        <TabsContent value="eiwo">
          <EiwoTab rejectReasons={desk.data?.rejectReasons ?? []} />
        </TabsContent>
        <TabsContent value="remittances">
          <RemittancesTab />
        </TabsContent>
        <TabsContent value="rules">
          <RulesTab rules={desk.data?.stateRules ?? null} loading={desk.isLoading} />
        </TabsContent>
      </Tabs>
      <CreateGarnishmentDialog open={adding} onOpenChange={setAdding} onCreated={() => void qc.invalidateQueries({ queryKey: ['garnishment-desk'] })} />
    </ListTemplate>
  );
}

/* ----- Orders ------------------------------------------------------------- */

function OrdersTab({ query }: { query: ReturnType<typeof useQuery<Awaited<ReturnType<typeof getDesk>>>>; onTab?: (t: Tab) => void }) {
  const term = useTerm();
  const [open, setOpen] = useState<DeskOrder | null>(null);
  if (query.isError) return <QueryError what="garnishment orders" query={query} />;
  const columns: GridColumn<DeskOrder>[] = [
    {
      key: 'person',
      header: term('worker'),
      primary: true,
      sortable: true,
      accessor: (o) => o.associateName,
      cell: (o) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-ink">{o.associateName}</p>
          <p className="truncate text-xs text-ink-muted">{`${KIND_LABEL[o.kind]}${o.caseNumber ? ` · case ${o.caseNumber}` : ''}${o.source === 'EIWO' ? ' · e-IWO' : ''}`}</p>
        </div>
      ),
    },
    { key: 'status', header: 'Status', sortable: true, accessor: (o) => o.status, cell: (o) => <StatusBadge status={o.status} />, cardMeta: true },
    { key: 'withheld', header: 'Withheld so far', align: 'right', sortable: true, searchable: false, accessor: (o) => o.amountWithheld, cell: (o) => fmtMoney(o.amountWithheld), className: 'tabular-nums' },
    {
      key: 'remaining',
      header: 'Left to pay',
      align: 'right',
      sortable: true,
      searchable: false,
      accessor: (o) => o.remainingBalance ?? -1,
      csv: (o) => (o.remainingBalance == null ? '' : o.remainingBalance),
      cell: (o) => (o.remainingBalance == null ? <span className="text-ink-muted">Ongoing</span> : fmtMoney(o.remainingBalance)),
      className: 'tabular-nums',
    },
    {
      key: 'next',
      header: 'Next payment',
      sortable: true,
      searchable: false,
      accessor: (o) => o.nextRemittance?.dueBy ?? '',
      cell: (o) =>
        o.nextRemittance ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="tabular-nums text-ink">{fmtMoney(o.nextRemittance.amount)}</span>
            <span className="text-xs text-ink-muted">{`due ${fmtDate(o.nextRemittance.dueBy)}`}</span>
            {o.nextRemittance.overdue && <Badge variant="destructive">Late</Badge>}
          </div>
        ) : (
          <span className="text-ink-muted">None due</span>
        ),
    },
    { key: 'payee', header: 'Paid to', accessor: (o) => o.payee ?? '', cell: (o) => <span className="text-ink-muted">{o.payee ?? 'No payee yet'}</span>, defaultHidden: false },
    { key: 'method', header: 'How', accessor: (o) => METHOD_LABEL[o.remitMethod], sortable: true },
  ];
  return (
    <div className="space-y-4">
      <DataGrid
        id="garnishment-desk-orders"
        caption="Garnishment orders"
        rows={query.data?.orders}
        loading={query.isLoading}
        columns={columns}
        rowKey={(o) => o.id}
        noun={{ one: 'order', many: 'orders' }}
        search={{ placeholder: `${term('worker')}, case or payee…` }}
        onRowClick={(o) => setOpen(o)}
        rowActionLabel={(o) => `Open ${o.associateName}’s ${KIND_LABEL[o.kind].toLowerCase()} order`}
        rowClassName={(o) => (o.nextRemittance?.overdue ? 'bg-alert/5' : undefined)}
        empty={{ icon: Scale, title: 'No garnishment orders', description: 'Orders arrive in the e-IWO inbox, or add one from a paper order.' }}
      />
      {open && <OrderDrawer order={open} levyYears={query.data?.levyYears ?? []} onClose={() => setOpen(null)} />}
    </div>
  );
}

const num = (v: string) => (v.trim() === '' ? null : Number(v));

function OrderDrawer({ order, levyYears, onClose }: { order: DeskOrder; levyYears: number[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    state: order.state ?? '',
    fipsCode: order.fipsCode ?? '',
    orderIdentifier: order.orderIdentifier ?? '',
    remittanceIdentifier: order.remittanceIdentifier ?? '',
    orderFrequency: order.orderFrequency ?? '',
    currentSupport: order.currentSupport?.toString() ?? '',
    pastDueSupport: order.pastDueSupport?.toString() ?? '',
    medicalSupport: order.medicalSupport?.toString() ?? '',
    arrearsOver12Weeks: order.arrearsOver12Weeks,
    supportsSecondFamily: order.supportsSecondFamily,
    adminFee: order.adminFee?.toString() ?? '',
    totalCap: order.totalCap?.toString() ?? '',
    levyFilingStatus: order.levyFilingStatus ?? '',
    levyExemptions: order.levyExemptions?.toString() ?? '',
    levyAdditionalStandard: String(order.levyAdditionalStandard ?? 0),
    levyTaxYear: order.levyTaxYear?.toString() ?? '',
    payeeKind: order.payeeKind ?? '',
    remitMethod: order.remitMethod,
    lumpSumReporting: order.lumpSumReporting,
  });
  const [bankOpen, setBankOpen] = useState(false);
  const [noticeKind, setNoticeKind] = useState<'TERMINATION' | 'LUMP_SUM' | null>(null);
  const dirty = useRef(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => {
    dirty.current = true;
    setF((p) => ({ ...p, [k]: v }));
  };
  const support = order.kind === 'CHILD_SUPPORT';
  const levy = order.kind === 'TAX_LEVY';
  const save = useMutation({
    mutationFn: () =>
      saveOrderDetails(order.id, {
        state: f.state || null,
        fipsCode: f.fipsCode || null,
        orderIdentifier: f.orderIdentifier || null,
        remittanceIdentifier: f.remittanceIdentifier || null,
        orderFrequency: f.orderFrequency || null,
        ...(support ? { currentSupport: num(f.currentSupport), pastDueSupport: num(f.pastDueSupport), medicalSupport: num(f.medicalSupport), arrearsOver12Weeks: f.arrearsOver12Weeks, supportsSecondFamily: f.supportsSecondFamily, lumpSumReporting: f.lumpSumReporting } : {}),
        ...(levy ? { levyFilingStatus: f.levyFilingStatus || null, levyExemptions: num(f.levyExemptions), levyAdditionalStandard: Number(f.levyAdditionalStandard) || 0, levyTaxYear: num(f.levyTaxYear) } : {}),
        adminFee: num(f.adminFee),
        totalCap: num(f.totalCap),
        payeeKind: f.payeeKind || null,
        remitMethod: f.remitMethod,
      }),
    onSuccess: () => {
      toast.success('Order saved. The next payroll uses it.');
      dirty.current = false;
      void qc.invalidateQueries({ queryKey: ['garnishment-desk'] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} width="max-w-xl" confirmDiscard={dirty.current}>
      <DrawerHeader>
        <DrawerTitle>{`${order.associateName} · ${KIND_LABEL[order.kind]}`}</DrawerTitle>
        <DrawerDescription>
          {[order.caseNumber ? `Case ${order.caseNumber}` : null, order.agencyName, order.source === 'EIWO' ? 'Received by e-IWO' : null].filter(Boolean).join(' · ') || 'Entered by hand'}
        </DrawerDescription>
      </DrawerHeader>
      <DrawerBody className="space-y-5">
        <div className="grid grid-cols-2 gap-3">
          <MetricCard label="Withheld so far" value={fmtMoney(order.amountWithheld)} />
          <MetricCard label="Left to pay" value={order.remainingBalance == null ? 'Ongoing' : fmtMoney(order.remainingBalance)} hint={order.remainingBalance == null ? 'No total on the order' : undefined} />
        </div>
        {order.nextRemittance && (
          <p className="text-sm text-ink-muted">{`Next payment: ${fmtMoney(order.nextRemittance.amount)} to ${order.nextRemittance.payee}, due by ${fmtDate(order.nextRemittance.dueBy)}.`}</p>
        )}

        <section className="space-y-3" aria-labelledby="order-ids">
          <h3 id="order-ids" className="text-sm font-medium text-ink">The order</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Issuing state">{(p) => <Input {...p} value={f.state} maxLength={2} onChange={(e) => set('state', e.target.value.toUpperCase())} placeholder="TX" />}</Field>
            <Field label="FIPS code" hint="5 or 7 digits, from the order">{(p) => <Input {...p} value={f.fipsCode} inputMode="numeric" onChange={(e) => set('fipsCode', e.target.value.replace(/\D/g, ''))} />}</Field>
            <Field label="Order number">{(p) => <Input {...p} value={f.orderIdentifier} onChange={(e) => set('orderIdentifier', e.target.value)} />}</Field>
            <Field label="Remittance ID" hint="Goes with every payment">{(p) => <Input {...p} value={f.remittanceIdentifier} onChange={(e) => set('remittanceIdentifier', e.target.value)} />}</Field>
          </div>
        </section>

        {support && (
          <section className="space-y-3" aria-labelledby="order-amounts">
            <h3 id="order-amounts" className="text-sm font-medium text-ink">Amounts the order states</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Stated per">
                {(p) => (
                  <Select {...p} value={f.orderFrequency} onChange={(e) => set('orderFrequency', e.target.value as typeof f.orderFrequency)}>
                    <option value="">Choose…</option>
                    <option value="WEEKLY">Week</option>
                    <option value="BIWEEKLY">Two weeks</option>
                    <option value="SEMIMONTHLY">Half month</option>
                    <option value="MONTHLY">Month</option>
                  </Select>
                )}
              </Field>
              <Field label="Current support">{(p) => <Input {...p} type="number" min="0" step="0.01" value={f.currentSupport} onChange={(e) => set('currentSupport', e.target.value)} />}</Field>
              <Field label="Past-due support">{(p) => <Input {...p} type="number" min="0" step="0.01" value={f.pastDueSupport} onChange={(e) => set('pastDueSupport', e.target.value)} />}</Field>
              <Field label="Cash medical support">{(p) => <Input {...p} type="number" min="0" step="0.01" value={f.medicalSupport} onChange={(e) => set('medicalSupport', e.target.value)} />}</Field>
            </div>
            <label className="flex items-start gap-2 text-sm text-ink">
              <input type="checkbox" className="mt-0.5 h-4 w-4 accent-gold" checked={f.arrearsOver12Weeks} onChange={(e) => set('arrearsOver12Weeks', e.target.checked)} />
              <span>Arrears are more than 12 weeks old <span className="text-ink-muted">(the limit rises 5%)</span></span>
            </label>
            <label className="flex items-start gap-2 text-sm text-ink">
              <input type="checkbox" className="mt-0.5 h-4 w-4 accent-gold" checked={f.supportsSecondFamily} onChange={(e) => set('supportsSecondFamily', e.target.checked)} />
              <span>The employee supports another spouse or child <span className="text-ink-muted">(50% limit instead of 60%)</span></span>
            </label>
            <label className="flex items-start gap-2 text-sm text-ink">
              <input type="checkbox" className="mt-0.5 h-4 w-4 accent-gold" checked={f.lumpSumReporting} onChange={(e) => set('lumpSumReporting', e.target.checked)} />
              <span>The order asks us to report bonuses and other lump sums before paying them</span>
            </label>
          </section>
        )}

        {levy && (
          <section className="space-y-3" aria-labelledby="order-levy">
            <h3 id="order-levy" className="text-sm font-medium text-ink">Levy exempt amount (Form 668-W, Part 3)</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Filing status">
                {(p) => (
                  <Select {...p} value={f.levyFilingStatus} onChange={(e) => set('levyFilingStatus', e.target.value)}>
                    <option value="">Choose…</option>
                    {Object.entries(FILING_LABEL).map(([k, v]) => (
                      <option key={k} value={k}>{v}</option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Dependents claimed">{(p) => <Input {...p} type="number" min="0" value={f.levyExemptions} onChange={(e) => set('levyExemptions', e.target.value)} />}</Field>
              <Field label="65 or older, or blind" hint="How many boxes are checked">{(p) => <Input {...p} type="number" min="0" max="4" value={f.levyAdditionalStandard} onChange={(e) => set('levyAdditionalStandard', e.target.value)} />}</Field>
              <Field label="Tax year of the table" hint={levyYears.length ? `Entered: ${levyYears.join(', ')}` : 'Enter the year’s figures on State rules and levies'}>
                {(p) => <Input {...p} type="number" value={f.levyTaxYear} onChange={(e) => set('levyTaxYear', e.target.value)} placeholder={String(new Date().getFullYear())} />}
              </Field>
            </div>
          </section>
        )}

        <section className="space-y-3" aria-labelledby="order-pay">
          <h3 id="order-pay" className="text-sm font-medium text-ink">Paying it</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Payee type">
              {(p) => (
                <Select {...p} value={f.payeeKind} onChange={(e) => set('payeeKind', e.target.value)}>
                  <option value="">Choose…</option>
                  <option value="SDU">State Disbursement Unit</option>
                  <option value="IRS">IRS</option>
                  <option value="CREDITOR">Creditor or its attorney</option>
                  <option value="COURT">Court</option>
                  <option value="TRUSTEE">Bankruptcy trustee</option>
                  <option value="OTHER">Other</option>
                </Select>
              )}
            </Field>
            <Field label="How we pay">
              {(p) => (
                <Select {...p} value={f.remitMethod} onChange={(e) => set('remitMethod', e.target.value as RemitMethod)}>
                  <option value="CHECK">Check</option>
                  {!levy && <option value="ACH">ACH to the payee’s bank</option>}
                  {support && <option value="EFT_SDU">SDU electronic payment</option>}
                  <option value="PORTAL">On the agency’s site</option>
                </Select>
              )}
            </Field>
            <Field label="Employer fee per payment" hint="Kept by you, where the state allows it">{(p) => <Input {...p} type="number" min="0" step="0.01" value={f.adminFee} onChange={(e) => set('adminFee', e.target.value)} />}</Field>
            <Field label="Total owed" hint="Leave blank when the order has no end amount">{(p) => <Input {...p} type="number" min="0" step="0.01" value={f.totalCap} onChange={(e) => set('totalCap', e.target.value)} />}</Field>
          </div>
          {(f.remitMethod === 'ACH' || f.remitMethod === 'EFT_SDU') && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-navy-secondary p-3">
              <div className="flex items-center gap-2 text-sm">
                <Landmark className="h-4 w-4 text-ink-muted" aria-hidden />
                <span className="text-ink">{order.payeeAccountLast4 ? `Payee account ending ${order.payeeAccountLast4}` : 'No payee bank account yet'}</span>
              </div>
              <Button size="sm" variant="outline" onClick={() => setBankOpen(true)}>
                {order.payeeAccountLast4 ? 'Change account' : 'Add account'}
              </Button>
            </div>
          )}
        </section>

        {support && <NoticesSection orderId={order.id} onNew={setNoticeKind} />}
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>Close</Button>
        <Button onClick={() => save.mutate()} loading={save.isPending}>Save order</Button>
      </DrawerFooter>
      {bankOpen && <PayeeBankDialog order={order} onClose={() => setBankOpen(false)} />}
      {noticeKind && <NoticeDialog order={order} kind={noticeKind} onClose={() => setNoticeKind(null)} />}
    </Drawer>
  );
}

function PayeeBankDialog({ order, onClose }: { order: DeskOrder; onClose: () => void }) {
  const [routing, setRouting] = useState('');
  const [account, setAccount] = useState('');
  const m = useMutation({
    mutationFn: () => requestPayeeBank(order.id, { routingNumber: routing, accountNumber: account }),
    onSuccess: () => {
      toast.success('Sent for a second approval. Payments keep their current route until it’s approved.');
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const valid = /^\d{9}$/.test(routing) && account.trim().length >= 4;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} confirmDiscard={!!(routing || account)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{`Bank account for ${order.payee ?? 'the payee'}`}</DialogTitle>
          <DialogDescription>A second person approves before remittances go to a new account. Take the numbers from the order or the agency’s EFT form, never from an email.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="Routing number" required>{(p) => <Input {...p} inputMode="numeric" autoComplete="off" value={routing} maxLength={9} onChange={(e) => setRouting(e.target.value.replace(/\D/g, ''))} />}</Field>
          <Field label="Account number" required>{(p) => <Input {...p} autoComplete="off" value={account} maxLength={17} onChange={(e) => setAccount(e.target.value.trim())} />}</Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => m.mutate()} loading={m.isPending} disabled={!valid}>Ask for approval</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NoticesSection({ orderId, onNew }: { orderId: string; onNew: (k: 'TERMINATION' | 'LUMP_SUM') => void }) {
  const qc = useQueryClient();
  const prompt = usePrompt();
  const q = useQuery({ queryKey: ['garnishment-desk', 'notices', orderId], queryFn: () => listNotices(orderId) });
  const sent = useMutation({
    mutationFn: ({ id, ref }: { id: string; ref?: string }) => markNoticeSent(id, ref),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['garnishment-desk', 'notices', orderId] }),
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <section className="space-y-3" aria-labelledby="order-notices">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="order-notices" className="text-sm font-medium text-ink">Notices to the agency</h3>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => onNew('LUMP_SUM')}>Lump-sum notice</Button>
          <Button size="sm" variant="outline" onClick={() => onNew('TERMINATION')}>Employment ended</Button>
        </div>
      </div>
      {q.isError ? <QueryError what="notices" query={q} /> : q.isLoading ? <SkeletonRows count={2} /> : (q.data?.notices ?? []).length === 0 ? (
        <p className="text-sm text-ink-muted">None sent. Tell the agency when the employee leaves, and before paying a bonus or other lump sum.</p>
      ) : (
        <ul className="divide-y divide-navy-secondary">
          {q.data!.notices.map((n) => (
            <li key={n.id} className="flex flex-wrap items-center gap-2 py-2">
              <div className="min-w-0 flex-1">
                <p className="text-sm text-ink">{n.kind === 'TERMINATION' ? 'Employment ended' : 'Lump-sum payment'}</p>
                <p className="text-xs text-ink-muted">{n.sentAt ? `Sent ${fmtDate(n.sentAt)}${n.reference ? ` · ${n.reference}` : ''}` : `Made ${fmtDate(n.createdAt)} · not sent yet`}</p>
              </div>
              <Button size="sm" variant="ghost" onClick={() => void downloadNotice(n.id).catch((e: Error) => toast.error(e.message))} aria-label="Download the notice file">
                <Download className="h-4 w-4" aria-hidden />
              </Button>
              {!n.sentAt && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    const ref = await prompt({ title: 'Mark the notice sent', description: 'Where did it go? A portal confirmation number, or how you sent it.', reasonLabel: 'Confirmation (optional)', required: false, confirmLabel: 'Mark sent' });
                    if (ref !== null) sent.mutate({ id: n.id, ref: ref || undefined });
                  }}
                >
                  Mark sent
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function NoticeDialog({ order, kind, onClose }: { order: DeskOrder; kind: 'TERMINATION' | 'LUMP_SUM'; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ terminationDate: localToday(), lastPayDate: '', finalPaymentAmount: '', newEmployerName: '', newEmployerAddress: '', paymentType: 'BONUS', amount: '', expectedPaymentDate: '' });
  const m = useMutation({
    mutationFn: () =>
      createNotice(
        order.id,
        kind === 'TERMINATION'
          ? { kind, terminationDate: f.terminationDate, lastPayDate: f.lastPayDate || null, finalPaymentAmount: num(f.finalPaymentAmount), newEmployerName: f.newEmployerName || null, newEmployerAddress: f.newEmployerAddress || null }
          : { kind, paymentType: f.paymentType, amount: Number(f.amount), expectedPaymentDate: f.expectedPaymentDate },
      ),
    onSuccess: (r) => {
      toast.success(kind === 'TERMINATION' ? 'Notice made and the order ended. Download it and send it to the agency.' : 'Notice made. Download it and send it before the payment.');
      void qc.invalidateQueries({ queryKey: ['garnishment-desk'] });
      void downloadNotice(r.notice.id).catch(() => undefined);
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const valid = kind === 'TERMINATION' ? !!f.terminationDate : Number(f.amount) > 0 && !!f.expectedPaymentDate;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{kind === 'TERMINATION' ? 'Tell the agency employment ended' : 'Tell the agency about a lump sum'}</DialogTitle>
          <DialogDescription>
            {kind === 'TERMINATION'
              ? `This ends ${order.associateName}’s withholding and writes the termination notice the order asks for.`
              : 'Send this before paying, so the agency can claim part of the payment.'}
          </DialogDescription>
        </DialogHeader>
        {kind === 'TERMINATION' ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Last day worked" required>{(p) => <Input {...p} type="date" value={f.terminationDate} onChange={(e) => setF({ ...f, terminationDate: e.target.value })} />}</Field>
            <Field label="Final paycheck date">{(p) => <Input {...p} type="date" value={f.lastPayDate} onChange={(e) => setF({ ...f, lastPayDate: e.target.value })} />}</Field>
            <Field label="Final payment amount">{(p) => <Input {...p} type="number" min="0" step="0.01" value={f.finalPaymentAmount} onChange={(e) => setF({ ...f, finalPaymentAmount: e.target.value })} />}</Field>
            <Field label="New employer, if known">{(p) => <Input {...p} value={f.newEmployerName} onChange={(e) => setF({ ...f, newEmployerName: e.target.value })} />}</Field>
            <Field label="New employer’s address" className="sm:col-span-2">{(p) => <Input {...p} value={f.newEmployerAddress} onChange={(e) => setF({ ...f, newEmployerAddress: e.target.value })} />}</Field>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Kind of payment" required>
              {(p) => (
                <Select {...p} value={f.paymentType} onChange={(e) => setF({ ...f, paymentType: e.target.value })}>
                  <option value="BONUS">Bonus</option>
                  <option value="COMMISSION">Commission</option>
                  <option value="SEVERANCE">Severance</option>
                  <option value="INSURANCE">Insurance settlement</option>
                  <option value="OTHER">Other</option>
                </Select>
              )}
            </Field>
            <Field label="Amount" required>{(p) => <Input {...p} type="number" min="0" step="0.01" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />}</Field>
            <Field label="Expected payment date" required>{(p) => <Input {...p} type="date" value={f.expectedPaymentDate} onChange={(e) => setF({ ...f, expectedPaymentDate: e.target.value })} />}</Field>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => m.mutate()} loading={m.isPending} disabled={!valid}>Make the notice</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ----- e-IWO inbox --------------------------------------------------------- */

function EiwoTab({ rejectReasons }: { rejectReasons: Array<{ code: string; label: string }> }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<'RECEIVED' | ''>('RECEIVED');
  const q = useQuery({ queryKey: ['garnishment-desk', 'eiwo', status], queryFn: () => listEiwo(status || undefined) });
  const [accepting, setAccepting] = useState<EiwoDoc | null>(null);
  const [rejecting, setRejecting] = useState<EiwoDoc | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const upload = useMutation({
    mutationFn: async (file: File) => uploadEiwo(await file.text()),
    onSuccess: (r) => {
      toast.success(`${r.documents.length} ${r.documents.length === 1 ? 'order' : 'orders'} read. Answer each one below.`);
      void qc.invalidateQueries({ queryKey: ['garnishment-desk'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const columns: GridColumn<EiwoDoc>[] = [
    {
      key: 'employee',
      header: 'Employee named',
      primary: true,
      sortable: true,
      accessor: (d) => d.employeeName ?? '',
      cell: (d) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-ink">{d.employeeName ?? 'No name'}</p>
          <p className="truncate text-xs text-ink-muted">{`${d.employeeSsnLast4 ? `SSN ending ${d.employeeSsnLast4}` : 'No SSN'}${d.parsed.match ? ` · ${d.parsed.match}` : ''}`}</p>
        </div>
      ),
    },
    { key: 'action', header: 'Asks to', sortable: true, accessor: (d) => ACTION_LABEL[d.documentActionCode], cell: (d) => <Badge variant={d.documentActionCode === 'TRM' ? 'default' : 'info'}>{ACTION_LABEL[d.documentActionCode]}</Badge>, cardMeta: true },
    { key: 'case', header: 'Case', sortable: true, accessor: (d) => d.caseIdentifier ?? '', cell: (d) => <span className="tabular-nums">{d.caseIdentifier ?? '—'}</span> },
    { key: 'state', header: 'State', sortable: true, accessor: (d) => d.issuingState ?? '' },
    { key: 'received', header: 'Received', sortable: true, searchable: false, accessor: (d) => d.receivedAt, cell: (d) => fmtDate(d.receivedAt) },
    {
      key: 'status',
      header: 'Answer',
      sortable: true,
      accessor: (d) => d.status,
      cell: (d) =>
        d.status === 'RECEIVED' ? (
          (d.parsed.problems ?? []).length ? <Badge variant="pending">Missing details</Badge> : <Badge variant="pending">To answer</Badge>
        ) : d.status === 'ACCEPTED' ? (
          <Badge variant="success">Accepted</Badge>
        ) : (
          <Badge variant="destructive">{`Rejected (${d.rejectReasonCode ?? '—'})`}</Badge>
        ),
    },
    {
      key: 'actions',
      header: '',
      searchable: false,
      stopRowClick: true,
      accessor: () => '',
      cell: (d) =>
        d.status === 'RECEIVED' ? (
          // No one on file has the order's SSN: rejecting it as not our employee is the likely answer, so it's the primary (F500 G3).
          !d.associateId ? (
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setAccepting(d)}>Accept</Button>
              <Button size="sm" onClick={() => setRejecting(d)}>Reject: not our employee</Button>
            </div>
          ) : (
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setRejecting(d)}>Reject</Button>
              <Button size="sm" onClick={() => setAccepting(d)}>Accept</Button>
            </div>
          )
        ) : d.hasAck ? (
          <div className="flex justify-end">
            <Button size="sm" variant="ghost" onClick={() => void downloadAck(d.id).catch((e: Error) => toast.error(e.message))}>
              <Download className="h-4 w-4" aria-hidden />
              Acknowledgment
            </Button>
          </div>
        ) : null,
    },
  ];
  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
          <div className="min-w-0">
            <p className="font-medium text-ink">Add an e-IWO file</p>
            <p className="text-sm text-ink-muted">The XML file from the federal e-IWO portal or your state. Each order in it is matched by SSN to someone on file.</p>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".xml,text/xml,application/xml"
            className="sr-only"
            aria-label="Choose an e-IWO file"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) upload.mutate(file);
              e.target.value = '';
            }}
          />
          <Button onClick={() => fileRef.current?.click()} loading={upload.isPending}>
            <FileUp className="h-4 w-4" aria-hidden />
            Choose file
          </Button>
        </CardContent>
      </Card>
      <div className="flex flex-wrap items-center gap-2">
        <Select size="sm" aria-label="Show" value={status} onChange={(e) => setStatus(e.target.value as 'RECEIVED' | '')} className="w-56">
          <option value="RECEIVED">To answer</option>
          <option value="">All orders received</option>
        </Select>
      </div>
      {q.isError ? (
        <QueryError what="e-IWO orders" query={q} />
      ) : (
        <DataGrid
          id="garnishment-desk-eiwo"
          caption="e-IWO orders"
          rows={q.data?.documents}
          loading={q.isLoading}
          columns={columns}
          rowKey={(d) => d.id}
          noun={{ one: 'order', many: 'orders' }}
          empty={{ icon: Inbox, title: status ? 'Nothing waiting' : 'No e-IWO orders yet', description: 'Orders from agencies show up here when you add their file.' }}
        />
      )}
      {accepting && <AcceptDialog doc={accepting} onClose={() => setAccepting(null)} />}
      {rejecting && <RejectDialog doc={rejecting} reasons={rejectReasons} onClose={() => setRejecting(null)} />}
    </div>
  );
}

function AcceptDialog({ doc, onClose }: { doc: EiwoDoc; onClose: () => void }) {
  const term = useTerm();
  const qc = useQueryClient();
  const [who, setWho] = useState<PickedAssociate | null>(null);
  const [method, setMethod] = useState<RemitMethod | ''>('');
  const problems = doc.parsed.problems ?? [];
  const blocked = problems.length > 0 && (doc.documentActionCode === 'ORG' || doc.documentActionCode === 'AMD');
  const needsPerson = !doc.associateId;
  const m = useMutation({
    mutationFn: () => acceptEiwo(doc.id, { ...(who ? { associateId: who.id } : {}), ...(method ? { remitMethod: method } : {}) }),
    onSuccess: () => {
      toast.success('Accepted. The acknowledgment is ready to send back.');
      void qc.invalidateQueries({ queryKey: ['garnishment-desk'] });
      void downloadAck(doc.id).catch(() => undefined);
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const p = doc.parsed;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{`Accept: ${ACTION_LABEL[doc.documentActionCode].toLowerCase()} for ${doc.employeeName ?? 'this employee'}`}</DialogTitle>
          <DialogDescription>{`Case ${doc.caseIdentifier ?? '—'}${p.issuingAgency ? ` from ${p.issuingAgency}` : ''}.`}</DialogDescription>
        </DialogHeader>
        {blocked ? (
          <div className="rounded-md border border-alert/30 bg-alert/5 p-3 text-sm text-ink">
            <p className="font-medium">This order can’t be set up as sent.</p>
            <ul className="mt-1 list-disc pl-5 text-ink-muted">
              {problems.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
            <p className="mt-2 text-ink-muted">Reject it with “information is missing or wrong” so the agency sends it again.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {(doc.documentActionCode === 'ORG' || doc.documentActionCode === 'AMD') && (
              <dl className="grid grid-cols-2 gap-2 text-sm">
                <dt className="text-ink-muted">Current support</dt>
                <dd className="text-right tabular-nums text-ink">{p.currentSupport != null ? fmtMoney(p.currentSupport) : '—'}</dd>
                <dt className="text-ink-muted">Past due</dt>
                <dd className="text-right tabular-nums text-ink">{p.pastDueSupport != null ? fmtMoney(p.pastDueSupport) : '—'}</dd>
                <dt className="text-ink-muted">Medical support</dt>
                <dd className="text-right tabular-nums text-ink">{p.medicalSupport != null ? fmtMoney(p.medicalSupport) : '—'}</dd>
                <dt className="text-ink-muted">Stated per</dt>
                <dd className="text-right text-ink">{p.orderFrequency ? p.orderFrequency.toLowerCase().replace('semimonthly', 'half month').replace('biweekly', 'two weeks') : '—'}</dd>
              </dl>
            )}
            {needsPerson && (
              <Field label={`Which ${term('worker').toLowerCase()} is this?`} required hint={p.match}>
                {(f) => <AssociatePicker {...f} value={who} onChange={setWho} />}
              </Field>
            )}
            {doc.documentActionCode !== 'TRM' && (
              <Field label="How we pay it" hint="SDU electronic payment needs the SDU’s bank account on the order">
                {(f) => (
                  <Select {...f} value={method} onChange={(e) => setMethod(e.target.value as RemitMethod | '')}>
                    <option value="">Check (change later)</option>
                    <option value="EFT_SDU">SDU electronic payment</option>
                    <option value="PORTAL">On the SDU’s site</option>
                  </Select>
                )}
              </Field>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => m.mutate()} loading={m.isPending} disabled={blocked || (needsPerson && !who)}>
            <CheckCircle2 className="h-4 w-4" aria-hidden />
            Accept
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RejectDialog({ doc, reasons, onClose }: { doc: EiwoDoc; reasons: Array<{ code: string; label: string }>; onClose: () => void }) {
  const qc = useQueryClient();
  const [code, setCode] = useState(doc.associateId ? 'D' : 'N');
  const [text, setText] = useState('');
  const [termDate, setTermDate] = useState('');
  const [newEmployer, setNewEmployer] = useState('');
  const m = useMutation({
    mutationFn: () => rejectEiwo(doc.id, { reasonCode: code, ...(text ? { reasonText: text } : {}), ...(termDate ? { terminationDate: termDate } : {}), ...(newEmployer ? { newEmployerName: newEmployer } : {}) }),
    onSuccess: () => {
      toast.success('Rejected. Send the acknowledgment back to the agency.');
      void qc.invalidateQueries({ queryKey: ['garnishment-desk'] });
      void downloadAck(doc.id).catch(() => undefined);
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{`Reject the order for ${doc.employeeName ?? 'this employee'}`}</DialogTitle>
          <DialogDescription>The agency gets your reason in the acknowledgment.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="Reason" required>
            {(p) => (
              <Select {...p} value={code} onChange={(e) => setCode(e.target.value)}>
                {reasons.map((r) => (
                  <option key={r.code} value={r.code}>{r.label}</option>
                ))}
              </Select>
            )}
          </Field>
          {code === 'T' && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Last day worked">{(p) => <Input {...p} type="date" value={termDate} onChange={(e) => setTermDate(e.target.value)} />}</Field>
              <Field label="New employer, if known">{(p) => <Input {...p} value={newEmployer} onChange={(e) => setNewEmployer(e.target.value)} />}</Field>
            </div>
          )}
          <Field label={code === 'O' ? 'Explain' : 'Note to the agency (optional)'} required={code === 'O'}>
            {(p) => <Textarea {...p} rows={3} maxLength={500} value={text} onChange={(e) => setText(e.target.value)} />}
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" onClick={() => m.mutate()} loading={m.isPending} disabled={code === 'O' && !text.trim()}>Reject</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ----- Payments ------------------------------------------------------------ */

function RemittancesTab() {
  const qc = useQueryClient();
  const prompt = usePrompt();
  const pending = useQuery({ queryKey: ['garnishment-desk', 'remittances', 'PENDING'], queryFn: () => listRemittances('PENDING') });
  const sentQ = useQuery({ queryKey: ['garnishment-desk', 'remittances', 'SENT'], queryFn: () => listRemittances('SENT') });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const mark = useMutation({
    mutationFn: ({ id, ref }: { id: string; ref: string }) => markRemittanceSent(id, ref),
    onSuccess: () => {
      toast.success('Marked paid.');
      void qc.invalidateQueries({ queryKey: ['garnishment-desk'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const total = useMemo(() => (pending.data?.remittances ?? []).filter((r) => selected.has(r.id)).reduce((s, r) => s + r.amount, 0), [pending.data, selected]);
  const columns = (withActions: boolean): GridColumn<PendingRemittance>[] => [
    {
      key: 'payee',
      header: 'Payee',
      primary: true,
      sortable: true,
      accessor: (r) => r.payeeName,
      cell: (r) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-ink">{r.payeeName}</p>
          <p className="truncate text-xs text-ink-muted">{`${r.deductionCount} ${r.deductionCount === 1 ? 'case' : 'cases'} · pay period ${fmtDate(r.period.start)} to ${fmtDate(r.period.end)}`}</p>
        </div>
      ),
    },
    { key: 'amount', header: 'Amount', align: 'right', sortable: true, searchable: false, accessor: (r) => r.amount, cell: (r) => fmtMoney(r.amount), className: 'tabular-nums', cardMeta: true },
    withActions
      ? {
          key: 'actions',
          header: '',
          searchable: false,
          stopRowClick: true,
          accessor: () => '',
          cell: (r) => (
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => void downloadAdvicePdf(r.id).catch((e: Error) => toast.error(e.message))}>Advice</Button>
              <Button
                size="sm"
                variant="outline"
                onClick={async () => {
                  const ref = await prompt({ title: `Paid ${r.payeeName} another way?`, description: 'Record the check number or the agency site’s confirmation.', reasonLabel: 'Check number or confirmation', required: true, confirmLabel: 'Mark paid' });
                  if (ref) mark.mutate({ id: r.id, ref });
                }}
              >
                Paid by check
              </Button>
            </div>
          ),
        }
      : { key: 'sent', header: 'Sent', sortable: true, searchable: false, accessor: (r) => r.sentAt ?? '', cell: (r) => <span className="text-ink-muted">{`${r.sentAt ? fmtDate(r.sentAt) : '—'}${r.reference ? ` · ${r.reference}` : ''}`}</span> },
  ];
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Waiting to be paid</CardTitle>
          <CardDescription>Withheld money is due to the payee within 7 business days of payday. Choose payments to send electronically, or record a check.</CardDescription>
        </CardHeader>
        <CardContent>
          {pending.isError ? (
            <QueryError what="payments" query={pending} />
          ) : (
            <DataGrid
              id="garnishment-desk-pending"
              caption="Garnishment payments waiting"
              rows={pending.data?.remittances}
              loading={pending.isLoading}
              columns={columns(true)}
              rowKey={(r) => r.id}
              noun={{ one: 'payment', many: 'payments' }}
              search={false}
              selectable={{
                selectAllLabel: 'Select every payment',
                selection: { selected, onChange: setSelected },
                actions: (ids) => (
                  <Button size="sm" onClick={() => setSending(true)} disabled={!ids.length}>
                    <Send className="h-4 w-4" aria-hidden />
                    {`Send ${fmtMoney(total)} electronically`}
                  </Button>
                ),
              }}
              empty={{ icon: CheckCircle2, title: 'Every payment is sent', description: 'Payments appear here after each payroll that withholds a garnishment.' }}
            />
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Sent</CardTitle>
        </CardHeader>
        <CardContent>
          {sentQ.isError ? (
            <QueryError what="sent payments" query={sentQ} />
          ) : (
            <DataGrid id="garnishment-desk-sent" caption="Garnishment payments sent" rows={sentQ.data?.remittances} loading={sentQ.isLoading} columns={columns(false)} rowKey={(r) => r.id} noun={{ one: 'payment', many: 'payments' }} empty={{ title: 'Nothing sent yet' }} />
          )}
        </CardContent>
      </Card>
      {sending && <SendDialog ids={[...selected]} total={total} onClose={() => setSending(false)} onDone={() => setSelected(new Set())} />}
    </div>
  );
}

function SendDialog({ ids, total, onClose, onDone }: { ids: string[]; total: number; onClose: () => void; onDone: () => void }) {
  const qc = useQueryClient();
  const [date, setDate] = useState(nextWeekday());
  const m = useMutation({
    mutationFn: () => sendRemittances(ids, date),
    onSuccess: (r) => {
      toast.success(r.fileStatus === 'SUBMITTED' ? 'Sent to your bank.' : 'ACH file made. Download it from Payroll banking for your bank.');
      void qc.invalidateQueries({ queryKey: ['garnishment-desk'] });
      onDone();
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{`Send ${fmtMoney(total)} electronically`}</DialogTitle>
          <DialogDescription>Child support goes to each State Disbursement Unit with the case details it needs to post the payment. Other payees get a payment with the case number.</DialogDescription>
        </DialogHeader>
        <Field label="Settles on" hint="A business day">{(p) => <Input {...p} type="date" min={localToday()} value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => m.mutate()} loading={m.isPending} disabled={!date}>Send</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ----- State rules and levy tables --------------------------------------- */

function RulesTab({ rules, loading }: { rules: StateRule[] | null; loading: boolean }) {
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<StateRule | 'new' | null>(null);
  const [levyEditing, setLevyEditing] = useState<LevyParameter | 'new' | null>(null);
  const levy = useQuery({ queryKey: ['garnishment-desk', 'levy'], queryFn: listLevyParameters });
  const delRule = useMutation({
    mutationFn: deleteStateRule,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['garnishment-desk'] }),
    onError: (e: Error) => toast.error(e.message),
  });
  const delLevy = useMutation({
    mutationFn: deleteLevyParameter,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['garnishment-desk', 'levy'] }),
    onError: (e: Error) => toast.error(e.message),
  });
  const pct = (v: number | null) => (v == null ? 'Federal' : `${Math.round(v * 1000) / 10}%`);
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>State rules</CardTitle>
            <CardDescription>How a state splits pay between several support orders, any lower limits than federal law, and the fee you may keep. States without a rule use pro rata and the federal limits.</CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={() => setEditing('new')}>
            <Plus className="h-4 w-4" aria-hidden />
            Add a state
          </Button>
        </CardHeader>
        <CardContent>
          {loading ? (
            <SkeletonRows count={3} />
          ) : !rules?.length ? (
            <EmptyState size="sm" icon={Scale} title="No state rules yet" description="Add the states your orders come from. Check each with the state’s child support agency." />
          ) : (
            <ul className="divide-y divide-navy-secondary">
              {rules.map((r) => (
                <li key={r.state} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5">
                  <span className="w-10 font-medium text-ink">{r.state}</span>
                  <div className="min-w-0 flex-1 text-sm text-ink-muted">
                    {[r.allocationMethod === 'PRO_RATA' ? 'Pro rata' : 'First in time', `support ${pct(r.supportMaxPercent)}`, `creditor ${pct(r.creditorMaxPercent)}`, r.adminFeeMax != null ? `fee up to ${fmtMoney(r.adminFeeMax)} ${r.adminFeeFrequency === 'MONTHLY' ? 'a month' : r.adminFeeFrequency === 'ONE_TIME' ? 'once' : 'a payment'}` : 'no fee'].join(' · ')}
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>Edit</Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      if (await confirm({ title: `Remove the ${r.state} rule?`, description: 'Orders from this state go back to pro rata and the federal limits.', confirmLabel: 'Remove', destructive: true })) delRule.mutate(r.state);
                    }}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>IRS levy exempt amounts</CardTitle>
            <CardDescription>The figures behind IRS Publication 1494 for each year: the standard deduction by filing status, the extra amount for 65 or older or blind, and the amount per dependent. Enter them each January from the publication.</CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={() => setLevyEditing('new')}>
            <Plus className="h-4 w-4" aria-hidden />
            Add figures
          </Button>
        </CardHeader>
        <CardContent>
          {levy.isError ? (
            <QueryError what="levy figures" query={levy} />
          ) : levy.isLoading ? (
            <SkeletonRows count={3} />
          ) : !levy.data?.parameters.length ? (
            <EmptyState size="sm" icon={Landmark} title="No levy figures yet" description="Without them, an IRS levy withholds only an amount you enter on the order." />
          ) : (
            <ul className="divide-y divide-navy-secondary">
              {levy.data.parameters.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5">
                  <span className="w-12 tabular-nums font-medium text-ink">{p.taxYear}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-ink">{FILING_LABEL[p.filingStatus] ?? p.filingStatus}</p>
                    <p className="text-xs text-ink-muted">{`Standard ${fmtMoney(p.standardDeduction)} · extra ${fmtMoney(p.additionalStandardDeduction)} · per dependent ${fmtMoney(p.exemptionAmount)}${p.source ? ` · ${p.source}` : ''}`}</p>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => setLevyEditing(p)}>Edit</Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      if (await confirm({ title: 'Remove these figures?', description: `Levies for ${p.taxYear} (${FILING_LABEL[p.filingStatus] ?? p.filingStatus}) stop computing an exempt amount.`, confirmLabel: 'Remove', destructive: true })) delLevy.mutate(p.id);
                    }}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      {editing && <StateRuleDialog rule={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {levyEditing && <LevyDialog param={levyEditing === 'new' ? null : levyEditing} onClose={() => setLevyEditing(null)} />}
    </div>
  );
}

function StateRuleDialog({ rule, onClose }: { rule: StateRule | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    state: rule?.state ?? '',
    allocationMethod: rule?.allocationMethod ?? 'PRO_RATA',
    supportMaxPercent: rule?.supportMaxPercent != null ? String(rule.supportMaxPercent * 100) : '',
    creditorMaxPercent: rule?.creditorMaxPercent != null ? String(rule.creditorMaxPercent * 100) : '',
    adminFeeMax: rule?.adminFeeMax?.toString() ?? '',
    adminFeeFrequency: rule?.adminFeeFrequency ?? 'PER_PAYMENT',
    notes: rule?.notes ?? '',
  });
  const m = useMutation({
    mutationFn: () =>
      saveStateRule(f.state, {
        allocationMethod: f.allocationMethod as StateRule['allocationMethod'],
        supportMaxPercent: f.supportMaxPercent ? Number(f.supportMaxPercent) / 100 : null,
        creditorMaxPercent: f.creditorMaxPercent ? Number(f.creditorMaxPercent) / 100 : null,
        adminFeeMax: f.adminFeeMax ? Number(f.adminFeeMax) : null,
        adminFeeFrequency: f.adminFeeMax ? (f.adminFeeFrequency as StateRule['adminFeeFrequency']) : null,
        notes: f.notes || null,
      }),
    onSuccess: () => {
      toast.success(`${f.state} rule saved.`);
      void qc.invalidateQueries({ queryKey: ['garnishment-desk'] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{rule ? `${rule.state} rule` : 'Add a state rule'}</DialogTitle>
          <DialogDescription>Leave a limit blank to use the federal one.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="State" required>{(p) => <Input {...p} value={f.state} maxLength={2} disabled={!!rule} onChange={(e) => setF({ ...f, state: e.target.value.toUpperCase().replace(/[^A-Z]/g, '') })} placeholder="NY" />}</Field>
          <Field label="Several support orders" required>
            {(p) => (
              <Select {...p} value={f.allocationMethod} onChange={(e) => setF({ ...f, allocationMethod: e.target.value as StateRule['allocationMethod'] })}>
                <option value="PRO_RATA">Split pro rata</option>
                <option value="FIRST_IN_TIME">Oldest order first</option>
              </Select>
            )}
          </Field>
          <Field label="Support limit, %" hint="Federal: 50–65%">{(p) => <Input {...p} type="number" min="0" max="65" step="0.1" value={f.supportMaxPercent} onChange={(e) => setF({ ...f, supportMaxPercent: e.target.value })} />}</Field>
          <Field label="Creditor limit, %" hint="Federal: 25%">{(p) => <Input {...p} type="number" min="0" max="25" step="0.1" value={f.creditorMaxPercent} onChange={(e) => setF({ ...f, creditorMaxPercent: e.target.value })} />}</Field>
          <Field label="Employer fee you may keep">{(p) => <Input {...p} type="number" min="0" step="0.01" value={f.adminFeeMax} onChange={(e) => setF({ ...f, adminFeeMax: e.target.value })} />}</Field>
          <Field label="Fee is charged">
            {(p) => (
              <Select {...p} value={f.adminFeeFrequency} onChange={(e) => setF({ ...f, adminFeeFrequency: e.target.value as NonNullable<StateRule['adminFeeFrequency']> })} disabled={!f.adminFeeMax}>
                <option value="PER_PAYMENT">Each payment</option>
                <option value="MONTHLY">Once a month</option>
                <option value="ONE_TIME">Once per order</option>
              </Select>
            )}
          </Field>
          <Field label="Source or note" className="sm:col-span-2">{(p) => <Input {...p} value={f.notes} maxLength={500} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="Where this rule comes from" />}</Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => m.mutate()} loading={m.isPending} disabled={f.state.length !== 2}>Save rule</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LevyDialog({ param, onClose }: { param: LevyParameter | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    taxYear: String(param?.taxYear ?? new Date().getFullYear()),
    filingStatus: param?.filingStatus ?? 'SINGLE',
    standardDeduction: param?.standardDeduction.toString() ?? '',
    additionalStandardDeduction: param?.additionalStandardDeduction.toString() ?? '',
    exemptionAmount: param?.exemptionAmount.toString() ?? '',
    source: param?.source ?? '',
  });
  const m = useMutation({
    mutationFn: () =>
      saveLevyParameter({
        taxYear: Number(f.taxYear),
        filingStatus: f.filingStatus,
        standardDeduction: Number(f.standardDeduction),
        additionalStandardDeduction: Number(f.additionalStandardDeduction || 0),
        exemptionAmount: Number(f.exemptionAmount || 0),
        source: f.source || null,
      }),
    onSuccess: () => {
      toast.success('Levy figures saved.');
      void qc.invalidateQueries({ queryKey: ['garnishment-desk'] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{param ? 'Edit levy figures' : 'Add levy figures'}</DialogTitle>
          <DialogDescription>Copy them from IRS Publication 1494 for the year.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Tax year" required>{(p) => <Input {...p} type="number" value={f.taxYear} disabled={!!param} onChange={(e) => setF({ ...f, taxYear: e.target.value })} />}</Field>
          <Field label="Filing status" required>
            {(p) => (
              <Select {...p} value={f.filingStatus} disabled={!!param} onChange={(e) => setF({ ...f, filingStatus: e.target.value })}>
                {Object.entries(FILING_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Standard deduction" required>{(p) => <Input {...p} type="number" min="0" step="0.01" value={f.standardDeduction} onChange={(e) => setF({ ...f, standardDeduction: e.target.value })} />}</Field>
          <Field label="Extra for 65 or older or blind">{(p) => <Input {...p} type="number" min="0" step="0.01" value={f.additionalStandardDeduction} onChange={(e) => setF({ ...f, additionalStandardDeduction: e.target.value })} />}</Field>
          <Field label="Amount per dependent">{(p) => <Input {...p} type="number" min="0" step="0.01" value={f.exemptionAmount} onChange={(e) => setF({ ...f, exemptionAmount: e.target.value })} />}</Field>
          <Field label="Source">{(p) => <Input {...p} value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} placeholder="Publication 1494 (2027)" />}</Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => m.mutate()} loading={m.isPending} disabled={!(Number(f.standardDeduction) > 0) || !f.taxYear}>Save figures</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
