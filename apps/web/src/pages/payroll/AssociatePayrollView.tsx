// Wave 1.4 — Associate-facing paystub redesigned to QuickBooks Online
// Payroll layout: per-kind earning lines, separate Deductions section,
// and a Current + YTD column on every numeric row. The full breakdown
// expands inline so an associate can read their tax math without leaving
// the page. Associates can also download their own paystub as a PDF —
// the backend authorizes the item owner on GET /payroll/items/:id/paystub.pdf.

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import type { PayrollItem, PayrollItemEarning } from '@alto-people/shared';
import {
  downloadMyPaystub,
  getMyPayoutMethod,
  getMyW4,
  getMyPayrollItemYtd,
  listMyPayrollItems,
  updateMyPayoutMethod,
  updateMyW4,
  type MyPayoutMethod,
  type MyW4,
} from '@/lib/payrollApi';
import { fileCase } from '@/lib/hrCases123Api';
import { ApiError } from '@/lib/api';
import { fmtDate, fmtMoney, parseYmd } from '@/lib/format';
import { statusTone } from '@/lib/status';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { cn } from '@/lib/cn';
import { dayHeading, groupByDayBy } from '@/lib/dayGroup';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Input, Textarea } from '@/components/ui/Input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { Badge } from '@/components/ui/Badge';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Skeleton, SkeletonRows } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import {
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
  HelpCircle,
  Settings,
  Wallet,
} from 'lucide-react';

const KIND_KEY: Record<PayrollItemEarning['kind'], MessageKey> = {
  REGULAR: 'pay.kind.REGULAR',
  OVERTIME: 'pay.kind.OVERTIME',
  DOUBLE_TIME: 'pay.kind.DOUBLE_TIME',
  HOLIDAY: 'pay.kind.HOLIDAY',
  SICK: 'pay.kind.SICK',
  VACATION: 'pay.kind.VACATION',
  BONUS: 'pay.kind.BONUS',
  COMMISSION: 'pay.kind.COMMISSION',
  TIPS: 'pay.kind.TIPS',
  REIMBURSEMENT: 'pay.kind.REIMBURSEMENT',
};

// Labels stay i18n keys (this page is translated); tones come from the
// shared status vocabulary (PENDING amber, HELD amber, VOIDED muted).
const STATUS_KEY: Record<PayrollItem['status'], MessageKey> = {
  PENDING: 'pay.status.PENDING',
  DISBURSED: 'pay.status.DISBURSED',
  FAILED: 'pay.status.FAILED',
  HELD: 'pay.status.HELD',
  VOIDED: 'pay.status.VOIDED',
};

/**
 * 403/404 are fully expected for accounts without payroll records and
 * render as a genuine empty state (null data); anything else rethrows so
 * the query errors. Mirrors the dashboard's emptyOnExpectedDenial — the
 * ['me','payrollItems'] key is SHARED with the dashboard's paystub card,
 * so both queryFns must produce the same cached shape.
 */
async function emptyOnExpectedDenial<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
      return null;
    }
    throw err;
  }
}

export function AssociatePayrollView() {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // FAILED/HELD paystub the associate is asking HR about (files an HR case).
  const [askItem, setAskItem] = useState<PayrollItem | null>(null);

  const payQuery = useQuery({
    queryKey: ['me', 'payrollItems'],
    queryFn: () => emptyOnExpectedDenial(listMyPayrollItems()),
  });

  // undefined → still loading (skeleton); null (expected denial) → empty state.
  const items: PayrollItem[] | null =
    payQuery.data === undefined ? null : (payQuery.data?.items ?? []);
  const error = payQuery.error
    ? payQuery.error instanceof ApiError
      ? payQuery.error.message
      : t('pay.loadFailed')
    : null;

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="mx-auto">
      <PageHeader
        title={t('pay.title')}
        subtitle={t('pay.subtitle')}
      />

      <TaxAndPaySettings />

      {error && (
        <ErrorBanner
          className="mb-4"
          action={
            <Button size="sm" variant="secondary" onClick={() => void payQuery.refetch()}>
              {t('common.retry')}
            </Button>
          }
        >
          {error}
        </ErrorBanner>
      )}
      {!items && !error && <SkeletonRows count={3} rowHeight="h-32" />}
      {items && items.length === 0 && (
        <EmptyState
          icon={Wallet}
          title={t('pay.noPaystubs')}
          description={t('pay.noPaystubsDesc')}
        />
      )}

      {items && items.length > 0 && (() => {
        // Pending paystubs (not yet disbursed) bubble to the top in a
        // dedicated bucket so they don't get hidden under a collapsed
        // older-day section.
        const pending = items.filter((i) => !i.disbursedAt);
        const disbursed = items.filter((i) => !!i.disbursedAt);
        const groups = groupByDayBy(disbursed, (i) => i.disbursedAt!);
        return (
          <div className="space-y-3">
            {pending.length > 0 && (
              <PaystubGroup
                heading={t('pay.pendingCount', { count: pending.length })}
                items={pending}
                expanded={expanded}
                onToggle={toggle}
                onAsk={setAskItem}
                defaultOpen
              />
            )}
            {groups.map((g, idx) => (
              <PaystubGroup
                key={g.key}
                heading={
                  /^(Today|Yesterday)$/.test(dayHeading(g.key))
                    ? `${dayHeading(g.key)} · ${fmtDate(parseYmd(g.key))}`
                    : dayHeading(g.key)
                }
                items={g.entries}
                expanded={expanded}
                onToggle={toggle}
                onAsk={setAskItem}
                defaultOpen={pending.length === 0 && idx === 0}
              />
            ))}
          </div>
        );
      })()}

      <AskPaycheckDialog item={askItem} onClose={() => setAskItem(null)} />
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 *  Tax & pay settings — associate self-service for W-4 elections and the
 *  direct-deposit account. Both were HR-ticket-only before; the endpoints
 *  (/me/w4, /me/payout-method) now let the associate manage them.
 * -------------------------------------------------------------------------- */

const FILING_STATUS_KEY: Record<MyW4['filingStatus'], MessageKey> = {
  SINGLE: 'pay.filing.SINGLE',
  MARRIED_FILING_JOINTLY: 'pay.filing.MARRIED_FILING_JOINTLY',
  HEAD_OF_HOUSEHOLD: 'pay.filing.HEAD_OF_HOUSEHOLD',
};

function TaxAndPaySettings() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-4 rounded-lg border border-navy-secondary bg-navy-secondary/20">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <span className="flex items-center gap-2 text-sm font-medium text-white">
          <Settings className="h-4 w-4 text-gold" />
          {t('pay.taxSettingsTitle')}
        </span>
        {open ? (
          <ChevronDown className="h-4 w-4 text-silver" />
        ) : (
          <ChevronRight className="h-4 w-4 text-silver" />
        )}
      </button>
      {open && (
        <div className="space-y-4 border-t border-navy-secondary p-4">
          <div className="grid gap-4 md:grid-cols-2">
            <W4Card />
            <PayoutMethodCard />
          </div>
          <Link
            to="/me?tab=tax-docs"
            className="flex items-center gap-2 rounded-md border border-navy-secondary bg-navy px-3 py-2.5 text-xs text-silver hover:text-gold coarse:min-h-11"
          >
            <FileText className="h-4 w-4 shrink-0 text-gold" />
            <span className="font-medium text-white">{t('pay.taxDocs')}</span>
            <span className="ml-auto text-silver/70">{t('pay.taxDocsHint')}</span>
          </Link>
        </div>
      )}
    </div>
  );
}

/** Blank election set used to seed the form when no W-4 exists yet —
 *  POST /me/w4 handles the create. */
const EMPTY_W4: MyW4 = {
  filingStatus: 'SINGLE',
  multipleJobs: false,
  dependentsAmount: 0,
  otherIncome: 0,
  deductions: 0,
  extraWithholding: 0,
  signedAt: null,
  updatedAt: '',
};

function W4Card() {
  const { t } = useI18n();
  const [w4, setW4] = useState<MyW4 | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<MyW4 | null>(null);
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState(false);

  const load = () =>
    getMyW4()
      .then((r) => {
        setW4(r);
        setMissing(false);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.code === 'no_w4') setMissing(true);
      });
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    if (!form) return;
    setBusy(true);
    try {
      await updateMyW4({
        filingStatus: form.filingStatus,
        multipleJobs: form.multipleJobs,
        dependentsAmount: form.dependentsAmount,
        otherIncome: form.otherIncome,
        deductions: form.deductions,
        extraWithholding: form.extraWithholding,
      });
      toast.success(t('pay.w4UpdatedToast'));
      setEditing(false);
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('pay.w4UpdateFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-md border border-navy-secondary bg-navy p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-medium text-white">{t('pay.w4Title')}</h3>
        {w4 && !editing && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setForm(w4);
              setEditing(true);
            }}
          >
            {t('pay.edit')}
          </Button>
        )}
      </div>
      {missing && !editing && (
        <div className="space-y-2">
          <p className="text-xs text-silver">{t('pay.w4None')}</p>
          <Button
            size="sm"
            onClick={() => {
              setForm(EMPTY_W4);
              setEditing(true);
            }}
          >
            {t('pay.w4SetUp')}
          </Button>
        </div>
      )}
      {w4 && !editing && (
        <dl className="space-y-1 text-xs">
          <Row label={t('pay.w4FilingStatus')} value={t(FILING_STATUS_KEY[w4.filingStatus])} />
          <Row label={t('pay.w4Dependents')} value={fmtMoney(w4.dependentsAmount)} />
          <Row label={t('pay.w4OtherIncome')} value={fmtMoney(w4.otherIncome)} />
          <Row label={t('pay.w4Deductions')} value={fmtMoney(w4.deductions)} />
          <Row label={t('pay.w4ExtraPerCheck')} value={fmtMoney(w4.extraWithholding)} />
        </dl>
      )}
      {editing && form && (
        <div className="space-y-2">
          <Select
            value={form.filingStatus}
            onChange={(e) =>
              setForm({ ...form, filingStatus: e.target.value as MyW4['filingStatus'] })
            }
          >
            {(Object.keys(FILING_STATUS_KEY) as MyW4['filingStatus'][]).map((v) => (
              <option key={v} value={v}>
                {t(FILING_STATUS_KEY[v])}
              </option>
            ))}
          </Select>
          <NumField
            label={t('pay.w4DependentsField')}
            value={form.dependentsAmount}
            onChange={(n) => setForm({ ...form, dependentsAmount: n })}
          />
          <NumField
            label={t('pay.w4OtherIncomeField')}
            value={form.otherIncome}
            onChange={(n) => setForm({ ...form, otherIncome: n })}
          />
          <NumField
            label={t('pay.w4DeductionsField')}
            value={form.deductions}
            onChange={(n) => setForm({ ...form, deductions: n })}
          />
          <NumField
            label={t('pay.w4ExtraField')}
            value={form.extraWithholding}
            onChange={(n) => setForm({ ...form, extraWithholding: n })}
          />
          <label className="flex items-center gap-2 text-xs text-silver">
            <input
              type="checkbox"
              checked={form.multipleJobs}
              onChange={(e) => setForm({ ...form, multipleJobs: e.target.checked })}
            />
            {t('pay.w4MultipleJobs')}
          </label>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" onClick={save} loading={busy} disabled={busy}>
              {t('pay.save')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// NOTE: the payout-method API (GET/POST /me/payout-method) has no removal
// path — an account can be replaced but not cleared — so there is no
// "switch to paper check" affordance here until the server grows one.
function PayoutMethodCard() {
  const { t } = useI18n();
  const [method, setMethod] = useState<MyPayoutMethod | null | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const [routing, setRouting] = useState('');
  const [account, setAccount] = useState('');
  const [confirmAccount, setConfirmAccount] = useState('');
  const [type, setType] = useState<'CHECKING' | 'SAVINGS'>('CHECKING');
  const [busy, setBusy] = useState(false);

  const load = () =>
    getMyPayoutMethod()
      .then((r) => setMethod(r.method))
      .catch(() => setMethod(null));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const mismatch = confirmAccount.length > 0 && confirmAccount !== account;
  const accountsMatch = account.length > 0 && confirmAccount === account;

  const closeForm = () => {
    setEditing(false);
    setRouting('');
    setAccount('');
    setConfirmAccount('');
  };

  const save = async () => {
    if (!/^\d{9}$/.test(routing) || !/^\d{4,17}$/.test(account)) {
      toast.error(t('pay.ddValidation'));
      return;
    }
    if (!accountsMatch) return;
    setBusy(true);
    try {
      const r = await updateMyPayoutMethod({ routingNumber: routing, accountNumber: account, accountType: type });
      toast.success(t('pay.ddUpdatedToast', { last4: r.accountLast4 }));
      closeForm();
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('pay.ddUpdateFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-md border border-navy-secondary bg-navy p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-medium text-white">{t('pay.ddTitle')}</h3>
        {method !== undefined && !editing && (
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            {method ? t('pay.ddChange') : t('pay.ddAdd')}
          </Button>
        )}
      </div>
      {!editing && (
        <div className="text-xs text-silver">
          {method === undefined && <Skeleton className="h-4 w-40" />}
          {method === null && t('pay.ddNone')}
          {method && method.branchCard && t('pay.ddBranchCard')}
          {method && !method.branchCard && (
            <span>
              {t('pay.ddAccountLine', { type: method.accountType ?? t('pay.ddBank') })}{' '}
              <span className="text-white">••••{method.accountLast4 ?? ''}</span>
              {' · '}
              {method.verifiedAt ? t('pay.ddVerified') : t('pay.ddPendingVerify')}
            </span>
          )}
        </div>
      )}
      {editing && (
        <div className="space-y-2">
          {/* ui/Input, not raw <input>: this is the single most-filled
              associate form on a phone, and the raw 14px fields made iOS
              zoom the viewport on every focus. */}
          <Input
            placeholder={t('pay.ddRoutingPh')}
            type="tel"
            inputMode="numeric"
            autoComplete="off"
            value={routing}
            onChange={(e) => setRouting(e.target.value.replace(/\D/g, '').slice(0, 9))}
          />
          <Input
            placeholder={t('pay.ddAccountPh')}
            type="tel"
            inputMode="numeric"
            autoComplete="off"
            value={account}
            onChange={(e) => setAccount(e.target.value.replace(/\D/g, '').slice(0, 17))}
          />
          <Input
            placeholder={t('pay.ddConfirmPh')}
            type="tel"
            inputMode="numeric"
            autoComplete="off"
            invalid={mismatch}
            value={confirmAccount}
            onChange={(e) => setConfirmAccount(e.target.value.replace(/\D/g, '').slice(0, 17))}
          />
          {mismatch && (
            <p role="alert" className="text-xs text-alert">
              {t('pay.ddMismatch')}
            </p>
          )}
          <Select value={type} onChange={(e) => setType(e.target.value as 'CHECKING' | 'SAVINGS')}>
            <option value="CHECKING">{t('pay.ddChecking')}</option>
            <option value="SAVINGS">{t('pay.ddSavings')}</option>
          </Select>
          <p className="text-xs text-silver/70">{t('pay.ddEmailNote')}</p>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={closeForm} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" onClick={save} loading={busy} disabled={busy || !accountsMatch}>
              {t('pay.save')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-silver">{label}</dt>
      <dd className="tabular-nums text-white">{value}</dd>
    </div>
  );
}

function NumField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <label className="block text-xs text-silver">
      {label}
      <Input
        type="number"
        min="0"
        step="0.01"
        inputMode="decimal"
        className="mt-1"
        value={value}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
      />
    </label>
  );
}

function PaystubGroup({
  heading,
  items,
  expanded,
  onToggle,
  onAsk,
  defaultOpen,
}: {
  heading: string;
  items: PayrollItem[];
  expanded: Set<string>;
  onToggle: (id: string) => void;
  onAsk: (item: PayrollItem) => void;
  defaultOpen?: boolean;
}) {
  const { t } = useI18n();
  return (
    <details
      open={defaultOpen}
      className="rounded-lg border border-navy-secondary bg-navy/40 [&[open]>summary>svg.chev]:rotate-90"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs hover:bg-navy-secondary/40">
        <ChevronRight className="chev h-4 w-4 text-silver/70 transition-transform" />
        <span className="font-medium text-white">{heading}</span>
        <span className="ml-auto text-silver/70">
          {items.length === 1
            ? t('pay.paystubWord', { count: items.length })
            : t('pay.paystubWordPlural', { count: items.length })}
        </span>
      </summary>
      <ul className="space-y-3 p-3 pt-0">
        {items.map((it) => (
          <PaystubCard
            key={it.id}
            item={it}
            expanded={expanded.has(it.id)}
            onToggle={() => onToggle(it.id)}
            onAsk={() => onAsk(it)}
          />
        ))}
      </ul>
    </details>
  );
}

function PaystubCard({
  item,
  expanded,
  onToggle,
  onAsk,
}: {
  item: PayrollItem;
  expanded: boolean;
  onToggle: () => void;
  onAsk: () => void;
}) {
  const { t } = useI18n();
  // YTD comes from the server, not from summing the loaded stubs: the list
  // endpoint returns at most 50, so a client-side sum silently understates
  // the tax and net columns for anyone paid weekly for a year or more.
  // Fetched only once the card is open — it's the only place YTD is shown.
  const ytdQuery = useQuery({
    queryKey: ['me', 'paystubYtd', item.id],
    queryFn: () => getMyPayrollItemYtd(item.id),
    enabled: expanded,
    staleTime: 5 * 60_000,
  });
  const ytd = ytdQuery.data ?? null;
  const [downloading, setDownloading] = useState(false);

  const onDownload = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      await downloadMyPaystub(item.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('pay.downloadFailed'));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <li className="bg-navy border border-navy-secondary rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full p-4 text-left hover:bg-navy-secondary/30 transition-colors"
      >
        <div className="flex items-center gap-3 mb-2">
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-silver/70 shrink-0" />
          ) : (
            <ChevronRight className="h-4 w-4 text-silver/70 shrink-0" />
          )}
          <div className="flex-1 text-sm text-silver">
            {t('pay.hrsAtRate', {
              hours: item.hoursWorked.toFixed(2),
              rate: fmtMoney(item.hourlyRate),
            })}
          </div>
          <Badge className="shrink-0" variant={statusTone(item.status)}>
            {t(STATUS_KEY[item.status])}
          </Badge>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm pl-7">
          <div>
            <div className="text-xs uppercase tracking-widest text-silver/70">{t('pay.gross')}</div>
            <div className="text-white tabular-nums">{fmtMoney(item.grossPay)}</div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-widest text-silver/70">
              {item.postTaxDeductions > 0 ? t('pay.taxPlusPostTax') : t('pay.taxes')}
            </div>
            <div className="text-white tabular-nums">
              −{fmtMoney(item.federalWithholding + item.fica + item.medicare + item.stateWithholding + item.postTaxDeductions)}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-widest text-gold">{t('pay.net')}</div>
            <div className="text-xl text-gold tabular-nums">
              {fmtMoney(item.netPay)}
            </div>
          </div>
        </div>
      </button>

      {expanded && !ytd && (
        <div className="border-t border-navy-secondary p-4">
          {ytdQuery.isError ? (
            // Every row in the breakdown carries a YTD column, so a partial
            // render would put blanks beside real money. Say it failed.
            <ErrorBanner
              action={
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void ytdQuery.refetch()}
                >
                  {t('common.retry')}
                </Button>
              }
            >
              {t('pay.ytdLoadFailed')}
            </ErrorBanner>
          ) : (
            <SkeletonRows count={4} />
          )}
        </div>
      )}

      {expanded && ytd && (
        <div className="border-t border-navy-secondary p-4 space-y-5 text-xs">
          <Section title={t('pay.earnings')}>
            <PaystubTable
              headers={['', t('pay.colHours'), t('pay.colRate'), t('pay.colCurrent'), t('pay.colYtd')]}
              rows={(item.earnings.length > 0
                ? item.earnings
                : [
                    {
                      id: 'fallback',
                      kind: 'REGULAR' as const,
                      hours: item.hoursWorked,
                      rate: item.hourlyRate,
                      amount: item.grossPay,
                      isTaxable: true,
                      notes: null,
                    },
                  ]
              ).map((e) => ({
                key: e.id,
                cells: [
                  t(KIND_KEY[e.kind]),
                  e.hours == null ? '—' : e.hours.toFixed(2),
                  e.rate == null ? '—' : fmtMoney(e.rate),
                  fmtMoney(e.amount),
                  fmtMoney(ytd.byKind[e.kind] ?? e.amount),
                ],
              }))}
              footer={[t('pay.grossPay'), '', '', fmtMoney(item.grossPay), fmtMoney(ytd.gross)]}
            />
          </Section>

          <Section title={t('pay.deductions')}>
            <PaystubTable
              headers={['', '', '', t('pay.colCurrent'), t('pay.colYtd')]}
              rows={[
                {
                  key: 'fit',
                  cells: [t('pay.fedIncomeTax'), '', '', `−${fmtMoney(item.federalWithholding)}`, `−${fmtMoney(ytd.federalWithholding)}`],
                },
                {
                  key: 'fica',
                  cells: [t('pay.socialSecurity'), '', '', `−${fmtMoney(item.fica)}`, `−${fmtMoney(ytd.fica)}`],
                },
                {
                  key: 'medicare',
                  cells: [t('pay.medicare'), '', '', `−${fmtMoney(item.medicare)}`, `−${fmtMoney(ytd.medicare)}`],
                },
                {
                  key: 'sit',
                  cells: [
                    `${t('pay.stateIncomeTax')}${item.taxState ? ` (${item.taxState})` : ''}`,
                    '',
                    '',
                    `−${fmtMoney(item.stateWithholding)}`,
                    `−${fmtMoney(ytd.stateWithholding)}`,
                  ],
                },
                ...(item.postTaxDeductions > 0
                  ? [
                      {
                        key: 'posttax',
                        cells: [
                          t('pay.garnishments'),
                          '',
                          '',
                          `−${fmtMoney(item.postTaxDeductions)}`,
                          `−${fmtMoney(ytd.postTaxDeductions)}`,
                        ],
                      },
                    ]
                  : []),
              ]}
              footer={[
                t('pay.totalDeductions'),
                '',
                '',
                `−${fmtMoney(item.federalWithholding + item.fica + item.medicare + item.stateWithholding + item.postTaxDeductions)}`,
                `−${fmtMoney(ytd.federalWithholding + ytd.fica + ytd.medicare + ytd.stateWithholding + ytd.postTaxDeductions)}`,
              ]}
            />
          </Section>

          <Section title={t('pay.employerContrib')}>
            <PaystubTable
              headers={['', '', '', t('pay.colCurrent'), t('pay.colYtd')]}
              rows={[
                {
                  key: 'efica',
                  cells: [t('pay.employerFica'), '', '', fmtMoney(item.employerFica), fmtMoney(ytd.employerFica)],
                },
                {
                  key: 'emed',
                  cells: [t('pay.employerMedicare'), '', '', fmtMoney(item.employerMedicare), fmtMoney(ytd.employerMedicare)],
                },
                {
                  key: 'futa',
                  cells: [t('pay.futa'), '', '', fmtMoney(item.employerFuta), fmtMoney(ytd.employerFuta)],
                },
                {
                  key: 'suta',
                  cells: [t('pay.suta'), '', '', fmtMoney(item.employerSuta), fmtMoney(ytd.employerSuta)],
                },
              ]}
            />
          </Section>

          <div className="flex items-center justify-between rounded border border-gold/30 bg-gold/5 p-3">
            <span className="text-xs uppercase tracking-widest text-gold">{t('pay.netPay')}</span>
            <div className="text-right">
              <div className="text-2xl text-gold tabular-nums">
                {fmtMoney(item.netPay)}
              </div>
              <div className="text-2xs uppercase tracking-wide text-silver/70">
                {t('pay.ytdNet', { amount: fmtMoney(ytd.netPay) })}
              </div>
            </div>
          </div>

          {item.disbursementRef && (
            <div className="text-xs text-silver/70">
              {t('pay.disbursementRef', { ref: item.disbursementRef })}
            </div>
          )}
          {item.failureReason && (
            <div className="text-xs text-alert">{item.failureReason}</div>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
            {(item.status === 'FAILED' || item.status === 'HELD') && (
              <Button
                size="sm"
                variant="outline"
                onClick={onAsk}
                className="mr-auto"
              >
                <HelpCircle className="h-3.5 w-3.5" />
                {t('pay.askButton')}
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={onDownload}
              loading={downloading}
            >
              <Download className="h-3.5 w-3.5" />
              {t('pay.downloadPdf')}
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

/**
 * Files an HR case (category PAYROLL) about a FAILED/HELD paycheck with the
 * item's facts auto-attached — same paper-trail pattern as MyTimesheet's
 * time-entry dispute dialog.
 */
function AskPaycheckDialog({
  item,
  onClose,
}: {
  item: PayrollItem | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const open = item !== null;

  const submit = async () => {
    if (!item || submitting) return;
    if (message.trim().length === 0) {
      toast.error(t('pay.askEmpty'));
      return;
    }
    setSubmitting(true);
    try {
      const when = item.disbursedAt ? fmtDate(item.disbursedAt) : 'not yet disbursed';
      await fileCase({
        category: 'PAYROLL',
        subject: `Paycheck ${item.status.toLowerCase()} — net ${fmtMoney(item.netPay)}`,
        description:
          `${message.trim()}\n\n— Paycheck details (auto-attached) —\n` +
          `Status: ${item.status}\n` +
          `Net pay: ${fmtMoney(item.netPay)}\n` +
          `Disbursed: ${when}\n` +
          (item.failureReason ? `Failure reason: ${item.failureReason}\n` : '') +
          `Payroll item id: ${item.id}`,
      });
      toast.success(t('pay.askSentToast'));
      setMessage('');
      onClose();
    } catch (err) {
      toast.error(t('pay.askSendFailed'), {
        description: err instanceof Error ? err.message : 'Something went wrong.',
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('pay.askButton')}</DialogTitle>
          <DialogDescription>{t('pay.askDesc')}</DialogDescription>
        </DialogHeader>
        {item && (
          <p className="text-xs text-silver tabular-nums">
            {t(STATUS_KEY[item.status])} · {t('pay.net').toLowerCase()}{' '}
            {fmtMoney(item.netPay)}
            {item.disbursedAt ? ` · ${fmtDate(item.disbursedAt)}` : ''}
          </p>
        )}
        <label className="block">
          <span className="text-xs2 uppercase tracking-wider text-silver">
            {t('pay.askLabel')}
          </span>
          <Textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={3}
            maxLength={2000}
            placeholder={t('pay.askPlaceholder')}
            className="mt-1"
          />
        </label>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} loading={submitting}>
            {t('pay.askSend')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-2xs uppercase tracking-widest text-silver/70 mb-1.5">{title}</div>
      {children}
    </div>
  );
}

function PaystubTable({
  headers,
  rows,
  footer,
}: {
  headers: string[];
  rows: Array<{ key: string; cells: string[] }>;
  footer?: string[];
}) {
  return (
    // Wrapped in overflow-x-auto so the earnings/deductions/taxes
    // breakdown can scroll horizontally on narrow phones instead of
    // squishing the tabular-num columns into illegible 2-3 char cells.
    <div className="-mx-2 overflow-x-auto sm:mx-0">
      {/* 13px, not 12 — these cells carry the associate's pay math, the
          most load-bearing numbers in the app, read on phones at arm's
          length. Still fits the 5-col grid at 320px. */}
      <table className="w-full min-w-[20rem] text-xs">
      <thead>
        <tr className="text-silver/70">
          {headers.map((h, i) => (
            <th
              key={i}
              className={cn('py-1 font-normal text-xs2 uppercase tracking-widest', i === 0 ? 'text-left' : 'text-right')}
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className="border-t border-navy-secondary/60">
            {r.cells.map((c, i) => (
              <td
                key={i}
                className={cn('py-1.5 tabular-nums', i === 0 ? 'text-left text-silver' : 'text-right text-white')}
              >
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
      {footer && (
        <tfoot>
          <tr className="border-t-2 border-silver/20">
            {footer.map((c, i) => (
              <td
                key={i}
                className={cn(
                  'py-1.5 tabular-nums font-medium',
                  i === 0 ? 'text-left text-silver/80' : 'text-right text-white'
                )}
              >
                {c}
              </td>
            ))}
          </tr>
        </tfoot>
      )}
      </table>
    </div>
  );
}

