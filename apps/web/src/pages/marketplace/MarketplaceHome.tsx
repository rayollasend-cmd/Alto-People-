import { useEffect, useMemo, useState } from 'react';
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
import { fmtDateTime, fmtPayRate, fmtTime, parseYmd } from '@/lib/format';
import { toast } from 'sonner';

type Tab = 'open' | 'claims' | 'catalog';

export function MarketplaceHome() {
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:scheduling') : false;
  const [tab, setTab] = useState<Tab>(canManage ? 'claims' : 'open');

  return (
    <div className="space-y-5">
      <PageHeader
        title="Open shifts"
        subtitle="Marketplace of OPEN shifts you're qualified to pick up. Managers approve claims."
        breadcrumbs={[{ label: 'Time & Pay' }, { label: 'Open shifts' }]}
      />

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="open">Available</TabsTrigger>
          {canManage && <TabsTrigger value="claims">Pending claims</TabsTrigger>}
          {canManage && <TabsTrigger value="catalog">Qualifications</TabsTrigger>}
        </TabsList>

        <TabsContent value="open"><AvailableTab /></TabsContent>
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
          err instanceof ApiError ? err.message : 'Failed to load open shifts.',
        ),
      );
  };
  useEffect(() => {
    refresh();
  }, []);

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
      await claimShift(shiftId);
      toast.success('Claim submitted; awaiting manager approval.');
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    }
  };

  if (loadError) {
    return (
      <Card>
        <CardContent className="p-6 space-y-3">
          <p role="alert" className="text-sm text-alert">{loadError}</p>
          <Button size="sm" variant="secondary" onClick={refresh}>
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (rows === null || filtered === null) {
    return <Card><CardContent className="p-6"><SkeletonRows count={3} /></CardContent></Card>;
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Briefcase}
        title="No open shifts"
        description="When new shifts get published, ones you're qualified for show up here."
        action={
          <Button variant="secondary" onClick={refresh}>
            <RefreshCw className="mr-2 h-4 w-4" /> Refresh
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
              <Label htmlFor="marketplace-from">From</Label>
              <Input
                id="marketplace-from"
                type="date"
                className="mt-1"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="marketplace-to">To</Label>
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
                Clear filters
              </Button>
            )}
            <div className="ml-auto text-sm text-silver self-center">
              {filtered.length} shift{filtered.length === 1 ? '' : 's'}
            </div>
          </div>
          {clients.length > 1 && (
            <div className="flex flex-wrap gap-2">
              {clients.map((c) => (
                <Button
                  key={c}
                  size="sm"
                  variant={clientFilter.has(c) ? 'secondary' : 'ghost'}
                  aria-pressed={clientFilter.has(c)}
                  onClick={() => toggleClient(c)}
                >
                  {c}
                </Button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      {filtered.length === 0 ? (
        <EmptyState
          icon={Briefcase}
          title="No shifts match"
          description="No open shift falls inside the current date range or client filter."
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
                    <div className="text-sm text-silver mt-0.5">{s.location}</div>
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
                    <Badge variant="pending">Claim pending</Badge>
                  ) : (
                    <Button onClick={() => onClaim(s.id)}>Claim</Button>
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
      refresh();
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
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.length - ok;
    if (ok > 0) toast.success(`Approved ${ok} claim${ok === 1 ? '' : 's'}.`);
    if (failed > 0) toast.error(`${failed} approval${failed === 1 ? '' : 's'} failed.`);
    refresh();
  };

  return (
    <Card>
      <CardContent className="p-0">
        {loadError ? (
          <div className="p-6 space-y-3">
            <p role="alert" className="text-sm text-alert">{loadError}</p>
            <Button size="sm" variant="secondary" onClick={refresh}>
              Retry
            </Button>
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
                      <div className="truncate">{c.associateName}</div>
                      <div className="md:hidden text-[11px] text-silver/70 truncate">
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
            setRejectTarget(null);
            refresh();
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
            <div className="p-6 space-y-3">
              <p role="alert" className="text-sm text-alert">{loadError}</p>
              <Button size="sm" variant="secondary" onClick={refresh}>
                Retry
              </Button>
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
                      <div className="md:hidden text-[11px] text-silver/70 truncate font-sans">
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
      <Drawer open={showNew} onOpenChange={setShowNew}>
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
