import { useEffect, useState } from 'react';
import { Coins, Download, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
import { downloadCsv } from '@/lib/csv';
import { fmtDate, fmtMoney, parseYmd, ymdLocal } from '@/lib/format';
import { hasCapability } from '@/lib/roles';
import { statusTone } from '@/lib/status';
import {
  cancelEquityGrant,
  createEquityGrant,
  exerciseEquityGrant,
  getEquityGrant,
  getEquitySummary,
  grantEquityGrant,
  listEquityGrants,
  listMyEquity,
  type EquityGrant,
  type EquityGrantDetail,
  type EquityGrantStatus,
  type EquityGrantType,
  type EquitySummary,
  type MyEquityGrant,
} from '@/lib/equity129Api';
import {
  Badge,
  Button,
  Card,
  CardContent,
  Drawer,
  DrawerBody,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  EmptyState,
  ErrorBanner,
  Input,
  MetricCard,
  PageHeader,
  SearchInput,
  SegmentedControl,
  type SegmentedControlOption,
  Select,
  SkeletonRows,
  Textarea,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui';
import { Label } from '@/components/ui/Label';
import {
  AssociatePicker,
  type PickedAssociate,
} from '@/components/ui/AssociatePicker';

/** Add n months to a YYYY-MM-DD string, returning YYYY-MM-DD (local). */
const addMonths = (iso: string, months: number): string | null => {
  const d = parseYmd(iso);
  if (!d) return null;
  d.setMonth(d.getMonth() + months);
  if (Number.isNaN(d.getTime())) return null;
  return ymdLocal(d);
};

/** Date-only "YYYY-MM-DD" → "May 13, 2026" without the UTC-midnight shift. */
const fmtYmd = (s: string | null | undefined) => fmtDate(parseYmd(s));

/** Strike price render: currency-aware, 4-decimal precision (sub-cent strikes). */
const fmtStrike = (price: string | null, currency: string) =>
  price ? fmtMoney(price, { currency, precise: true }) : '—';

/** Shared "section failed to load" body with a Retry affordance. */
function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="p-6">
      <ErrorBanner
        action={
          <Button size="sm" variant="secondary" onClick={onRetry}>
            Retry
          </Button>
        }
      >
        {message}
      </ErrorBanner>
    </div>
  );
}

const GRANT_TYPE_LABELS: Record<EquityGrantType, string> = {
  RSU: 'RSU',
  NSO: 'NSO option',
  ISO: 'ISO option',
  PHANTOM: 'Phantom',
  PERFORMANCE_RSU: 'PSU',
};

// Domain-only codes the shared vocabulary doesn't carry: GRANTED is this
// domain's terminal-good; EXERCISED is an informational after-state (steel).
// PROPOSED / CANCELLED / EXPIRED come from the shared status vocabulary.
const EQUITY_STATUS_TONES = { GRANTED: 'success', EXERCISED: 'info' } as const;

const STATUS_LABELS: Record<EquityGrantStatus, string> = {
  PROPOSED: 'Proposed',
  GRANTED: 'Granted',
  CANCELLED: 'Cancelled',
  EXERCISED: 'Exercised',
  EXPIRED: 'Expired',
};

export function EquityHome() {
  const { user } = useAuth();
  const canManageComp = user ? hasCapability(user.role, 'manage:comp') : false;
  const [tab, setTab] = useState<'mine' | 'admin'>('mine');
  const [mine, setMine] = useState<MyEquityGrant[] | null>(null);
  const [mineError, setMineError] = useState<string | null>(null);
  const [admin, setAdmin] = useState<EquityGrant[] | null>(null);
  const [adminError, setAdminError] = useState<string | null>(null);
  const [summary, setSummary] = useState<EquitySummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<EquityGrantStatus | 'ALL'>(
    'GRANTED',
  );
  const [search, setSearch] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [openMine, setOpenMine] = useState<MyEquityGrant | null>(null);
  const [openAdminId, setOpenAdminId] = useState<string | null>(null);

  const refresh = () => {
    if (tab === 'mine') {
      setMine(null);
      setMineError(null);
      listMyEquity()
        .then((r) => setMine(r.grants))
        .catch((err) =>
          setMineError(
            err instanceof ApiError ? err.message : 'Could not load your grants.',
          ),
        );
    } else {
      setAdmin(null);
      setAdminError(null);
      listEquityGrants(statusFilter === 'ALL' ? undefined : statusFilter)
        .then((r) => setAdmin(r.grants))
        .catch((err) =>
          setAdminError(
            err instanceof ApiError ? err.message : 'Could not load grants.',
          ),
        );
    }
  };
  // Filter-independent KPI summary — fetched once on mount and re-fetched
  // explicitly after mutations, never on tab/filter clicks.
  const refreshSummary = () => {
    setSummaryError(null);
    getEquitySummary()
      .then(setSummary)
      .catch((err) => {
        setSummary(null);
        setSummaryError(
          err instanceof ApiError
            ? err.message
            : 'Could not load the equity summary.',
        );
      });
  };
  useEffect(() => {
    refresh();
  }, [tab, statusFilter]);
  useEffect(() => {
    if (canManageComp) refreshSummary();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canManageComp]);

  const q = search.trim().toLowerCase();
  const filteredAdmin = (admin ?? []).filter(
    (g) =>
      q === '' ||
      (g.associateName ?? '').toLowerCase().includes(q) ||
      (g.associateEmail ?? '').toLowerCase().includes(q),
  );

  // The admin segment only exists for comp managers; building the option
  // list up front keeps the conditional out of the JSX and the generic
  // parameter explicit (inference would otherwise narrow to 'mine').
  const tabOptions: SegmentedControlOption<'mine' | 'admin'>[] = [
    { value: 'mine', label: 'My grants' },
  ];
  if (canManageComp) {
    tabOptions.push({
      value: 'admin',
      label: (
        <>
          All grants
          {summary && summary.proposedCount > 0 && (
            <Badge variant="pending" className="ml-2">
              {summary.proposedCount}
            </Badge>
          )}
        </>
      ),
    });
  }

  const exportCsv = () => {
    // Cap-table extract of what's currently on screen (filter + search).
    downloadCsv(`equity-grants-${ymdLocal()}.csv`, [
      ['Associate', 'Kind', 'Shares', 'Strike', 'Vest start', 'Status'],
      ...filteredAdmin.map((g) => [
        g.associateName ?? '',
        GRANT_TYPE_LABELS[g.grantType],
        g.totalShares,
        g.strikePrice ? `${g.currency} ${g.strikePrice}` : '',
        g.vestingStartDate,
        STATUS_LABELS[g.status],
      ]),
    ]);
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Equity"
        subtitle="Stock and option grants. Vesting tranches generated at grant time — cliff plus monthly until fully vested."
        breadcrumbs={[{ label: 'Total rewards' }, { label: 'Equity' }]}
      />

      <div className="flex items-center justify-between">
        <SegmentedControl<'mine' | 'admin'>
          ariaLabel="Grant view"
          value={tab}
          onChange={setTab}
          options={tabOptions}
        />
        <div className="flex gap-2 flex-wrap justify-end">
          {canManageComp && tab === 'admin' && (
            <>
              <SearchInput
                className="h-8 w-52 text-sm"
                placeholder="Search associate…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search grants by associate"
              />
              <Select
                size="sm"
                value={statusFilter}
                onChange={(e) =>
                  setStatusFilter(e.target.value as EquityGrantStatus | 'ALL')
                }
              >
                <option value="ALL">All statuses</option>
                <option value="PROPOSED">Proposed</option>
                <option value="GRANTED">Granted</option>
                <option value="CANCELLED">Cancelled</option>
                <option value="EXERCISED">Exercised</option>
                <option value="EXPIRED">Expired</option>
              </Select>
              <Button
                size="sm"
                variant="secondary"
                onClick={exportCsv}
                disabled={filteredAdmin.length === 0}
              >
                <Download className="mr-2 h-4 w-4" /> Export CSV
              </Button>
            </>
          )}
          {canManageComp && (
            <Button onClick={() => setShowNew(true)}>
              <Plus className="mr-2 h-4 w-4" /> New grant
            </Button>
          )}
        </div>
      </div>

      {tab === 'admin' && summaryError && (
        <ErrorBanner
          action={
            <Button size="sm" variant="secondary" onClick={refreshSummary}>
              Retry
            </Button>
          }
        >
          {summaryError}
        </ErrorBanner>
      )}

      {tab === 'admin' && summary && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <MetricCard label="Proposed" value={summary.proposedCount} />
          <MetricCard
            label="Active recipients"
            value={summary.activeRecipients}
          />
          <MetricCard
            label="Shares granted"
            value={summary.sharesGranted.toLocaleString()}
          />
          <MetricCard
            label="Shares vested"
            value={summary.sharesVested.toLocaleString()}
          />
        </div>
      )}

      {tab === 'mine' ? (
        <Card>
          <CardContent className="p-0">
            {mineError !== null ? (
              <LoadError message={mineError} onRetry={refresh} />
            ) : mine === null ? (
              <div className="p-6">
                <SkeletonRows count={3} />
              </div>
            ) : mine.length === 0 ? (
              <EmptyState
                icon={Coins}
                title="No equity grants"
                description="Once HR issues you a grant, you'll see it here."
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Type</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead className="text-right">Vested</TableHead>
                    <TableHead className="hidden md:table-cell text-right">Unvested</TableHead>
                    <TableHead className="hidden lg:table-cell text-right">Strike</TableHead>
                    <TableHead className="hidden md:table-cell">Grant date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {mine.map((g) => (
                    <TableRow
                      key={g.id}
                      className="cursor-pointer"
                      onClick={() => setOpenMine(g)}
                    >
                      <TableCell className="font-medium text-white">
                        <div className="truncate">{GRANT_TYPE_LABELS[g.grantType]}</div>
                        <div className="md:hidden text-xs2 text-silver/70 truncate">
                          {fmtYmd(g.grantDate)}
                          {g.strikePrice
                            ? ` · ${fmtStrike(g.strikePrice, g.currency)}`
                            : ''}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm text-right tabular-nums">
                        {g.totalShares.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-sm text-success text-right tabular-nums">
                        {g.vestedShares.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-sm text-silver hidden md:table-cell text-right tabular-nums">
                        {g.unvestedShares.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-sm hidden lg:table-cell text-right tabular-nums">
                        {fmtStrike(g.strikePrice, g.currency)}
                      </TableCell>
                      <TableCell className="text-xs text-silver hidden md:table-cell">
                        {fmtYmd(g.grantDate)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            {adminError !== null ? (
              <LoadError message={adminError} onRetry={refresh} />
            ) : admin === null ? (
              <div className="p-6">
                <SkeletonRows count={4} />
              </div>
            ) : filteredAdmin.length === 0 ? (
              <EmptyState
                icon={Coins}
                title="No grants"
                description={
                  admin.length > 0
                    ? 'No grants match your search.'
                    : statusFilter !== 'ALL'
                      ? 'Nothing matches this status filter.'
                      : 'No equity grants have been created yet.'
                }
                action={
                  admin.length > 0 ? (
                    <Button size="sm" variant="secondary" onClick={() => setSearch('')}>
                      Clear search
                    </Button>
                  ) : statusFilter !== 'ALL' ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setStatusFilter('ALL')}
                    >
                      Clear filter
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Associate</TableHead>
                    <TableHead className="hidden md:table-cell">Type</TableHead>
                    <TableHead className="text-right">Shares</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="hidden md:table-cell">Grant date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredAdmin.map((g) => (
                    <TableRow
                      key={g.id}
                      className="cursor-pointer"
                      onClick={() => setOpenAdminId(g.id)}
                    >
                      <TableCell>
                        <div className="font-medium text-white">
                          {g.associateName ?? '—'}
                        </div>
                        <div className="text-xs text-silver">
                          {g.associateEmail ?? ''}
                        </div>
                        <div className="md:hidden text-xs2 text-silver/70 truncate">
                          {GRANT_TYPE_LABELS[g.grantType]} · {fmtYmd(g.grantDate)}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm hidden md:table-cell">
                        {GRANT_TYPE_LABELS[g.grantType]}
                      </TableCell>
                      <TableCell className="text-sm text-right tabular-nums">
                        {g.totalShares.toLocaleString()}
                      </TableCell>
                      <TableCell>
                        <Badge variant={statusTone(g.status, { overrides: EQUITY_STATUS_TONES })}>
                          {STATUS_LABELS[g.status]}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-silver hidden md:table-cell">
                        {fmtYmd(g.grantDate)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

      {showNew && canManageComp && (
        <NewGrantDrawer
          onClose={() => setShowNew(false)}
          onSaved={() => {
            setShowNew(false);
            refresh();
            if (canManageComp) refreshSummary();
          }}
        />
      )}
      {openMine && (
        <MyDetailDrawer row={openMine} onClose={() => setOpenMine(null)} />
      )}
      {openAdminId && (
        <AdminDetailDrawer
          id={openAdminId}
          onClose={() => setOpenAdminId(null)}
          onSaved={() => {
            setOpenAdminId(null);
            refresh();
            if (canManageComp) refreshSummary();
          }}
        />
      )}
    </div>
  );
}

function NewGrantDrawer({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [assoc, setAssoc] = useState<PickedAssociate | null>(null);
  const [grantType, setGrantType] = useState<EquityGrantType>('RSU');
  const [totalShares, setTotalShares] = useState('');
  const [strikePrice, setStrikePrice] = useState('');
  const today = ymdLocal();
  const [grantDate, setGrantDate] = useState(today);
  const [vestingStartDate, setVestingStartDate] = useState(today);
  const [cliffMonths, setCliffMonths] = useState('12');
  const [vestingMonths, setVestingMonths] = useState('48');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  const isOption = grantType === 'NSO' || grantType === 'ISO';

  // Live vesting preview — purely derived from the current inputs.
  const previewShares = parseInt(totalShares, 10);
  const previewCliff = parseInt(cliffMonths, 10);
  const previewMonths = parseInt(vestingMonths, 10);
  const previewValid =
    Number.isFinite(previewShares) &&
    previewShares > 0 &&
    Number.isFinite(previewCliff) &&
    previewCliff >= 0 &&
    Number.isFinite(previewMonths) &&
    previewMonths > 0 &&
    previewCliff <= previewMonths;
  const cliffDate = previewValid
    ? addMonths(vestingStartDate, previewCliff)
    : null;
  const vestEndDate = previewValid
    ? addMonths(vestingStartDate, previewMonths)
    : null;
  const cliffShares = previewValid
    ? Math.floor((previewShares * previewCliff) / previewMonths)
    : 0;
  const monthlyShares = previewValid
    ? Math.round(previewShares / previewMonths)
    : 0;
  // Notional value at strike — only meaningful for options with a strike set.
  const strikeNum = parseFloat(strikePrice);
  const valueAtStrike =
    isOption && previewValid && Number.isFinite(strikeNum) && strikeNum > 0
      ? previewShares * strikeNum
      : null;

  const submit = async () => {
    if (!assoc) {
      toast.error('Pick an associate.');
      return;
    }
    if (!totalShares) {
      toast.error('Total shares required.');
      return;
    }
    if (isOption && !strikePrice) {
      toast.error('Options require a strike price.');
      return;
    }
    setBusy(true);
    try {
      await createEquityGrant({
        associateId: assoc.id,
        grantType,
        totalShares: parseInt(totalShares, 10),
        strikePrice: isOption ? parseFloat(strikePrice) : null,
        grantDate,
        vestingStartDate,
        cliffMonths: parseInt(cliffMonths, 10),
        vestingMonths: parseInt(vestingMonths, 10),
        notes: notes.trim() || null,
      });
      toast.success('Grant created as proposed.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not create the grant.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>New equity grant</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>Associate</Label>
          <div className="mt-1">
            <AssociatePicker value={assoc} onChange={setAssoc} />
          </div>
        </div>
        <div>
          <Label htmlFor="equity-grant-type">Type</Label>
          <Select
            id="equity-grant-type"
            className="mt-1"
            value={grantType}
            onChange={(e) => setGrantType(e.target.value as EquityGrantType)}
          >
            {(Object.keys(GRANT_TYPE_LABELS) as EquityGrantType[]).map((k) => (
              <option key={k} value={k}>
                {GRANT_TYPE_LABELS[k]}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label>Total shares</Label>
          <Input
            type="number"
            min="1"
            className="mt-1"
            value={totalShares}
            onChange={(e) => setTotalShares(e.target.value)}
          />
        </div>
        {isOption && (
          <div>
            <Label>Strike price (USD)</Label>
            <Input
              type="number"
              min="0"
              step="0.0001"
              className="mt-1"
              value={strikePrice}
              onChange={(e) => setStrikePrice(e.target.value)}
            />
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Grant date</Label>
            <Input
              type="date"
              className="mt-1"
              value={grantDate}
              onChange={(e) => setGrantDate(e.target.value)}
            />
          </div>
          <div>
            <Label>Vesting start</Label>
            <Input
              type="date"
              className="mt-1"
              value={vestingStartDate}
              onChange={(e) => setVestingStartDate(e.target.value)}
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Cliff (months)</Label>
            <Input
              type="number"
              min="0"
              max="120"
              className="mt-1"
              value={cliffMonths}
              onChange={(e) => setCliffMonths(e.target.value)}
            />
          </div>
          <div>
            <Label>Vesting total (months)</Label>
            <Input
              type="number"
              min="1"
              max="120"
              className="mt-1"
              value={vestingMonths}
              onChange={(e) => setVestingMonths(e.target.value)}
            />
          </div>
        </div>
        {previewValid && cliffDate && vestEndDate && (
          <div className="text-xs text-silver border border-navy-secondary rounded-md p-3 space-y-1">
            <div>
              {previewCliff > 0
                ? `${cliffShares.toLocaleString()} shares vest at cliff on ${fmtYmd(cliffDate)}; then ~${monthlyShares.toLocaleString()}/month through ${fmtYmd(vestEndDate)}.`
                : `No cliff — ~${monthlyShares.toLocaleString()} shares/month through ${fmtYmd(vestEndDate)}.`}
            </div>
            {valueAtStrike !== null && (
              <div>
                Value at strike: {fmtMoney(valueAtStrike)} (
                {previewShares.toLocaleString()} × {fmtMoney(strikeNum, { precise: true })}
                )
              </div>
            )}
          </div>
        )}
        <div>
          <Label>Notes</Label>
          <Textarea
            className="mt-1 h-20"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Internal context — board approval ref, retention rationale, etc."
          />
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={busy}>
          {busy ? 'Creating…' : 'Create proposed grant'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

function MyDetailDrawer({
  row,
  onClose,
}: {
  row: MyEquityGrant;
  onClose: () => void;
}) {
  const pctVested =
    row.totalShares > 0
      ? Math.round((row.vestedShares / row.totalShares) * 100)
      : 0;
  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>
          {GRANT_TYPE_LABELS[row.grantType]} · {row.totalShares.toLocaleString()}{' '}
          shares
        </DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div className="flex items-center gap-2">
          <Badge variant={statusTone(row.status, { overrides: EQUITY_STATUS_TONES })}>{STATUS_LABELS[row.status]}</Badge>
          <span className="text-sm text-silver">
            Granted {fmtYmd(row.grantDate)} · Vesting from {fmtYmd(row.vestingStartDate)}
          </span>
        </div>

        <Card>
          <CardContent className="p-4">
            <div className="flex justify-between items-baseline mb-2">
              <span className="text-sm text-silver">Vested</span>
              <span className="text-2xl font-semibold text-success">
                {row.vestedShares.toLocaleString()}
              </span>
            </div>
            <div className="w-full bg-navy-secondary rounded-full h-2 overflow-hidden">
              <div
                className="bg-success h-full transition-all"
                style={{ width: `${pctVested}%` }}
              />
            </div>
            <div className="flex justify-between text-xs mt-2 text-silver">
              <span>{pctVested}% vested</span>
              <span>
                {row.unvestedShares.toLocaleString()} remaining
              </span>
            </div>
          </CardContent>
        </Card>

        {row.strikePrice && (
          <div className="text-sm">
            <span className="text-silver">Strike price: </span>
            <span className="text-white font-semibold">
              {fmtStrike(row.strikePrice, row.currency)}
            </span>
            {row.expirationDate && (
              <span className="text-silver ml-3">
                Expires {fmtYmd(row.expirationDate)}
              </span>
            )}
          </div>
        )}

        <div>
          <div className="text-sm font-medium mb-2">Upcoming vesting</div>
          {row.upcomingTranches.length === 0 ? (
            <div className="text-xs text-silver italic">
              Fully vested — no future tranches.
            </div>
          ) : (
            <div className="space-y-1">
              {row.upcomingTranches.map((t) => (
                <div
                  key={t.vestDate}
                  className="flex justify-between text-sm border-b border-navy-secondary pb-1"
                >
                  <span className="text-silver">{fmtYmd(t.vestDate)}</span>
                  <span className="text-white">
                    +{t.shares.toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="text-xs text-silver pt-2 border-t border-navy-secondary">
          Schedule: {row.cliffMonths}-month cliff, {row.vestingMonths} months
          total.
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button onClick={onClose}>Close</Button>
      </DrawerFooter>
    </Drawer>
  );
}

function AdminDetailDrawer({
  id,
  onClose,
  onSaved,
}: {
  id: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const confirm = useConfirm();
  const [grant, setGrant] = useState<EquityGrantDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    setGrant(null);
    setLoadError(null);
    getEquityGrant(id)
      .then((r) => setGrant(r.grant))
      .catch((err) =>
        setLoadError(
          err instanceof ApiError ? err.message : 'Could not load this grant.',
        ),
      );
  };
  useEffect(() => {
    load();
  }, [id]);

  const act = async (
    fn: () => Promise<{ ok: true }>,
    successMessage: string,
  ) => {
    setBusy(true);
    try {
      await fn();
      toast.success(successMessage);
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not update the grant.');
    } finally {
      setBusy(false);
    }
  };

  // The cancel endpoint takes no reason payload, so this is a hard confirm
  // (destructive) rather than a reason prompt — no more one-click voiding.
  const onCancelGrant = async (g: EquityGrantDetail) => {
    const ok = await confirm({
      title: `Cancel this ${GRANT_TYPE_LABELS[g.grantType]} grant?`,
      description: `${g.associateName ?? 'The associate'}'s grant of ${g.totalShares.toLocaleString()} shares will be voided and they'll be notified. This can't be undone.`,
      confirmLabel: 'Cancel grant',
      cancelLabel: 'Keep grant',
      destructive: true,
    });
    if (!ok) return;
    await act(() => cancelEquityGrant(g.id), 'Grant cancelled.');
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>
          {grant
            ? `${grant.associateName} · ${GRANT_TYPE_LABELS[grant.grantType]}`
            : 'Grant details'}
        </DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        {loadError !== null ? (
          <LoadError message={loadError} onRetry={load} />
        ) : !grant ? (
          <SkeletonRows count={3} />
        ) : (
          <>
            <div className="flex items-center gap-2">
              <Badge variant={statusTone(grant.status, { overrides: EQUITY_STATUS_TONES })}>
                {STATUS_LABELS[grant.status]}
              </Badge>
              <span className="text-sm text-silver">
                {grant.totalShares.toLocaleString()} total ·{' '}
                {grant.vestedShares.toLocaleString()} vested
              </span>
            </div>
            <div className="text-xs text-silver">
              Granted {fmtYmd(grant.grantDate)} · Vesting starts{' '}
              {fmtYmd(grant.vestingStartDate)} · {grant.cliffMonths}-mo cliff ·{' '}
              {grant.vestingMonths} mo total
              {grant.grantedByEmail && ` · by ${grant.grantedByEmail}`}
            </div>
            {grant.strikePrice && (
              <div className="text-sm">
                Strike: {fmtStrike(grant.strikePrice, grant.currency)}
                {grant.expirationDate &&
                  ` · expires ${fmtYmd(grant.expirationDate)}`}
              </div>
            )}
            {grant.notes && (
              <div className="text-sm text-silver italic p-3 rounded border border-navy-secondary">
                {grant.notes}
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              {grant.status === 'PROPOSED' && (
                <Button
                  size="sm"
                  onClick={() =>
                    act(() => grantEquityGrant(grant.id), 'Granted.')
                  }
                  disabled={busy}
                >
                  Mark granted
                </Button>
              )}
              {(grant.status === 'PROPOSED' ||
                grant.status === 'GRANTED') && (
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => onCancelGrant(grant)}
                  disabled={busy}
                >
                  Cancel grant
                </Button>
              )}
              {grant.status === 'GRANTED' &&
                (grant.grantType === 'NSO' || grant.grantType === 'ISO') && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      act(
                        () => exerciseEquityGrant(grant.id),
                        'Marked exercised.',
                      )
                    }
                    disabled={busy}
                  >
                    Mark exercised
                  </Button>
                )}
            </div>

            <div>
              <div className="text-sm font-medium mb-2">Vesting schedule</div>
              <div className="max-h-64 overflow-y-auto border border-navy-secondary rounded">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead className="text-right">Shares</TableHead>
                      <TableHead className="hidden md:table-cell">Type</TableHead>
                      <TableHead>Vested</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {grant.events.map((e) => (
                      <TableRow key={e.id}>
                        <TableCell className="text-xs">
                          <div className="truncate">{fmtYmd(e.vestDate)}</div>
                          <div className="md:hidden text-xs2 text-silver/70 truncate">
                            {e.isCliff ? 'Cliff' : 'Monthly'}
                          </div>
                        </TableCell>
                        <TableCell className="text-sm text-right tabular-nums">
                          {e.shares.toLocaleString()}
                        </TableCell>
                        <TableCell className="text-xs text-silver hidden md:table-cell">
                          {e.isCliff ? 'Cliff' : 'Monthly'}
                        </TableCell>
                        <TableCell>
                          {e.vested ? (
                            <Badge variant="success">Vested</Badge>
                          ) : (
                            <span className="text-silver text-xs">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          </>
        )}
      </DrawerBody>
      <DrawerFooter>
        <Button onClick={onClose}>Close</Button>
      </DrawerFooter>
    </Drawer>
  );
}
