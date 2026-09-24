import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
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
import { useAuth } from '@/lib/auth';
import { hasCapability } from '@/lib/roles';
import { usePersistentState } from '@/lib/usePersistentState';
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
  Input,
  PageHeader,
  SegmentedControl,
  SkeletonRows,
} from '@/components/ui';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { SearchInput } from '@/components/ui/FilterBar';
import { Label } from '@/components/ui/Label';
import { fmtDate, ymdLocal } from '@/lib/format';

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
export function ExpirationsHome() {
  const { user } = useAuth();
  const canRenew = user
    ? hasCapability(user.role, 'manage:scheduling')
    : false;
  const [loadError, setLoadError] = useState<string | null>(null);
  const [days, setDays] = usePersistentState<30 | 60 | 90>(
    'alto:list.expirations.days.v1',
    60,
    (v): v is 30 | 60 | 90 => v === 30 || v === 60 || v === 90,
  );
  const [filter, setFilter] = usePersistentState<'all' | 'cert'>(
    'alto:list.expirations.type.v1',
    'all',
    (v): v is 'all' | 'cert' => v === 'all' || v === 'cert',
  );
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
      <PageHeader
        title="Expirations"
        subtitle="Qualifications and certifications expiring soon — chase renewals before they lapse."
        breadcrumbs={[{ label: 'Expirations' }]}
      />
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
          className="w-64"
          wrapperClassName="ml-auto"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search associate or qualification…"
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
          {i.isCert && <Badge variant="accent">cert</Badge>}
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
