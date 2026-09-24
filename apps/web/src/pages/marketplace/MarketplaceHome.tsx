import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AssociateLink } from '@/components/ui/AssociateLink';
import { Award, Briefcase, CalendarDays, RefreshCw } from 'lucide-react';
import { ApiError } from '@/lib/api';
import {
  claimShift,
  createQualification,
  deleteQualification,
  listOpenShifts,
  listPendingClaims,
  listQualifications,
  updateClaim,
  type OpenShiftListItem,
  type PendingClaim,
  type Qualification,
} from '@/lib/qualApi';
import { useAuth } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
import { useI18n } from '@/lib/i18n';
import { hasCapability } from '@/lib/roles';
import {
  Badge,
  Button,
  Card,
  CardContent,
  ConfirmDialog,
  Drawer,
  DrawerBody,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  EmptyState,
  ErrorBanner,
  FilterChip,
  Input,
  PageHeader,
  SkeletonRows,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui';
import { DataGrid } from '@/components/ui/DataGrid';
import { Label } from '@/components/ui/Label';
import {
  fmtDateTime,
  fmtMoneyEst,
  fmtPayRate,
  fmtRelativeDayTz,
  fmtShiftRangeTz,
  fmtTime,
  mapsUrl,
  parseYmd,
  zonedDayKey,
} from '@/lib/format';
import { cn } from '@/lib/cn';
import { enterStagger } from '@/lib/motion';
import { toast } from 'sonner';

type Tab = 'open' | 'claims' | 'catalog';

export function MarketplaceHome() {
  const { t } = useI18n();
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:scheduling') : false;
  // "Available" is the associate-side marketplace — it needs an associate
  // record to pick up shifts. Users without one (e.g. SHIFT_SUPERVISOR
  // accounts) got a red 403 banner there; hide the tab and land them on
  // the manager views instead.
  const canPickUp = !!user?.associateId;
  const [tab, setTab] = useState<Tab>(
    canManage || !canPickUp ? 'claims' : 'open',
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('mk.title')}
        subtitle={t('mk.subtitle')}
        breadcrumbs={[{ label: t('mk.crumbSection') }, { label: t('mk.title') }]}
      />

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        {/* An associate has one view — a lone "Available" tab was chrome. */}
        {canManage && (
          <TabsList>
            {canPickUp && <TabsTrigger value="open">{t('mk.tab.available')}</TabsTrigger>}
            <TabsTrigger value="claims">Pending claims</TabsTrigger>
            <TabsTrigger value="catalog">Qualifications</TabsTrigger>
          </TabsList>
        )}

        {canPickUp && (
          <TabsContent value="open"><AvailableTab /></TabsContent>
        )}
        {canManage && (
          <TabsContent value="claims"><ClaimsTab /></TabsContent>
        )}
        {canManage && (
          <TabsContent value="catalog"><CatalogTab /></TabsContent>
        )}
      </Tabs>
    </div>
  );
}

// ============ Available shifts ============

function AvailableTab() {
  const { t } = useI18n();
  const [rows, setRows] = useState<OpenShiftListItem[] | null>(null);
  // The card that just got claimed — plays the success flash once.
  const [flashId, setFlashId] = useState<string | null>(null);
  // The shift whose claim is in flight — its button goes into a loading
  // state and every other Claim button is disabled until it settles.
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [clientFilter, setClientFilter] = useState<Set<string>>(new Set());
  // Dates fold away until asked for — they used to be the first thing on
  // the page, above the shifts themselves.
  const [showDates, setShowDates] = useState(false);

  const refreshQuery = useQuery({
    queryKey: ['AvailableTab', 'rows'],
    queryFn: () => listOpenShifts(),
  });
  const loadError = refreshQuery.error ? refreshQuery.error instanceof ApiError ? refreshQuery.error.message : t('mk.loadFailed') : null;
  useEffect(() => {
    const r = refreshQuery.data;
    if (r === undefined) return;
    setRows(r.shifts)
  }, [refreshQuery.data]);
  const refresh = () => void refreshQuery.refetch();

  // Post-action refetch that keeps the current cards rendered (no
  // skeleton, no scroll loss) and reconciles in place when server truth
  // lands. Hard refresh stays for initial load / Retry / empty-state.
  const refetch = () => {
    listOpenShifts()
      .then((r) => setRows(r.shifts))
      .catch(() => {
        // Keep showing the current rows — the in-place update after the
        // action already reflects what changed.
      });
  };

  const clients = useMemo(
    () => (rows ? Array.from(new Set(rows.map((s) => s.clientName))).sort() : []),
    [rows],
  );

  const filtered = useMemo(() => {
    if (!rows) return null;
    const from = fromDate ? parseYmd(fromDate) : null;
    const to = toDate ? parseYmd(toDate) : null;
    return rows.filter((s) => {
      const startMs = new Date(s.startsAt).getTime();
      if (from && startMs < from.getTime()) return false;
      // Inclusive end date: anything before local midnight the day AFTER.
      if (to && startMs >= to.getTime() + 86_400_000) return false;
      if (clientFilter.size > 0 && !clientFilter.has(s.clientName)) return false;
      return true;
    });
  }, [rows, fromDate, toDate, clientFilter]);

  const toggleClient = (name: string) => {
    setClientFilter((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const onClaim = async (shiftId: string) => {
    // One claim in flight at a time. Without this, a double tap on a slow
    // connection fired two POSTs and the second one raced the first into a
    // unique-constraint error.
    if (claimingId) return;
    setClaimingId(shiftId);
    try {
      const r = await claimShift(shiftId);
      setFlashId(shiftId);
      toast.success(
        r.alreadyClaimed ? t('mk.claimAlready') : t('mk.claimSubmitted'),
      );
      // Flip the acted card to "Claim pending" in place instead of
      // collapsing the whole list to a skeleton.
      setRows((prev) =>
        prev
          ? prev.map((s) =>
              s.id === shiftId ? { ...s, myPendingClaim: r.id } : s,
            )
          : prev,
      );
      refetch();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('mk.failed'));
    } finally {
      setClaimingId(null);
    }
  };

  if (loadError) {
    return (
      <ErrorBanner>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span>{loadError}</span>
          <Button size="sm" variant="outline" onClick={refresh}>
            {t('mk.retry')}
          </Button>
        </div>
      </ErrorBanner>
    );
  }

  if (rows === null || filtered === null) {
    return <Card><CardContent className="p-6"><SkeletonRows count={3} /></CardContent></Card>;
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Briefcase}
        title={t('mk.emptyTitle')}
        description={t('mk.emptyDesc')}
        action={
          <Button variant="secondary" onClick={refresh}>
            <RefreshCw className="mr-2 h-4 w-4" /> {t('mk.refresh')}
          </Button>
        }
      />
    );
  }

  const hasFilters = fromDate !== '' || toDate !== '' || clientFilter.size > 0;

  // By day, the way My schedule reads: "Today", "Tomorrow", "Sun, Sep 21".
  const days: Array<{ key: string; label: string; shifts: OpenShiftListItem[] }> = [];
  for (const s of filtered) {
    const key = zonedDayKey(s.startsAt, null);
    const last = days[days.length - 1];
    if (last && last.key === key) last.shifts.push(s);
    else days.push({ key, label: fmtRelativeDayTz(s.startsAt, null), shifts: [s] });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-silver">
          {filtered.length === 1
            ? t('mk.shiftOne', { n: filtered.length })
            : t('mk.shiftMany', { n: filtered.length })}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {hasFilters && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setFromDate('');
                setToDate('');
                setClientFilter(new Set());
              }}
            >
              {t('mk.clearFilters')}
            </Button>
          )}
          <Button
            size="sm"
            variant={showDates || fromDate || toDate ? 'secondary' : 'outline'}
            onClick={() => setShowDates((v) => !v)}
            aria-expanded={showDates}
          >
            <CalendarDays className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            {t('mk.dates')}
          </Button>
        </div>
      </div>
      {(showDates || fromDate || toDate) && (
        <Card className="animate-enter">
          <CardContent className="grid grid-cols-2 gap-3 p-4">
            <div>
              <Label htmlFor="marketplace-from">{t('mk.from')}</Label>
              <Input
                id="marketplace-from"
                type="date"
                className="mt-1"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="marketplace-to">{t('mk.to')}</Label>
              <Input
                id="marketplace-to"
                type="date"
                className="mt-1"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
              />
            </div>
          </CardContent>
        </Card>
      )}
      {clients.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {clients.map((c) => (
            <FilterChip key={c} active={clientFilter.has(c)} onClick={() => toggleClient(c)}>
              {c}
            </FilterChip>
          ))}
        </div>
      )}
      {filtered.length === 0 ? (
        <EmptyState
          icon={Briefcase}
          title={t('mk.noMatchTitle')}
          description={t('mk.noMatchDesc')}
        />
      ) : (
        days.map((d) => (
          <section key={d.key} className="space-y-2">
            <h2 className="pt-1 text-sm font-medium text-gold">{d.label}</h2>
            {d.shifts.map((s, i) => {
              const hours = (new Date(s.endsAt).getTime() - new Date(s.startsAt).getTime()) / 3_600_000;
              const rate = s.payRate ? Number(s.payRate) : null;
              const worth = rate && hours > 0 ? rate * hours : null;
              return (
                <Card
                  key={s.id}
                  style={enterStagger(i)}
                  className={cn(
                    // Rows cascade in; a just-claimed card flashes its success
                    // in step with the toast (animate-* classes can't stack).
                    flashId === s.id ? 'animate-flash-success' : 'animate-enter',
                  )}
                >
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="text-lg font-semibold tabular-nums text-white">
                          {fmtShiftRangeTz(s.startsAt, s.endsAt, null)}
                        </div>
                        <div className="mt-0.5 text-sm text-white">{s.position}</div>
                        <div className="mt-0.5 text-sm text-silver">{s.clientName}</div>
                        {s.location && (
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-sm text-silver">
                            <span>{s.location}</span>
                            <a
                              href={mapsUrl([s.clientName, s.location].filter(Boolean).join(' '))}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center coarse:min-h-11 text-xs text-gold hover:text-gold-bright underline underline-offset-2"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {t('shift.directions')}
                            </a>
                          </div>
                        )}
                        {s.payRate && (
                          <div className="mt-1 text-sm text-success">
                            {fmtPayRate(s.payRate, 'HOURLY')}
                            {worth !== null && (
                              <span className="font-semibold text-gold">
                                {' '}· {t('sched.heroWorth', { amount: fmtMoneyEst(worth) })}
                              </span>
                            )}
                          </div>
                        )}
                        {s.requirements.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1">
                            {s.requirements.map((r) => (
                              <Badge key={r.id} variant="outline">
                                {r.code}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="shrink-0">
                        {s.myPendingClaim ? (
                          <Badge variant="pending">{t('mk.claimPending')}</Badge>
                        ) : (
                          <Button
                            onClick={() => onClaim(s.id)}
                            disabled={claimingId !== null}
                            loading={claimingId === s.id}
                          >
                            {claimingId === s.id ? t('mk.claiming') : t('mk.claim')}
                          </Button>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </section>
        ))
      )}
    </div>
  );
}

// ============ Claims (manager) ============

function ClaimsTab() {
  const [rows, setRows] = useState<PendingClaim[] | null>(null);
  const [rejectTarget, setRejectTarget] = useState<PendingClaim | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  const refreshQuery = useQuery({
    queryKey: ['ClaimsTab', 'rows'],
    queryFn: () => listPendingClaims(),
  });
  const loadError = refreshQuery.error ? refreshQuery.error instanceof ApiError ? refreshQuery.error.message : 'Failed to load pending claims.' : null;
  useEffect(() => {
    const r = refreshQuery.data;
    if (r === undefined) return;
    setRows(r.claims)
  }, [refreshQuery.data]);
  const refresh = () => void refreshQuery.refetch();

  // Post-action refetch: keep the table (and the manager's scroll/selection)
  // in place, reconcile with server truth when it lands, and prune the
  // selection to rows that still exist.
  const refetch = () => {
    listPendingClaims()
      .then((r) => {
        setRows(r.claims);
        setSelected((prev) => {
          const ids = new Set(r.claims.map((c) => c.id));
          return new Set(Array.from(prev).filter((id) => ids.has(id)));
        });
      })
      .catch(() => {
        toast.error('Could not refresh pending claims.');
      });
  };

  // Optimistically drop acted rows (approved/rejected claims leave the
  // pending queue) and clear ONLY them from the selection.
  const dropRows = (ids: string[]) => {
    const drop = new Set(ids);
    setRows((prev) => (prev ? prev.filter((c) => !drop.has(c.id)) : prev));
    setSelected((prev) => new Set(Array.from(prev).filter((id) => !drop.has(id))));
  };

  const sorted = useMemo(
    () =>
      rows
        ? [...rows].sort(
            (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
          )
        : null,
    [rows],
  );

  const approve = async (c: PendingClaim) => {
    setBusyId(c.id);
    try {
      await updateClaim(c.shiftId, c.id, 'APPROVED', null);
      toast.success('Claim approved.');
      dropRows([c.id]);
      refetch();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setBusyId(null);
    }
  };

  const bulkApprove = async () => {
    if (!sorted) return;
    const targets = sorted.filter((c) => selected.has(c.id));
    if (targets.length === 0) return;
    setBulkBusy(true);
    const results = await Promise.allSettled(
      targets.map((c) => updateClaim(c.shiftId, c.id, 'APPROVED', null)),
    );
    setBulkBusy(false);
    const okIds = targets
      .filter((_, i) => results[i].status === 'fulfilled')
      .map((c) => c.id);
    const failed = results.length - okIds.length;
    if (okIds.length > 0)
      toast.success(`Approved ${okIds.length} claim${okIds.length === 1 ? '' : 's'}.`);
    if (failed > 0) toast.error(`${failed} approval${failed === 1 ? '' : 's'} failed.`);
    // Failed rows stay selected so the manager can retry just those.
    dropRows(okIds);
    refetch();
  };

  return (
    <Card>
      <CardContent className="p-0">
        {loadError ? (
          <div className="p-6">
            <ErrorBanner>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>{loadError}</span>
                <Button size="sm" variant="outline" onClick={refresh}>
                  Retry
                </Button>
              </div>
            </ErrorBanner>
          </div>
        ) : sorted === null ? (
          <div className="p-6"><SkeletonRows count={3} /></div>
        ) : sorted.length === 0 ? (
          <EmptyState
            title="No pending claims"
            description="Claims show up here when associates pick up open shifts."
          />
        ) : (
          <>
            {selected.size > 0 && (
              <div className="flex items-center justify-between gap-2 p-3 border-b border-navy-secondary">
                <div className="text-sm text-silver">
                  {selected.size} selected
                </div>
                <Button size="sm" onClick={bulkApprove} disabled={bulkBusy}>
                  {bulkBusy ? 'Approving…' : `Approve ${selected.size}`}
                </Button>
              </div>
            )}
            <DataGrid<NonNullable<typeof sorted>[number]>
              id="marketplace-claims"
              caption="Shift claims to decide"
              rows={sorted}
              rowKey={(c) => c.id}
              search={{ placeholder: 'Associate, client, position…' }}
              urlState={false}
              exportCsv={{ filename: 'shift-claims' }}
              selectable={{ selection: { selected, onChange: setSelected } }}
              columns={[
                {
                  key: 'associate',
                  header: 'Associate',
                  accessor: (c) => c.associateName,
                  sortable: true,
                  primary: true,
                  className: 'font-medium text-white',
                  cell: (c) => (
                    <div className="truncate">
                      <AssociateLink associateId={c.associateId}>{c.associateName}</AssociateLink>
                    </div>
                  ),
                },
                { key: 'position', header: 'Position', accessor: (c) => c.position, sortable: true, cardMeta: true },
                { key: 'client', header: 'Client', accessor: (c) => c.clientName, sortable: true, cardMeta: true },
                {
                  key: 'shift',
                  header: 'Shift',
                  accessor: (c) => c.startsAt,
                  csv: (c) => `${fmtDateTime(c.startsAt)} – ${fmtTime(c.endsAt)}`,
                  sortable: true,
                  searchable: false,
                  cardMeta: true,
                  className: 'tabular-nums',
                  cell: (c) => (
                    <>
                      {fmtDateTime(c.startsAt)} – {fmtTime(c.endsAt)}
                    </>
                  ),
                },
                {
                  key: 'decide',
                  header: 'Decide',
                  accessor: () => null,
                  searchable: false,
                  csv: () => '',
                  align: 'right',
                  stopRowClick: true,
                  width: '11rem',
                  cell: (c) => (
                    <div className="inline-flex gap-1">
                      <Button size="sm" variant="secondary" onClick={() => approve(c)} disabled={busyId === c.id || bulkBusy}>
                        Approve
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setRejectTarget(c)} disabled={busyId === c.id || bulkBusy}>
                        Reject
                      </Button>
                    </div>
                  ),
                },
              ]}
            />
          </>
        )}
      </CardContent>
      <ConfirmDialog
        open={rejectTarget !== null}
        onOpenChange={(o) => !o && setRejectTarget(null)}
        title="Reject claim"
        description={
          rejectTarget
            ? `Reject ${rejectTarget.associateName}'s claim on ${rejectTarget.position}?`
            : undefined
        }
        confirmLabel="Reject"
        destructive
        requireReason="optional"
        reasonLabel="Reason (visible to associate)"
        reasonPlaceholder="Optional"
        busy={busyId === rejectTarget?.id}
        onConfirm={async (reason) => {
          if (!rejectTarget) return;
          setBusyId(rejectTarget.id);
          try {
            await updateClaim(
              rejectTarget.shiftId,
              rejectTarget.id,
              'REJECTED',
              reason || null,
            );
            toast.success('Claim rejected.');
            dropRows([rejectTarget.id]);
            setRejectTarget(null);
            refetch();
          } catch (err) {
            toast.error(err instanceof ApiError ? err.message : 'Failed.');
          } finally {
            setBusyId(null);
          }
        }}
      />
    </Card>
  );
}

// ============ Catalog ============

/** FORKLIFT-style code from a display name: uppercase, runs of non-alphanumerics
 *  collapse to a single underscore, trimmed at both ends. */
function deriveCode(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function CatalogTab() {
  const confirm = useConfirm();
  const { user } = useAuth();
  /**
   * A global qualification belongs to the org, not to any one client, so a
   * client-bounded role may USE it (attach it to their shifts) and not edit
   * it — the server enforces that. Offering them a Delete button whose only
   * outcome is "Qualification not found." would read as the app being
   * broken rather than as a boundary.
   */
  const boundedToOneClient =
    user?.role === 'SHIFT_SUPERVISOR' ||
    user?.role === 'FLOOR_SUPERVISOR' ||
    user?.role === 'CLIENT_PORTAL';
  const canDelete = (q: Qualification) =>
    !boundedToOneClient || (q.clientId != null && q.clientId === user?.clientId);
  const [showNew, setShowNew] = useState(false);
  const [code, setCode] = useState('');
  const [codeTouched, setCodeTouched] = useState(false);
  const [name, setName] = useState('');
  const [isCert, setIsCert] = useState(false);
  const [description, setDescription] = useState('');

  const refreshQuery = useQuery({
    queryKey: ['CatalogTab', 'rows'],
    queryFn: () => listQualifications(),
  });
  const rows: Qualification[] | null = refreshQuery.data?.qualifications ?? null;
  const loadError = refreshQuery.error ? refreshQuery.error instanceof ApiError ? refreshQuery.error.message : 'Failed to load qualifications.' : null;
  const refresh = () => void refreshQuery.refetch();

  const onSave = async () => {
    if (!code.trim() || !name.trim()) {
      toast.error('Code and name required.');
      return;
    }
    try {
      await createQualification({
        code: code.trim(),
        name: name.trim(),
        description: description.trim() || null,
        isCert,
      });
      toast.success('Qualification added.');
      setShowNew(false);
      setCode('');
      setCodeTouched(false);
      setName('');
      setIsCert(false);
      setDescription('');
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    }
  };

  const onDelete = async (id: string) => {
    if (!(await confirm({ title: 'Delete this qualification?', destructive: true }))) return;
    try {
      await deleteQualification(id);
      toast.success('Qualification deleted.');
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setShowNew(true)}>New qualification</Button>
      </div>
      <Card>
        <CardContent className="p-0">
          {loadError ? (
            <div className="p-6">
              <ErrorBanner>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>{loadError}</span>
                  <Button size="sm" variant="outline" onClick={refresh}>
                    Retry
                  </Button>
                </div>
              </ErrorBanner>
            </div>
          ) : rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={Award}
              title="No qualifications"
              description="Define the badges, certs, and skills the marketplace can match shifts against."
              action={
                <Button onClick={() => setShowNew(true)}>New qualification</Button>
              }
            />
          ) : (
            <DataGrid<NonNullable<typeof rows>[number]>
              id="qualifications"
              caption="Qualifications"
              rows={rows}
              rowKey={(q) => q.id}
              search={{ placeholder: 'Code, name…' }}
              urlState={false}
              exportCsv={{ filename: 'qualifications' }}
              columns={[
                { key: 'code', header: 'Code', accessor: (q) => q.code, sortable: true, primary: true, className: 'font-mono text-xs' },
                { key: 'name', header: 'Name', accessor: (q) => q.name, sortable: true, cardMeta: true, className: 'text-white' },
                { key: 'cert', header: 'Cert', accessor: (q) => (q.isCert ? 'Cert' : ''), sortable: true, searchable: false, cell: (q) => (q.isCert ? <Badge variant="accent">Cert</Badge> : '—') },
                { key: 'scope', header: 'Scope', accessor: (q) => (q.clientId ? 'Client-scoped' : 'Global'), sortable: true, cardMeta: true },
                {
                  key: 'action',
                  header: 'Action',
                  accessor: () => null,
                  searchable: false,
                  csv: () => '',
                  align: 'right',
                  stopRowClick: true,
                  width: '6rem',
                  cell: (q) =>
                    canDelete(q) ? (
                      <Button size="sm" variant="ghost" onClick={() => onDelete(q.id)}>
                        Delete
                      </Button>
                    ) : (
                      <span className="text-xs2 text-silver/70">—</span>
                    ),
                },
              ]}
            />
          )}
        </CardContent>
      </Card>
      <Drawer
        open={showNew}
        onOpenChange={setShowNew}
        confirmDiscard={() =>
          name.trim() !== '' || code.trim() !== '' || description.trim() !== '' || isCert
        }
      >
        <DrawerHeader>
          <DrawerTitle>New qualification</DrawerTitle>
        </DrawerHeader>
        <DrawerBody className="space-y-4">
          <div>
            <Label>Name</Label>
            <Input
              className="mt-1"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (!codeTouched) setCode(deriveCode(e.target.value));
              }}
              placeholder="Forklift certification"
            />
          </div>
          <div>
            <Label>Code</Label>
            <Input
              className="mt-1 font-mono"
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
                // An emptied code re-arms auto-derive from the name.
                setCodeTouched(e.target.value !== '');
              }}
              placeholder="FORKLIFT"
            />
            <div className="mt-1 text-xs text-silver">
              Auto-derived from the name; edit to override.
            </div>
          </div>
          <div>
            <Label>Description (optional)</Label>
            <Input
              className="mt-1"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-white">
            <input
              type="checkbox"
              checked={isCert}
              onChange={(e) => setIsCert(e.target.checked)}
            />
            This is an expiring certification (drives compliance alerts)
          </label>
        </DrawerBody>
        <DrawerFooter>
          <Button variant="ghost" onClick={() => setShowNew(false)}>
            Cancel
          </Button>
          <Button onClick={onSave}>Save</Button>
        </DrawerFooter>
      </Drawer>
    </div>
  );
}
