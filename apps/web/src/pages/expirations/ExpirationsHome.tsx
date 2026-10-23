import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AssociateLink } from '@/components/ui/AssociateLink';
import { AlertCircle, Calendar, Clock, Download, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { downloadCsv } from '@/lib/csv';
import {
  getExpirations,
  type ExpirationItem,
  type ExpirationsResponse,
} from '@/lib/expirations113Api';
import { grantAssociateQual } from '@/lib/qualApi';
import { useAuth, useTenant } from '@/lib/auth';
import { TransportExpiringSection } from '@/pages/transport/TransportDesk';
import { hasCapability } from '@/lib/roles';
import { useUrlParam, useUrlState, useUrlWriter, urlNumber } from '@/lib/useUrlState';
import { useSelection, type Selection } from '@/lib/useSelection';
import {
  Badge,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Drawer,
  DrawerBody,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  ErrorBanner,
  EmptyState,
  Input,
  SegmentedControl,
  SkeletonRows,
} from '@/components/ui';
import { MetricCard } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { SearchInput } from '@/components/ui/FilterBar';
import { Label } from '@/components/ui/Label';
import { ListTemplate } from '@/components/templates';
import { fmtDate, ymdLocal } from '@/lib/format';
import { ExpirationAtRisk, ExpirationTimeline, applyRiskFilters, useExpirationRisk, type RiskFilters } from './ExpirationsRisk';
import type { ExpirationRisk } from '@/lib/expirations113Api';
import { nextInQueue } from '@/lib/queueNext';

/**
 * Phase 113 — Expiration dashboard.
 *
 * Three buckets stacked: expired (urgent — block deployment),
 * due soon (next N days), due later (informational, capped at 365).
 * Toggle between certs only / all qualifications.
 *
 * Click a row to renew the qualification — upserts AssociateQualification
 * with new acquiredAt + expiresAt. Manage:scheduling required.
 */
type ExpView = 'risk' | 'timeline' | 'list';
const VIEWS: readonly ExpView[] = ['risk', 'timeline', 'list'];
type Within = 30 | 60 | 90;
const WITHIN = urlNumber({ min: 30, max: 90, integer: true });
const TYPES = ['all', 'cert'] as const;

/**
 * Expirations, three ways: At risk (what will stop someone working a shift
 * they're on — the default), Timeline (weeks across, stores down), and the
 * full list. One renew drawer serves all three.
 */
export function ExpirationsHome() {
  const { user } = useAuth();
  const canRenew = user ? hasCapability(user.role, 'manage:scheduling') : false;
  const [view, setView] = useUrlParam<ExpView>('view', 'risk', VIEWS);
  const write = useUrlWriter();
  const [filters, setFilters] = useState<RiskFilters>({ clientId: '', storeId: '', qualificationId: '', q: '' });
  const [renewTarget, setRenewTarget] = useState<ExpirationItem | null>(null);
  const qc = useQueryClient();
  // The totals over every view: what has lapsed, what lapses within 30
  // days (the full list's own counts), and what already blocks a shift.
  const totals = useQuery({
    queryKey: ['ExpirationsHome', 'totals'],
    queryFn: () => getExpirations({ days: 30 }),
  });
  const risk = useExpirationRisk();
  const expired = totals.data?.counts.expired;
  const due30 = totals.data?.counts.dueSoon;
  const blocking = risk.data?.atRisk.length;
  /** A tile opens the list it counts: the full list on its bucket. */
  const openList = (within: Within | null) =>
    write((p) => {
      p.set('view', 'list');
      p.delete('type');
      if (within && within !== 60) p.set('within', String(within));
      else p.delete('within');
    });
  const allQuiet = expired === 0 && due30 === 0 && blocking === 0;
  return (
    <ListTemplate
      title="Expirations"
      subtitle="Credentials that lapse — first the ones that would stop someone working a shift they’re already on."
      summary={
        totals.data && risk.data ? (
          <MetricStrip
            label="Expirations at a glance"
            empty={allQuiet ? 'Nothing has expired, nothing lapses in the next 30 days, and no shift is blocked.' : undefined}
          >
            <MetricCard
              label="Blocking a shift"
              value={String(blocking ?? 0)}
              tone={(blocking ?? 0) > 0 ? 'alert' : 'neutral'}
              hint="A lapse before a shift that needs it"
              onClick={() => setView('risk')}
              selected={view === 'risk'}
            />
            <MetricCard
              label="Expired"
              value={String(expired ?? 0)}
              tone={(expired ?? 0) > 0 ? 'alert' : 'neutral'}
              hint="Lapsed and not renewed"
              onClick={() => openList(null)}
            />
            <MetricCard
              label="Due in 30 days"
              value={String(due30 ?? 0)}
              tone={(due30 ?? 0) > 0 ? 'warning' : 'neutral'}
              hint="Lapsing this month"
              onClick={() => openList(30)}
            />
          </MetricStrip>
        ) : undefined
      }
    >
      <SegmentedControl
        ariaLabel="How to see expirations"
        value={view}
        onChange={setView}
        options={[
          { value: 'risk' as const, label: 'At risk' },
          { value: 'timeline' as const, label: 'Timeline' },
          { value: 'list' as const, label: 'All expiring' },
        ]}
      />
      {view === 'risk' ? (
        <ExpirationAtRisk filters={filters} setFilters={setFilters} onRenew={canRenew ? setRenewTarget : undefined} />
      ) : view === 'timeline' ? (
        <ExpirationTimeline filters={filters} setFilters={setFilters} onRenew={canRenew ? setRenewTarget : undefined} />
      ) : (
        <ExpirationsListView />
      )}
      {renewTarget && view !== 'list' && (
        <RenewDrawer
          key={renewTarget.id}
          item={renewTarget}
          onClose={() => setRenewTarget(null)}
          onSaved={(goNext) => {
            void qc.invalidateQueries({ queryKey: ['expirations', 'risk'] });
            void qc.invalidateQueries({ queryKey: ['ExpirationsHome'] });
            if (!goNext) {
              setRenewTarget(null);
              return;
            }
            // "Renew & next" used to close here in the At-risk and Timeline
            // views (only the list view chained). Chain through the rows in
            // view, in their order, skipping the one just renewed.
            const data = qc.getQueryData<ExpirationRisk>(['expirations', 'risk']);
            const inView = applyRiskFilters(data?.items ?? [], filters);
            setRenewTarget(nextInQueue(inView, renewTarget.id));
          }}
        />
      )}
    </ListTemplate>
  );
}

/** The full list, in three buckets (the original page): every expiring credential, renewable in bulk. */
function ExpirationsListView() {
  const { user } = useAuth();
  const canRenew = user
    ? hasCapability(user.role, 'manage:scheduling')
    : false;
  const tenant = useTenant();
  const showTransport = !!user && hasCapability(user.role, 'view:transport') && tenant.modules.transportation !== false;
  const [loadError, setLoadError] = useState<string | null>(null);
  // The window and the type live in the URL (?within=30&type=cert), so a
  // tile above can open the list on its bucket and a link keeps the view.
  const [rawDays, setDays] = useUrlState<number>('within', 60, WITHIN);
  const days: Within = rawDays === 30 || rawDays === 90 ? rawDays : 60;
  const [filter, setFilter] = useUrlParam<'all' | 'cert'>('type', 'all', TYPES);
  const [search, setSearch] = useState('');
  const [renewTarget, setRenewTarget] = useState<ExpirationItem | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkExpiresAt, setBulkExpiresAt] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);

  // Keeps the previous buckets on screen while a filter flip refetches —
  // no full-skeleton flash. The sequence guard drops out-of-order responses
  // from rapid toggling.
  const refreshQuery = useQuery({
    queryKey: ['ExpirationsHome', 'data', days, filter],
    queryFn: () => getExpirations({
      days,
      isCert: filter === 'cert' ? true : undefined,
    }),
  });
  const data: ExpirationsResponse | null = refreshQuery.data ?? null;
  useEffect(() => {
    const d = refreshQuery.data;
    if (d === undefined) return;
    setLoadError(null);

  }, [refreshQuery.data]);
  useEffect(() => {
    if (!refreshQuery.isError) return;
    setLoadError('Failed to load expirations.');
  }, [refreshQuery.isError, refreshQuery.error]);
  const refresh = () => void refreshQuery.refetch();


  const q = search.trim().toLowerCase();
  const { expired, dueSoon, dueLater } = useMemo(() => {
    const matches = (i: ExpirationItem) =>
      !q ||
      i.associateName.toLowerCase().includes(q) ||
      i.associateEmail.toLowerCase().includes(q) ||
      i.qualificationName.toLowerCase().includes(q) ||
      i.qualificationCode.toLowerCase().includes(q);
    return {
      expired: data ? data.expired.filter(matches) : [],
      dueSoon: data ? data.dueSoon.filter(matches) : [],
      dueLater: data ? data.dueLater.filter(matches) : [],
    };
  }, [data, q]);

  // Every bucket row renews through the same grantAssociateQual upsert, so
  // any mix of kinds (work auth, drug test, certs) can share one bulk date.
  // Memoized ids: a fresh array identity every render defeats memoization
  // inside useSelection.
  const renewableIds = useMemo(
    () =>
      canRenew
        ? [...expired, ...dueSoon, ...dueLater].map((i) => i.id)
        : [],
    [canRenew, expired, dueSoon, dueLater],
  );
  const sel = useSelection(renewableIds);
  // Resolve against the currently visible (filtered) rows so ids left over
  // from a previous search/window can never be submitted.
  const selectedItems = useMemo(
    () =>
      [...expired, ...dueSoon, ...dueLater].filter((i) =>
        sel.selected.has(i.id),
      ),
    [expired, dueSoon, dueLater, sel.selected],
  );

  const openBulk = () => {
    // Same smart default as the per-row drawer: one year from today,
    // computed in local time.
    const d = new Date();
    d.setFullYear(d.getFullYear() + 1);
    setBulkExpiresAt(ymdLocal(d));
    setBulkOpen(true);
  };

  const bulkSubmit = async () => {
    const today = ymdLocal();
    if (!bulkExpiresAt) {
      toast.error('New expiration date is required.');
      return;
    }
    if (bulkExpiresAt <= today) {
      toast.error('Expiration must be after today.');
      return;
    }
    const items = selectedItems;
    setBulkBusy(true);
    const results = await Promise.allSettled(
      items.map((i) =>
        grantAssociateQual(i.associateId, {
          qualificationId: i.qualificationId,
          acquiredAt: today,
          expiresAt: bulkExpiresAt,
          evidenceKey: null,
        }),
      ),
    );
    setBulkBusy(false);
    let ok = 0;
    results.forEach((r, idx) => {
      if (r.status === 'fulfilled') {
        ok += 1;
        return;
      }
      const item = items[idx];
      const msg =
        r.reason instanceof ApiError ? r.reason.message : 'Failed.';
      toast.error(
        `${item.associateName} — ${item.qualificationName}: ${msg}`,
      );
    });
    if (ok > 0) {
      toast.success(`Marked ${ok} renewal${ok === 1 ? '' : 's'}.`);
    }
    setBulkOpen(false);
    sel.clear();
    refresh();
  };

  const onExportCsv = () => {
    if (!data) return;
    const bucketRows = (bucket: string, items: ExpirationItem[]) =>
      items.map((i) => [
        bucket,
        i.associateName,
        i.associateEmail,
        i.qualificationName,
        i.qualificationCode,
        i.isCert ? 'Yes' : 'No',
        fmtDate(i.expiresAt),
        i.daysUntilExpiry,
      ]);
    downloadCsv(`expirations-${ymdLocal()}.csv`, [
      ['Bucket', 'Associate', 'Email', 'Qualification', 'Code', 'Cert', 'Expires', 'Days until expiry'],
      ...bucketRows('Expired', expired),
      ...bucketRows(`Due in ${data.days} days`, dueSoon),
      ...bucketRows('Due later (within 1 year)', dueLater),
    ]);
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="text-silver">Within:</span>
        <SegmentedControl
          ariaLabel="Expiry window"
          value={days}
          onChange={(v) => setDays(v)}
          options={[
            { value: 30 as const, label: '30d' },
            { value: 60 as const, label: '60d' },
            { value: 90 as const, label: '90d' },
          ]}
        />
        <span className="ml-4 text-silver">Type:</span>
        <SegmentedControl
          ariaLabel="Qualification type"
          value={filter}
          onChange={(v) => setFilter(v)}
          options={[
            { value: 'all' as const, label: 'All' },
            { value: 'cert' as const, label: 'Certs only' },
          ]}
        />
        <SearchInput
          className="w-full sm:w-72"
          wrapperClassName="w-full sm:ml-auto sm:w-auto"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search people or credentials"
          aria-label="Search expirations"
        />
        <Button
          size="sm"
          variant="secondary"
          onClick={onExportCsv}
          disabled={!data}
        >
          <Download className="mr-2 h-4 w-4" /> Export CSV
        </Button>
      </div>

      {loadError ? (
        <ErrorBanner
          action={
            <Button size="sm" variant="secondary" onClick={refresh}>
              Retry
            </Button>
          }
        >
          {loadError}
        </ErrorBanner>
      ) : data === null ? (
        <Card><CardContent><SkeletonRows count={5} /></CardContent></Card>
      ) : !q && data.counts.expired + data.counts.dueSoon + data.counts.dueLater === 0 ? (
        // Three empty grids said "nothing" three times: one state instead.
        <div className="space-y-4">
          <Card>
            <CardContent className="p-0">
              <EmptyState
                icon={Clock}
                title="Nothing expired or expiring within a year"
                description={
                  filter === 'cert'
                    ? 'No certification has lapsed or comes due in the next 365 days.'
                    : 'No credential has lapsed or comes due in the next 365 days. Credentials with an expiry date show here as they come due.'
                }
              />
            </CardContent>
          </Card>
          {showTransport && <TransportExpiringSection days={days} />}
        </div>
      ) : (
        <div className="space-y-4">
          <Bucket
            title="Expired"
            icon={AlertCircle}
            accent="text-alert"
            count={q ? expired.length : data.counts.expired}
            items={expired}
            emptyHint={q ? 'No matches.' : 'Nothing expired.'}
            canRenew={canRenew}
            onRenew={setRenewTarget}
            selection={canRenew ? sel : null}
          />
          <Bucket
            title={`Due in next ${data.days} days`}
            icon={ShieldAlert}
            accent="text-warning"
            count={q ? dueSoon.length : data.counts.dueSoon}
            items={dueSoon}
            emptyHint={q ? 'No matches.' : 'Nothing due soon.'}
            canRenew={canRenew}
            onRenew={setRenewTarget}
            selection={canRenew ? sel : null}
          />
          <Bucket
            title="Due later (within 1 year)"
            icon={Calendar}
            accent="text-gold"
            count={q ? dueLater.length : data.counts.dueLater}
            items={dueLater}
            emptyHint={q ? 'No matches.' : 'Nothing further out.'}
            canRenew={canRenew}
            onRenew={setRenewTarget}
            selection={canRenew ? sel : null}
          />
          {/* The fleet's papers and drivers' licences, kept in Transportation. */}
          {showTransport && <TransportExpiringSection days={days} />}
        </div>
      )}

      {/* Sticky bulk bar — appears with the first checked row. */}
      {canRenew && selectedItems.length > 0 && (
        <div className="sticky bottom-4 z-20 mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-navy-secondary bg-navy p-3 elev-2">
          <span className="text-sm text-silver tabular-nums">
            {selectedItems.length} selected
          </span>
          <Button size="sm" onClick={openBulk} disabled={bulkBusy}>
            Mark renewed ({selectedItems.length})…
          </Button>
          <Button size="sm" variant="ghost" onClick={sel.clear} disabled={bulkBusy}>
            Clear
          </Button>
        </div>
      )}

      <Dialog
        open={bulkOpen}
        onOpenChange={(open) => {
          if (!open && !bulkBusy) setBulkOpen(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mark {selectedItems.length} renewed</DialogTitle>
            <DialogDescription>
              Records each selected qualification as renewed today with the
              same new expiration date. Use the per-row drawer for a
              different date or an evidence reference.
            </DialogDescription>
          </DialogHeader>
          <div>
            <Label htmlFor="bulkExpiresAt">New expiration (all selected)</Label>
            <Input
              id="bulkExpiresAt"
              type="date"
              className="mt-1"
              value={bulkExpiresAt}
              onChange={(e) => setBulkExpiresAt(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setBulkOpen(false)}
              disabled={bulkBusy}
            >
              Cancel
            </Button>
            <Button onClick={bulkSubmit} loading={bulkBusy}>
              {bulkBusy ? 'Marking…' : 'Mark renewed'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {renewTarget && (
        <RenewDrawer
          // Remount per item — "Renew & next" swaps the target without
          // closing, and the date/evidence state must reset each time.
          key={renewTarget.id}
          item={renewTarget}
          onClose={() => setRenewTarget(null)}
          onSaved={(goNext) => {
            refresh();
            if (!goNext) {
              setRenewTarget(null);
              return;
            }
            // Chain to the next item in the same (visible) bucket,
            // wrapping past the end; the just-renewed one is excluded —
            // it's leaving the bucket.
            const bucket = [expired, dueSoon, dueLater].find((b) =>
              b.some((i) => i.id === renewTarget.id),
            );
            const rest = bucket
              ? bucket.filter((i) => i.id !== renewTarget.id)
              : [];
            if (rest.length === 0) {
              setRenewTarget(null);
              toast('That was the last one in this bucket.');
              return;
            }
            const idx = bucket!.findIndex((i) => i.id === renewTarget.id);
            setRenewTarget(rest[idx] ?? rest[0]);
          }}
        />
      )}
    </div>
  );
}

function Bucket({
  title,
  icon: Icon,
  accent,
  count,
  items,
  emptyHint,
  canRenew,
  onRenew,
  selection,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  accent: string;
  count: number;
  items: ExpirationItem[];
  emptyHint: string;
  canRenew: boolean;
  onRenew: (item: ExpirationItem) => void;
  selection: Selection | null;
}) {
  // The bucket keeps nothing of its own: the page owns the selection
  // (one choice spans every bucket, and the bulk renew reads it), the grid
  // draws the boxes, and the old 100-row truncation with its "Show all"
  // button is gone — the grid virtualizes a long bucket instead of hiding
  // most of it.
  const columns: GridColumn<ExpirationItem>[] = [
    {
      key: 'associate',
      header: 'Associate',
      accessor: (i) => i.associateName,
      sortable: true,
      primary: true,
      className: 'font-medium text-white',
      cell: (i) => <AssociateLink associateId={i.associateId}>{i.associateName}</AssociateLink>,
    },
    {
      key: 'email',
      header: 'Email',
      accessor: (i) => i.associateEmail,
      sortable: true,
      cardMeta: true,
      className: 'text-silver text-xs',
    },
    {
      key: 'qualification',
      header: 'Qualification',
      accessor: (i) => i.qualificationName,
      sortable: true,
      cardMeta: true,
      cell: (i) => (
        <div className="flex items-center gap-2">
          {i.qualificationName}
          {i.isCert && <Badge variant="accent">Cert</Badge>}
        </div>
      ),
    },
    {
      key: 'code',
      header: 'Code',
      accessor: (i) => i.qualificationCode,
      sortable: true,
      defaultHidden: true,
      className: 'font-mono text-xs',
    },
    {
      key: 'expires',
      header: 'Expires',
      accessor: (i) => i.expiresAt,
      sortable: true,
      searchable: false,
      className: 'whitespace-nowrap',
      cell: (i) => fmtDate(i.expiresAt),
    },
    {
      key: 'in',
      header: 'In',
      accessor: (i) => i.daysUntilExpiry,
      csv: (i) => (i.daysUntilExpiry < 0 ? `${-i.daysUntilExpiry}d ago` : `${i.daysUntilExpiry}d`),
      sortable: true,
      searchable: false,
      className: 'whitespace-nowrap tabular-nums',
      cell: (i) =>
        i.daysUntilExpiry < 0 ? (
          <span className="text-alert">{-i.daysUntilExpiry}d ago</span>
        ) : i.daysUntilExpiry < 30 ? (
          <span className="text-warning">{i.daysUntilExpiry}d</span>
        ) : (
          <span className="text-silver">{i.daysUntilExpiry}d</span>
        ),
    },
    ...(canRenew
      ? [
          {
            key: 'action',
            header: 'Action',
            accessor: () => null,
            searchable: false,
            csv: () => '',
            align: 'right' as const,
            stopRowClick: true,
            cell: (i: ExpirationItem) => (
              <Button size="sm" variant="ghost" onClick={() => onRenew(i)}>
                Renew
              </Button>
            ),
          } satisfies GridColumn<ExpirationItem>,
        ]
      : []),
  ];

  // An empty bucket is one line, not a card with an empty grid in it.
  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 px-4 py-3">
          <Icon className="h-4 w-4 text-silver" aria-hidden="true" />
          <span className="text-sm uppercase tracking-wider text-silver">{title}</span>
          <span className="text-sm text-silver/80">· {emptyHint}</span>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardContent className="p-0">
        <div className="px-4 pt-4 pb-2 flex items-center gap-2">
          <Icon className={`h-4 w-4 ${accent}`} />
          <div className="text-sm uppercase tracking-wider text-silver">
            {title}
          </div>
          <Badge variant="outline">{count}</Badge>
        </div>
        <div className="px-3 pb-3">
          <DataGrid<ExpirationItem>
            id={`expirations-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
            caption={`${title} — expiring qualifications`}
            rows={items}
            columns={columns}
            rowKey={(i) => i.id}
            search={false}
            urlState={false}
            exportCsv={{ filename: `expirations-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` }}
            onRowClick={canRenew ? onRenew : undefined}
            rowActionLabel={(i) => `Renew ${i.qualificationName} for ${i.associateName}`}
            selectable={
              selection
                ? { selection: { selected: selection.selected, onChange: selection.replace } }
                : undefined
            }
            empty={{ icon: Clock, title: emptyHint }}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function RenewDrawer({
  item,
  onClose,
  onSaved,
}: {
  item: ExpirationItem;
  onClose: () => void;
  /** goNext: advance to the next item in the bucket instead of closing. */
  onSaved: (goNext: boolean) => void;
}) {
  // Local-timezone defaults — toISOString() is UTC and pre-fills tomorrow's
  // date for evening users west of UTC.
  const today = ymdLocal();
  // Default new expiry to one year from today — typical cert renewal cycle.
  const oneYearOut = (() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() + 1);
    return ymdLocal(d);
  })();
  const [acquiredAt, setAcquiredAt] = useState(today);
  const [expiresAt, setExpiresAt] = useState(oneYearOut);
  const [evidenceKey, setEvidenceKey] = useState('');
  const [busy, setBusy] = useState(false);

  // Edited away from the defaults → guard dismissals behind the shared
  // "Discard your changes?" confirm.
  const dirty =
    acquiredAt !== today || expiresAt !== oneYearOut || evidenceKey.trim() !== '';

  const submit = async (goNext: boolean) => {
    if (!expiresAt) {
      toast.error('New expiration date is required.');
      return;
    }
    if (expiresAt <= acquiredAt) {
      toast.error('Expiration must be after acquired date.');
      return;
    }
    setBusy(true);
    try {
      await grantAssociateQual(item.associateId, {
        qualificationId: item.qualificationId,
        acquiredAt,
        expiresAt,
        evidenceKey: evidenceKey.trim() || null,
      });
      toast.success('Renewed.');
      onSaved(goNext);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      open={true}
      onOpenChange={(o) => !o && onClose()}
      confirmDiscard={() => dirty}
    >
      <DrawerHeader>
        <DrawerTitle>Renew {item.qualificationName}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div className="text-sm">
          <div className="text-silver">For</div>
          <div className="font-medium text-white">
            {/* New tab — a same-tab hop would throw away the dates and
                evidence reference mid-renewal. */}
            <AssociateLink associateId={item.associateId} newTab>
              {item.associateName}
            </AssociateLink>
          </div>
          <div className="text-xs text-silver">{item.associateEmail}</div>
        </div>
        <div className="text-sm border-t border-navy-secondary pt-3">
          <div className="text-silver">Currently expires</div>
          <div className="text-white">
            {fmtDate(item.expiresAt)}
            {item.daysUntilExpiry < 0 ? (
              <span className="text-alert ml-2">
                ({-item.daysUntilExpiry}d ago)
              </span>
            ) : (
              <span className="text-silver ml-2">
                (in {item.daysUntilExpiry}d)
              </span>
            )}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 pt-3 border-t border-navy-secondary">
          <div>
            <Label>Acquired (renewal date)</Label>
            <Input
              type="date"
              className="mt-1"
              value={acquiredAt}
              onChange={(e) => setAcquiredAt(e.target.value)}
            />
          </div>
          <div>
            <Label>New expiration</Label>
            <Input
              type="date"
              className="mt-1"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
            />
          </div>
        </div>
        <div>
          <Label>Evidence reference (optional)</Label>
          <Input
            className="mt-1"
            value={evidenceKey}
            onChange={(e) => setEvidenceKey(e.target.value)}
            placeholder="Document key, certificate number, file path…"
          />
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="secondary"
          onClick={() => void submit(false)}
          disabled={busy}
        >
          {busy ? 'Marking…' : 'Mark renewed'}
        </Button>
        {/* Chain through the bucket without reopening the drawer for
            every row — renewal season is dozens of these in a sitting. */}
        <Button onClick={() => void submit(true)} disabled={busy}>
          Renew &amp; next
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}
