import { useEffect, useMemo, useState } from 'react';
import { Download, Plus, Trash2 } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { useClients } from '@/lib/useClients';
import { downloadCsv } from '@/lib/csv';
import {
  fmtDate,
  fmtMoney,
  fmtPayRate,
  fmtPercent,
  parseYmd,
  ymdLocal,
} from '@/lib/format';
import {
  applyCycle,
  createBand,
  createCycle,
  deleteBand,
  listBands,
  listCycles,
  listProposals,
  seedCycle,
  updateBand,
  updateProposal,
  type CompBand,
  type MeritCycle,
  type MeritCycleStatus,
  type MeritProposal,
  type MeritProposalStatus,
  type PayType,
} from '@/lib/compApi';
import { useAuth } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
import { hasCapability } from '@/lib/roles';
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
  FilterChip,
  Input,
  PageHeader,
  Select,
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
import { toast } from 'sonner';

type Tab = 'bands' | 'cycles';

/** Date-only "YYYY-MM-DD" → "May 13, 2026" without the UTC-midnight shift. */
const fmtYmd = (s: string | null | undefined) => fmtDate(parseYmd(s));

const PAY_TYPE_LABELS: Record<PayType, string> = {
  HOURLY: 'Hourly',
  SALARY: 'Salary',
};

const CYCLE_STATUS_LABELS: Record<MeritCycleStatus, string> = {
  DRAFT: 'Draft',
  OPEN: 'Open',
  APPLIED: 'Applied',
  CLOSED: 'Closed',
};

const PROPOSAL_STATUS_LABELS: Record<MeritProposalStatus, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  APPLIED: 'Applied',
};

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

export function CompensationHome() {
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:comp') : false;

  // Shared react-query cache — fetched at most once per 5 minutes app-wide.
  const {
    clients,
    isError: clientsError,
    refetch: refetchClients,
  } = useClients();
  const [clientId, setClientId] = useState<string>('');
  const [tab, setTab] = useState<Tab>('bands');

  useEffect(() => {
    if (clients.length > 0) {
      setClientId((prev) => prev || clients[0].id);
    }
  }, [clients]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Compensation"
        subtitle="Pay bands tied to job profiles, effective-dated history, and merit-cycle planning."
        breadcrumbs={[{ label: 'Time & Pay' }, { label: 'Compensation' }]}
      />

      <Card>
        <CardContent className="p-4 flex items-center gap-3 flex-wrap">
          <label
            htmlFor="comp-client"
            className="text-xs2 uppercase tracking-wider text-silver"
          >
            Client
          </label>
          <Select
            id="comp-client"
            size="sm"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
          >
            {clients.length === 0 && <option value="">—</option>}
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
          {clientsError && (
            <ErrorBanner
              className="flex-1 min-w-[16rem]"
              action={
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void refetchClients()}
                >
                  Retry
                </Button>
              }
            >
              Could not load the client list.
            </ErrorBanner>
          )}
        </CardContent>
      </Card>

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="bands">Pay bands</TabsTrigger>
          <TabsTrigger value="cycles">Merit cycles</TabsTrigger>
        </TabsList>

        <TabsContent value="bands">
          {clientId ? (
            <BandsTab clientId={clientId} canManage={canManage} />
          ) : (
            <Card>
              <CardContent className="p-6 text-sm text-silver">
                Choose a client to view its pay bands.
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="cycles">
          {clientId ? (
            <CyclesTab clientId={clientId} canManage={canManage} />
          ) : (
            <Card>
              <CardContent className="p-6 text-sm text-silver">
                Choose a client to view its merit cycles.
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ============ Bands ============

type BandDraft = {
  id?: string;
  name: string;
  level: string;
  payType: PayType;
  minAmount: string;
  midAmount: string;
  maxAmount: string;
};

function BandsTab({ clientId, canManage }: { clientId: string; canManage: boolean }) {
  const confirm = useConfirm();
  const [rows, setRows] = useState<CompBand[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<BandDraft | null>(null);

  const refresh = async () => {
    setRows(null);
    setError(null);
    try {
      const r = await listBands(clientId);
      setRows(r.bands);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load pay bands.');
    }
  };
  useEffect(() => {
    refresh();
  }, [clientId]);

  const q = search.trim().toLowerCase();
  const filtered = (rows ?? []).filter(
    (b) =>
      q === '' ||
      b.name.toLowerCase().includes(q) ||
      (b.level ?? '').toLowerCase().includes(q) ||
      (b.jobProfileTitle ?? '').toLowerCase().includes(q),
  );

  const exportCsv = () => {
    downloadCsv(`pay-bands-${ymdLocal()}.csv`, [
      ['Name', 'Job profile', 'Level', 'Pay type', 'Min', 'Mid', 'Max'],
      ...filtered.map((b) => [
        b.name,
        b.jobProfileTitle ?? '',
        b.level ?? '',
        PAY_TYPE_LABELS[b.payType],
        b.minAmount,
        b.midAmount,
        b.maxAmount,
      ]),
    ]);
  };

  const onDelete = async (id: string) => {
    if (!(await confirm({ title: 'Delete this pay band?', destructive: true }))) return;
    try {
      await deleteBand(id);
      toast.success('Band deleted.');
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not delete the band.');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <Input
          className="h-8 w-56 text-sm"
          placeholder="Search bands…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search pay bands"
        />
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={exportCsv}
            disabled={filtered.length === 0}
          >
            <Download className="mr-2 h-4 w-4" /> Export CSV
          </Button>
          {canManage && (
            <Button
              size="sm"
              onClick={() =>
                setDraft({
                  name: '',
                  level: '',
                  payType: 'HOURLY',
                  minAmount: '',
                  midAmount: '',
                  maxAmount: '',
                })
              }
            >
              <Plus className="mr-2 h-4 w-4" /> New band
            </Button>
          )}
        </div>
      </div>
      <Card>
        <CardContent className="p-0">
          {error !== null ? (
            <LoadError message={error} onRetry={refresh} />
          ) : rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              title="No pay bands"
              description="Define minimum / midpoint / maximum pay for each role so HR can see where in band each associate sits."
            />
          ) : filtered.length === 0 ? (
            <EmptyState
              title="No bands match"
              description="No pay bands match your search."
              action={
                <Button size="sm" variant="secondary" onClick={() => setSearch('')}>
                  Clear search
                </Button>
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead className="hidden md:table-cell">Job profile</TableHead>
                  <TableHead className="hidden md:table-cell">Level</TableHead>
                  <TableHead className="hidden lg:table-cell">Type</TableHead>
                  <TableHead>Range</TableHead>
                  <TableHead className="w-32 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((b) => (
                  <TableRow
                    key={b.id}
                    className="group cursor-pointer"
                    onClick={() => {
                      if (!canManage) return;
                      setDraft({
                        id: b.id,
                        name: b.name,
                        level: b.level ?? '',
                        payType: b.payType,
                        minAmount: b.minAmount,
                        midAmount: b.midAmount,
                        maxAmount: b.maxAmount,
                      });
                    }}
                  >
                    <TableCell className="font-medium text-white">
                      <div className="truncate">{b.name}</div>
                      <div className="md:hidden text-xs2 text-silver/70 truncate">
                        {b.jobProfileTitle ?? '—'}{b.level ? ` · ${b.level}` : ''}
                      </div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">{b.jobProfileTitle ?? '—'}</TableCell>
                    <TableCell className="hidden md:table-cell">{b.level ?? '—'}</TableCell>
                    <TableCell className="hidden lg:table-cell">{PAY_TYPE_LABELS[b.payType]}</TableCell>
                    <TableCell className="tabular-nums">
                      {fmtMoney(b.minAmount)} · {fmtMoney(b.midAmount)} · {fmtMoney(b.maxAmount)}
                    </TableCell>
                    <TableCell className="text-right">
                      {canManage && (
                        <button
                          data-no-row-click
                          onClick={(e) => {
                            e.stopPropagation();
                            onDelete(b.id);
                          }}
                          className="opacity-60 group-hover:opacity-100 text-silver hover:text-alert transition"
                        >
                          <Trash2 className="h-4 w-4 inline" />
                        </button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <Drawer open={draft !== null} onOpenChange={(o) => !o && setDraft(null)}>
        {draft && (
          <BandDrawer
            clientId={clientId}
            draft={draft}
            setDraft={setDraft}
            onClose={() => setDraft(null)}
            onSaved={() => {
              setDraft(null);
              refresh();
            }}
          />
        )}
      </Drawer>
    </div>
  );
}

function BandDrawer({
  clientId,
  draft,
  setDraft,
  onClose,
  onSaved,
}: {
  clientId: string;
  draft: BandDraft;
  setDraft: (d: BandDraft) => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [saving, setSaving] = useState(false);
  // Mid auto-fills to (min+max)/2 until the user edits it themselves.
  // Editing an existing band counts as "touched" — never clobber saved mids.
  const [midTouched, setMidTouched] = useState(Boolean(draft.id));

  const autoMid = (next: BandDraft): BandDraft => {
    if (midTouched) return next;
    const min = Number(next.minAmount);
    const max = Number(next.maxAmount);
    if (next.minAmount !== '' && next.maxAmount !== '' && Number.isFinite(min) && Number.isFinite(max)) {
      return { ...next, midAmount: String((min + max) / 2) };
    }
    return next;
  };

  // Live band stats — range spread ((max−min)/min) and the midpoint.
  const liveMin = Number(draft.minAmount);
  const liveMid = Number(draft.midAmount);
  const liveMax = Number(draft.maxAmount);
  const statsValid =
    draft.minAmount !== '' &&
    draft.midAmount !== '' &&
    draft.maxAmount !== '' &&
    liveMin > 0 &&
    liveMid > 0 &&
    liveMax > 0;

  const onSubmit = async () => {
    if (!draft.name.trim()) {
      toast.error('Name required.');
      return;
    }
    const min = Number(draft.minAmount);
    const mid = Number(draft.midAmount);
    const max = Number(draft.maxAmount);
    if (!(min > 0 && mid > 0 && max > 0)) {
      toast.error('All amounts must be positive.');
      return;
    }
    if (!(min <= mid && mid <= max)) {
      toast.error('min ≤ mid ≤ max required.');
      return;
    }
    setSaving(true);
    try {
      const body = {
        clientId,
        name: draft.name.trim(),
        level: draft.level.trim() || null,
        payType: draft.payType,
        minAmount: min,
        midAmount: mid,
        maxAmount: max,
      };
      if (draft.id) await updateBand(draft.id, body);
      else await createBand(body);
      toast.success(draft.id ? 'Band updated.' : 'Band created.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not save the band.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <DrawerHeader>
        <DrawerTitle>{draft.id ? 'Edit band' : 'New band'}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>Name</Label>
          <Input
            className="mt-1"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </div>
        <div>
          <Label>Level</Label>
          <Input
            className="mt-1"
            value={draft.level}
            onChange={(e) => setDraft({ ...draft, level: e.target.value })}
            placeholder="L3, IC4, Senior, …"
          />
        </div>
        <div>
          <Label htmlFor="comp-pay-type">Pay type</Label>
          <Select
            id="comp-pay-type"
            className="mt-1"
            value={draft.payType}
            onChange={(e) =>
              setDraft({ ...draft, payType: e.target.value as PayType })
            }
          >
            <option value="HOURLY">Hourly</option>
            <option value="SALARY">Salary</option>
          </Select>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <Label>Min</Label>
            <Input
              className="mt-1"
              type="number"
              value={draft.minAmount}
              onChange={(e) => setDraft(autoMid({ ...draft, minAmount: e.target.value }))}
            />
          </div>
          <div>
            <Label>Mid</Label>
            <Input
              className="mt-1"
              type="number"
              value={draft.midAmount}
              onChange={(e) => {
                setMidTouched(true);
                setDraft({ ...draft, midAmount: e.target.value });
              }}
            />
          </div>
          <div>
            <Label>Max</Label>
            <Input
              className="mt-1"
              type="number"
              value={draft.maxAmount}
              onChange={(e) => setDraft(autoMid({ ...draft, maxAmount: e.target.value }))}
            />
          </div>
        </div>
        {statsValid && (
          <p className="text-xs text-silver">
            Spread {fmtPercent(((liveMax - liveMin) / liveMin) * 100)} · midpoint{' '}
            {fmtMoney(liveMid)}
            {!midTouched && ' (auto-filled — edit to override)'}
          </p>
        )}
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={onSubmit} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </DrawerFooter>
    </>
  );
}

// ============ Cycles ============

function CyclesTab({ clientId, canManage }: { clientId: string; canManage: boolean }) {
  const [cycles, setCycles] = useState<MeritCycle[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [active, setActive] = useState<MeritCycle | null>(null);

  const refresh = async () => {
    setCycles(null);
    setError(null);
    try {
      const r = await listCycles(clientId);
      setCycles(r.cycles);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load merit cycles.');
    }
  };
  useEffect(() => {
    refresh();
  }, [clientId]);

  return (
    <div className="space-y-4">
      {canManage && (
        <div className="flex justify-end">
          <Button onClick={() => setShowNew(true)}>
            <Plus className="mr-2 h-4 w-4" /> New cycle
          </Button>
        </div>
      )}
      <Card>
        <CardContent className="p-0">
          {error !== null ? (
            <LoadError message={error} onRetry={refresh} />
          ) : cycles === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : cycles.length === 0 ? (
            <EmptyState
              title="No merit cycles"
              description="Create a merit cycle to plan and apply pay changes for an entire population at once."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden md:table-cell">Period</TableHead>
                  <TableHead>Effective</TableHead>
                  <TableHead className="hidden md:table-cell">Budget</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {cycles.map((c) => (
                  <TableRow
                    key={c.id}
                    className="cursor-pointer"
                    onClick={() => setActive(c)}
                  >
                    <TableCell className="font-medium text-white">
                      <div className="truncate">{c.name}</div>
                      <div className="md:hidden text-xs2 text-silver/70 truncate">
                        {fmtYmd(c.reviewPeriodStart)} – {fmtYmd(c.reviewPeriodEnd)}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          c.status === 'APPLIED' || c.status === 'CLOSED'
                            ? 'success'
                            : c.status === 'OPEN'
                              ? 'pending'
                              : 'default'
                        }
                      >
                        {CYCLE_STATUS_LABELS[c.status]}
                      </Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap hidden md:table-cell">
                      {fmtYmd(c.reviewPeriodStart)} – {fmtYmd(c.reviewPeriodEnd)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{fmtYmd(c.effectiveDate)}</TableCell>
                    <TableCell className="tabular-nums hidden md:table-cell">{fmtMoney(c.budget)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {showNew && (
        <NewCycleDrawer
          clientId={clientId}
          onClose={() => setShowNew(false)}
          onSaved={() => {
            setShowNew(false);
            refresh();
          }}
        />
      )}
      {active && (
        <CycleDetailDrawer
          cycle={active}
          canManage={canManage}
          onClose={() => setActive(null)}
          onChanged={refresh}
        />
      )}
    </div>
  );
}

function NewCycleDrawer({
  clientId,
  onClose,
  onSaved,
}: {
  clientId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const thisYear = new Date().getFullYear();
  const [name, setName] = useState('');
  // Defaults: review the current calendar year, raises effective next Jan 1.
  const [start, setStart] = useState(`${thisYear}-01-01`);
  const [end, setEnd] = useState(`${thisYear}-12-31`);
  const [eff, setEff] = useState(`${thisYear + 1}-01-01`);
  const [budget, setBudget] = useState('');
  const [saving, setSaving] = useState(false);

  const onSubmit = async () => {
    if (!name.trim()) {
      toast.error('Name required.');
      return;
    }
    if (!start || !end || !eff) {
      toast.error('All three dates are required.');
      return;
    }
    setSaving(true);
    try {
      await createCycle({
        clientId,
        name: name.trim(),
        reviewPeriodStart: start,
        reviewPeriodEnd: end,
        effectiveDate: eff,
        budget: budget ? Number(budget) : undefined,
      });
      toast.success('Cycle created.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not create the cycle.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>New merit cycle</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>Name</Label>
          <Input className="mt-1" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Period start</Label>
            <Input
              type="date"
              className="mt-1"
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </div>
          <div>
            <Label>Period end</Label>
            <Input
              type="date"
              className="mt-1"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
          </div>
        </div>
        <div>
          <Label>Effective date</Label>
          <Input
            type="date"
            className="mt-1"
            value={eff}
            onChange={(e) => setEff(e.target.value)}
          />
        </div>
        <div>
          <Label>Budget (optional)</Label>
          <Input
            className="mt-1"
            type="number"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
          />
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={onSubmit} disabled={saving}>
          {saving ? 'Saving…' : 'Create'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

function CycleDetailDrawer({
  cycle,
  canManage,
  onClose,
  onChanged,
}: {
  cycle: MeritCycle;
  canManage: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const confirm = useConfirm();
  const [proposals, setProposals] = useState<MeritProposal[] | null>(null);
  const [proposalsError, setProposalsError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [statusChip, setStatusChip] = useState<MeritProposalStatus | 'ALL'>('ALL');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // In-progress proposed-amount edits, keyed by proposal id — lets us show
  // the live delta and an inline validation message instead of silently
  // discarding bad input on blur.
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [editErrors, setEditErrors] = useState<Record<string, string>>({});

  const refresh = async () => {
    setProposals(null);
    setProposalsError(null);
    setSelected(new Set());
    setEdits({});
    setEditErrors({});
    try {
      const r = await listProposals(cycle.id);
      setProposals(r.proposals);
    } catch (err) {
      setProposalsError(
        err instanceof ApiError ? err.message : 'Could not load proposals.',
      );
    }
  };
  useEffect(() => {
    refresh();
  }, [cycle.id]);

  const totalProposed = useMemo(() => {
    if (!proposals) return 0;
    return proposals
      .filter((p) => p.status === 'APPROVED')
      .reduce(
        (sum, p) => sum + (Number(p.proposedAmount) - Number(p.currentAmount)),
        0,
      );
  }, [proposals]);

  // Budget meter math. `budget` is the total spend allowed for the cycle;
  // totalProposed is the approved delta so far.
  const budget = cycle.budget !== null ? Number(cycle.budget) : null;
  const remaining = budget !== null ? budget - totalProposed : null;
  const pctUsed =
    budget !== null && budget > 0 ? (totalProposed / budget) * 100 : null;

  const q = search.trim().toLowerCase();
  const filtered = (proposals ?? []).filter(
    (p) =>
      (q === '' || p.associateName.toLowerCase().includes(q)) &&
      (statusChip === 'ALL' || p.status === statusChip),
  );

  const decidable = (p: MeritProposal) =>
    canManage && cycle.status === 'OPEN' && p.status !== 'APPLIED';

  const exportCsv = () => {
    downloadCsv(`merit-proposals-${ymdLocal()}.csv`, [
      ['Associate', 'Pay type', 'Current', 'Proposed', 'Delta', 'Status'],
      ...filtered.map((p) => [
        p.associateName,
        PAY_TYPE_LABELS[p.currentPayType],
        p.currentAmount,
        p.proposedAmount,
        (Number(p.proposedAmount) - Number(p.currentAmount)).toFixed(2),
        PROPOSAL_STATUS_LABELS[p.status],
      ]),
    ]);
  };

  const onSeed = async () => {
    setBusy(true);
    try {
      const r = await seedCycle(cycle.id);
      toast.success(`Created ${r.created} proposals (${r.total} eligible).`);
      onChanged();
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not seed proposals.');
    } finally {
      setBusy(false);
    }
  };

  const onApply = async () => {
    if (!(await confirm({ title: `Apply ${cycle.name}?`, description: `Approved proposals become effective ${fmtYmd(cycle.effectiveDate)}.` }))) {
      return;
    }
    setBusy(true);
    try {
      const r = await applyCycle(cycle.id);
      toast.success(`Applied ${r.applied}; ${r.stale} bounced for re-review.`);
      onChanged();
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not apply the cycle.');
    } finally {
      setBusy(false);
    }
  };

  const onDecide = async (p: MeritProposal, status: MeritProposalStatus) => {
    if (status !== 'APPROVED' && status !== 'REJECTED') return;
    try {
      await updateProposal(cycle.id, p.id, { status });
      toast.success(
        status === 'APPROVED'
          ? `${p.associateName}'s proposal approved.`
          : `${p.associateName}'s proposal rejected.`,
      );
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not save the decision.');
    }
  };

  const onApproveSelected = async () => {
    const ids = (proposals ?? [])
      .filter((p) => selected.has(p.id) && decidable(p))
      .map((p) => p.id);
    if (ids.length === 0) return;
    setBusy(true);
    const results = await Promise.allSettled(
      ids.map((id) => updateProposal(cycle.id, id, { status: 'APPROVED' })),
    );
    setBusy(false);
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed === 0) {
      toast.success(`Approved ${ids.length} proposal${ids.length === 1 ? '' : 's'}.`);
    } else {
      toast.error(
        `Approved ${ids.length - failed} of ${ids.length} — ${failed} failed. Reload and retry the rest.`,
      );
    }
    refresh();
  };

  const toggleSelected = (id: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const onEditProposed = async (p: MeritProposal, value: string) => {
    const n = Number(value);
    if (value.trim() === '' || !Number.isFinite(n) || n <= 0) {
      setEditErrors((prev) => ({
        ...prev,
        [p.id]: 'Enter an amount greater than 0.',
      }));
      return;
    }
    setEditErrors((prev) => {
      if (!(p.id in prev)) return prev;
      const rest = { ...prev };
      delete rest[p.id];
      return rest;
    });
    if (n === Number(p.proposedAmount)) return; // unchanged — nothing to save
    try {
      await updateProposal(cycle.id, p.id, { proposedAmount: n });
      toast.success(`${p.associateName}'s proposed amount updated.`);
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not update the amount.');
    }
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()} width="max-w-3xl">
      <DrawerHeader>
        <DrawerTitle>{cycle.name}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div className="text-sm text-silver flex flex-wrap gap-4">
          <span>Status: <span className="text-white">{CYCLE_STATUS_LABELS[cycle.status]}</span></span>
          <span>Effective: <span className="text-white">{fmtYmd(cycle.effectiveDate)}</span></span>
          {budget !== null && (
            <span>
              Budget: <span className="text-white">{fmtMoney(budget)}</span>
            </span>
          )}
          <span>
            Approved Δ:{' '}
            <span className={totalProposed >= 0 ? 'text-success' : 'text-alert'}>
              {fmtMoney(totalProposed)}
            </span>
          </span>
        </div>

        {budget !== null && remaining !== null && (
          <div className="space-y-1">
            <div className="flex justify-between text-xs text-silver">
              <span>Budget used</span>
              <span className={remaining < 0 ? 'text-alert font-medium' : ''}>
                {remaining < 0
                  ? `${fmtMoney(Math.abs(remaining))} over budget`
                  : `${fmtMoney(remaining)} remaining`}
              </span>
            </div>
            <div className="w-full bg-navy-secondary rounded-full h-2 overflow-hidden">
              <div
                className={`h-full transition-all ${pctUsed !== null && pctUsed > 100 ? 'bg-alert' : 'bg-success'}`}
                style={{
                  width: `${Math.min(100, Math.max(0, pctUsed ?? 0))}%`,
                }}
              />
            </div>
            {pctUsed !== null && pctUsed > 100 && (
              <p className="text-xs text-alert">
                Approved increases exceed this cycle’s budget — reduce or
                reject proposals before applying.
              </p>
            )}
          </div>
        )}

        {canManage && (cycle.status === 'DRAFT' || cycle.status === 'OPEN') && (
          <div className="flex gap-2 flex-wrap">
            <Button variant="secondary" onClick={onSeed} disabled={busy}>
              Seed proposals
            </Button>
            {cycle.status === 'OPEN' && (
              <Button onClick={onApply} disabled={busy}>
                Apply cycle
              </Button>
            )}
            {cycle.status === 'OPEN' && selected.size > 0 && (
              <Button variant="secondary" onClick={onApproveSelected} disabled={busy}>
                Approve selected ({selected.size})
              </Button>
            )}
          </div>
        )}

        {proposals !== null && proposals.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap">
            <Input
              className="h-8 w-48 text-sm"
              placeholder="Search associate…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search proposals by associate"
            />
            {(['ALL', 'DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'APPLIED'] as const).map(
              (s) => (
                <FilterChip
                  key={s}
                  active={statusChip === s}
                  onClick={() => setStatusChip(s)}
                >
                  {s === 'ALL' ? 'All' : PROPOSAL_STATUS_LABELS[s]}
                </FilterChip>
              ),
            )}
            <Button
              size="sm"
              variant="secondary"
              onClick={exportCsv}
              disabled={filtered.length === 0}
            >
              <Download className="mr-2 h-4 w-4" /> Export CSV
            </Button>
          </div>
        )}

        {proposalsError !== null ? (
          <LoadError message={proposalsError} onRetry={refresh} />
        ) : proposals === null ? (
          <SkeletonRows count={4} />
        ) : proposals.length === 0 ? (
          <EmptyState
            title="No proposals yet"
            description="Click “Seed proposals” to auto-create a row for every active associate."
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            title="No proposals match"
            description="No proposals match your search or status filter."
            action={
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setSearch('');
                  setStatusChip('ALL');
                }}
              >
                Clear filters
              </Button>
            }
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                {canManage && cycle.status === 'OPEN' && (
                  <TableHead className="w-8" aria-label="Select" />
                )}
                <TableHead>Associate</TableHead>
                <TableHead className="hidden md:table-cell">Current</TableHead>
                <TableHead>Proposed</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right w-44">Decide</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((p) => {
                const editValue = edits[p.id] ?? p.proposedAmount;
                const editError = editErrors[p.id];
                const cur = Number(p.currentAmount);
                const proposedNum = Number(editValue);
                const delta =
                  Number.isFinite(proposedNum) && Number.isFinite(cur)
                    ? proposedNum - cur
                    : null;
                const deltaPct =
                  delta !== null && cur > 0 ? (delta / cur) * 100 : null;
                return (
                  <TableRow key={p.id}>
                    {canManage && cycle.status === 'OPEN' && (
                      <TableCell className="w-8">
                        {decidable(p) && (
                          <input
                            type="checkbox"
                            aria-label={`Select ${p.associateName}`}
                            checked={selected.has(p.id)}
                            onChange={(e) => toggleSelected(p.id, e.target.checked)}
                          />
                        )}
                      </TableCell>
                    )}
                    <TableCell className="font-medium text-white">
                      <div className="truncate">{p.associateName}</div>
                      <div className="md:hidden text-xs2 text-silver/70 truncate tabular-nums">
                        {fmtPayRate(p.currentAmount, p.currentPayType)}
                      </div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell tabular-nums">
                      {fmtPayRate(p.currentAmount, p.currentPayType)}
                    </TableCell>
                    <TableCell>
                      {decidable(p) ? (
                        <div className="space-y-1">
                          <Input
                            className="w-28"
                            type="number"
                            value={editValue}
                            onChange={(e) => {
                              const v = e.target.value;
                              setEdits((prev) => ({ ...prev, [p.id]: v }));
                              setEditErrors((prev) => {
                                if (!(p.id in prev)) return prev;
                                const rest = { ...prev };
                                delete rest[p.id];
                                return rest;
                              });
                            }}
                            onBlur={(e) => onEditProposed(p, e.target.value)}
                            invalid={Boolean(editError)}
                          />
                          {editError ? (
                            <p className="text-xs2 text-alert">{editError}</p>
                          ) : (
                            delta !== null &&
                            delta !== 0 && (
                              <p
                                className={`text-xs2 tabular-nums ${delta > 0 ? 'text-success' : 'text-alert'}`}
                              >
                                {delta > 0 ? '+' : '−'}
                                {deltaPct !== null
                                  ? `${fmtPercent(Math.abs(deltaPct))} · `
                                  : ''}
                                {delta > 0 ? '+' : '−'}
                                {fmtMoney(Math.abs(delta))}
                              </p>
                            )
                          )}
                        </div>
                      ) : (
                        <span className="tabular-nums">{fmtMoney(p.proposedAmount)}</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          p.status === 'APPROVED' || p.status === 'APPLIED'
                            ? 'success'
                            : p.status === 'REJECTED'
                              ? 'destructive'
                              : 'pending'
                        }
                      >
                        {PROPOSAL_STATUS_LABELS[p.status]}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {decidable(p) && (
                        <div className="inline-flex gap-1">
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => onDecide(p, 'APPROVED')}
                          >
                            Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => onDecide(p, 'REJECTED')}
                          >
                            Reject
                          </Button>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}
