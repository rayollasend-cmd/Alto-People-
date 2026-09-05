import { useEffect, useMemo, useState } from 'react';
import { AssociateLink } from '@/components/ui/AssociateLink';
import { Award, Briefcase, RefreshCw } from 'lucide-react';
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui';
import { Label } from '@/components/ui/Label';
import { fmtDateTime, fmtPayRate, fmtTime, mapsUrl, parseYmd } from '@/lib/format';
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
        <TabsList>
          {canPickUp && <TabsTrigger value="open">{t('mk.tab.available')}</TabsTrigger>}
          {canManage && <TabsTrigger value="claims">Pending claims</TabsTrigger>}
          {canManage && <TabsTrigger value="catalog">Qualifications</TabsTrigger>}
        </TabsList>

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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [clientFilter, setClientFilter] = useState<Set<string>>(new Set());

  const refresh = () => {
    setRows(null);
    setLoadError(null);
    listOpenShifts()
      .then((r) => setRows(r.shifts))
      .catch((err) =>
        setLoadError(
          err instanceof ApiError ? err.message : t('mk.loadFailed'),
        ),
      );
  };
  useEffect(() => {
    refresh();
  }, []);

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
    try {
      const r = await claimShift(shiftId);
      toast.success(t('mk.claimSubmitted'));
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

  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-wrap items-end gap-3">
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
            <div className="ml-auto text-sm text-silver self-center">
              {filtered.length === 1
                ? t('mk.shiftOne', { n: filtered.length })
                : t('mk.shiftMany', { n: filtered.length })}
            </div>
          </div>
          {clients.length > 1 && (
            <div className="flex flex-wrap gap-2">
              {clients.map((c) => (
                <FilterChip
                  key={c}
                  active={clientFilter.has(c)}
                  onClick={() => toggleClient(c)}
                >
                  {c}
                </FilterChip>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      {filtered.length === 0 ? (
        <EmptyState
          icon={Briefcase}
          title={t('mk.noMatchTitle')}
          description={t('mk.noMatchDesc')}
        />
      ) : (
        filtered.map((s) => (
          <Card key={s.id}>
            <CardContent className="p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-white font-medium">{s.position}</div>
                  <div className="text-sm text-silver mt-0.5">{s.clientName}</div>
                  <div className="text-sm text-silver mt-0.5">
                    {fmtDateTime(s.startsAt)} –{' '}
                    {fmtTime(s.endsAt)}
                  </div>
                  {s.location && (
                    <div className="flex flex-wrap items-center gap-x-2 text-sm text-silver mt-0.5">
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
                    <div className="text-sm text-success mt-0.5">
                      {fmtPayRate(s.payRate, 'HOURLY')}
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
                <div>
                  {s.myPendingClaim ? (
                    <Badge variant="pending">{t('mk.claimPending')}</Badge>
                  ) : (
                    <Button onClick={() => onClaim(s.id)}>{t('mk.claim')}</Button>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}

// ============ Claims (manager) ============

function ClaimsTab() {
  const [rows, setRows] = useState<PendingClaim[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rejectTarget, setRejectTarget] = useState<PendingClaim | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  const refresh = () => {
    setRows(null);
    setLoadError(null);
    setSelected(new Set());
    listPendingClaims()
      .then((r) => setRows(r.claims))
      .catch((err) =>
        setLoadError(
          err instanceof ApiError ? err.message : 'Failed to load pending claims.',
        ),
      );
  };
  useEffect(() => {
    refresh();
  }, []);

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

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allSelected =
    sorted !== null && sorted.length > 0 && selected.size === sorted.length;

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
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8">
                    <input
                      type="checkbox"
                      aria-label="Select all claims"
                      checked={allSelected}
                      onChange={() =>
                        setSelected(
                          allSelected
                            ? new Set()
                            : new Set(sorted.map((c) => c.id)),
                        )
                      }
                    />
                  </TableHead>
                  <TableHead>Associate</TableHead>
                  <TableHead className="hidden md:table-cell">Position</TableHead>
                  <TableHead className="hidden md:table-cell">Client</TableHead>
                  <TableHead>Shift</TableHead>
                  <TableHead className="text-right w-44">Decide</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <input
                        type="checkbox"
                        aria-label={`Select claim by ${c.associateName}`}
                        checked={selected.has(c.id)}
                        onChange={() => toggleSelected(c.id)}
                      />
                    </TableCell>
                    <TableCell className="font-medium text-white">
                      <div className="truncate">
                        <AssociateLink associateId={c.associateId}>{c.associateName}</AssociateLink>
                      </div>
                      <div className="md:hidden text-xs2 text-silver/70 truncate">
                        {c.position}
                        {' · '}
                        {c.clientName}
                      </div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">{c.position}</TableCell>
                    <TableCell className="hidden md:table-cell">{c.clientName}</TableCell>
                    <TableCell>
                      {fmtDateTime(c.startsAt)} –{' '}
                      {fmtTime(c.endsAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="inline-flex gap-1">
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => approve(c)}
                          disabled={busyId === c.id || bulkBusy}
                        >
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setRejectTarget(c)}
                          disabled={busyId === c.id || bulkBusy}
                        >
                          Reject
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
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
  const [rows, setRows] = useState<Qualification[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [code, setCode] = useState('');
  const [codeTouched, setCodeTouched] = useState(false);
  const [name, setName] = useState('');
  const [isCert, setIsCert] = useState(false);
  const [description, setDescription] = useState('');

  const refresh = () => {
    setRows(null);
    setLoadError(null);
    listQualifications()
      .then((r) => setRows(r.qualifications))
      .catch((err) =>
        setLoadError(
          err instanceof ApiError ? err.message : 'Failed to load qualifications.',
        ),
      );
  };
  useEffect(() => {
    refresh();
  }, []);

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
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead className="hidden md:table-cell">Cert</TableHead>
                  <TableHead className="hidden md:table-cell">Scope</TableHead>
                  <TableHead className="w-24 text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((q) => (
                  <TableRow key={q.id}>
                    <TableCell className="font-mono text-xs">
                      <div className="truncate">{q.code}</div>
                      <div className="md:hidden text-xs2 text-silver/70 truncate font-sans">
                        {q.clientId ? 'Client-scoped' : 'Global'}
                        {q.isCert ? ' · Cert' : ''}
                      </div>
                    </TableCell>
                    <TableCell className="text-white">{q.name}</TableCell>
                    <TableCell className="hidden md:table-cell">{q.isCert ? <Badge variant="accent">Cert</Badge> : '—'}</TableCell>
                    <TableCell className="hidden md:table-cell">{q.clientId ? 'Client-scoped' : 'Global'}</TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="ghost" onClick={() => onDelete(q.id)}>
                        Delete
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
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
