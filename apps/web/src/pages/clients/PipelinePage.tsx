import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Info, Plus, Target } from '@/components/ui/icons';
import { toast } from 'sonner';
import {
  OPEN_PROSPECT_STAGES,
  isOpenProspectStage,
  type ClientSummary,
  type ProspectListResponse,
  type ProspectRow,
  type ProspectStageKey,
} from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { listClients } from '@/lib/clientsApi';
import { useAuth } from '@/lib/auth';
import { useConfirm, usePrompt } from '@/lib/confirm';
import { fmtMoneyCompact } from '@/lib/format';
import { useMediaQuery } from '@/lib/useViewport';
import {
  PROSPECTS_KEY,
  PROSPECT_OWNERS_KEY,
  deleteProspect,
  listProspectOwners,
  listProspects,
  updateProspect,
} from '@/lib/prospectsApi';
import { ListTemplate } from '@/components/templates';
import { FilterSheet } from '@/components/FilterSheet';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { FilterBar, FilterChip, SearchInput } from '@/components/ui/FilterBar';
import { MetricCard } from '@/components/ui/MetricCard';
import { QueryError } from '@/components/ui/QueryError';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/Tooltip';
import { NewClientDialog } from './NewClientDialog';
import { ProspectBoard } from './pipeline/ProspectBoard';
import { ProspectDialog } from './pipeline/ProspectDialog';
import { ProspectList } from './pipeline/ProspectList';
import { STAGE_LABEL, STALLED_DAYS, fmtWeight, stalledReason, startsWithin90 } from './pipeline/pipelineShared';

/**
 * Clients → Pipeline: the new business we are working to win.
 *
 * The header answers "how is new business doing": how many prospects are
 * open, what they are worth weighted by how likely each stage is to close,
 * what starts in the next 90 days, and what has stalled. Each number opens
 * the prospects behind it. The board (a list on a phone) is where prospects
 * move: Won offers to create the client, Lost asks why.
 */

type View = 'open' | 'starts90' | 'stalled' | 'unpriced';
const VIEWS: readonly View[] = ['open', 'starts90', 'stalled', 'unpriced'];
const VIEW_LABEL: Record<View, string> = {
  open: 'Open',
  starts90: 'Starting in 90 days',
  stalled: 'Needs a nudge',
  unpriced: 'Not priced',
};

export function PipelinePage() {
  const { user } = useAuth();
  const meId = user?.id ?? null;
  const qc = useQueryClient();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const desktop = useMediaQuery('(min-width: 1024px)');
  const [params, setParams] = useSearchParams();
  const view = (VIEWS as readonly string[]).includes(params.get('view') ?? '') ? (params.get('view') as View) : null;
  const owner = params.get('owner') ?? '';
  const [search, setSearch] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);

  const pipeline = useQuery({ queryKey: PROSPECTS_KEY, queryFn: listProspects });
  const data = pipeline.data;
  const canWrite = data?.canWrite ?? false;
  const money = data?.money ?? false;
  const owners = useQuery({ queryKey: PROSPECT_OWNERS_KEY, queryFn: listProspectOwners, enabled: canWrite, staleTime: 5 * 60_000 });

  const [editing, setEditing] = useState<ProspectRow | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [wonFor, setWonFor] = useState<ProspectRow | null>(null);
  const [creatingFor, setCreatingFor] = useState<ProspectRow | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const setParam = (key: 'view' | 'owner', value: string | null) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );
  };

  const today = data?.today ?? '';
  const rows = useMemo(() => {
    if (!data) return [];
    const needle = search.trim().toLowerCase();
    return data.prospects.filter((p) => {
      if (needle && ![p.name, p.contactName ?? '', p.contactEmail ?? '', p.ownerName ?? ''].some((s) => s.toLowerCase().includes(needle))) return false;
      if (owner === 'me' && p.ownerUserId !== meId) return false;
      if (owner === 'none' && p.ownerUserId !== null) return false;
      if (owner && owner !== 'me' && owner !== 'none' && p.ownerUserId !== owner) return false;
      if (view === 'open' && !isOpenProspectStage(p.stage)) return false;
      if (view === 'starts90' && !startsWithin90(p, data.today)) return false;
      if (view === 'stalled' && !stalledReason(p, data.today)) return false;
      if (view === 'unpriced' && !(isOpenProspectStage(p.stage) && (p.estWeeklyHours == null || p.estBillRate == null))) return false;
      return true;
    });
  }, [data, search, owner, view, meId]);

  const stalledCount = useMemo(() => (data ? data.prospects.filter((p) => stalledReason(p, data.today)).length : 0), [data]);
  const filtered = !!(view || owner || search.trim());

  const refresh = () => void qc.invalidateQueries({ queryKey: PROSPECTS_KEY });

  /** Save a move; the card goes to its new column at once and comes back if the save fails. */
  const save = async (p: ProspectRow, body: Parameters<typeof updateProspect>[1], done: string) => {
    setPendingId(p.id);
    const before = qc.getQueryData<ProspectListResponse>(PROSPECTS_KEY);
    if (before && body.stage) {
      qc.setQueryData<ProspectListResponse>(PROSPECTS_KEY, {
        ...before,
        prospects: before.prospects.map((r) => (r.id === p.id ? { ...r, stage: body.stage!, daysInStage: 0 } : r)),
      });
    }
    try {
      await updateProspect(p.id, body);
      toast.success(done);
      return true;
    } catch (err) {
      if (before) qc.setQueryData(PROSPECTS_KEY, before);
      toast.error(err instanceof ApiError ? err.message : `Could not move ${p.name}.`);
      return false;
    } finally {
      setPendingId(null);
      refresh();
    }
  };

  const onMove = async (p: ProspectRow, to: ProspectStageKey) => {
    if (p.stage === to) return;
    if (to === 'WON') {
      setWonFor(p);
      return;
    }
    if (to === 'LOST') {
      const reason = await prompt({
        title: `Mark ${p.name} lost?`,
        description: 'The reason stays on the prospect, so the next pitch can learn from it.',
        reasonLabel: 'Why was it lost?',
        reasonPlaceholder: 'e.g. Went with the incumbent at a lower rate',
        reasonMaxLength: 500,
        confirmLabel: 'Mark lost',
        destructive: true,
      });
      if (!reason) return;
      await save(p, { stage: 'LOST', lostReason: reason }, `${p.name} marked lost.`);
      return;
    }
    if (p.stage === 'WON' && p.wonClientId) {
      // Reopening a won deal unlinks the client it became; say so first.
      const yes = await confirm({
        title: `Reopen ${p.name}?`,
        description: `It moves back to ${STAGE_LABEL[to]} and stops pointing at the client ${p.wonClientName ?? ''}. The client itself is not changed.`,
        confirmLabel: 'Reopen',
      });
      if (!yes) return;
    }
    await save(p, { stage: to }, `${p.name} moved to ${STAGE_LABEL[to]}.`);
  };

  const onClientCreated = async (p: ProspectRow, c: ClientSummary) => {
    const ok = await save(p, { stage: 'WON', wonClientId: c.id }, `${p.name} won — ${c.name} is a client now.`);
    if (!ok) toast.error(`${c.name} was created, but the prospect was not marked won. Mark it won and pick the client again.`);
  };

  const onDelete = async (p: ProspectRow) => {
    const yes = await confirm({ title: `Delete ${p.name}?`, description: 'It leaves the pipeline and the executive dashboard.', destructive: true, confirmLabel: 'Delete prospect' });
    if (!yes) return;
    try {
      await deleteProspect(p.id);
      toast.success(`${p.name} deleted.`);
      setDialogOpen(false);
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not delete the prospect.');
    }
  };

  const actions = {
    canWrite,
    onOpen: (p: ProspectRow) => {
      setEditing(p);
      setDialogOpen(true);
    },
    onMove: (p: ProspectRow, to: ProspectStageKey) => void onMove(p, to),
    onCreateClient: (p: ProspectRow) => setCreatingFor(p),
  };

  const openAdd = () => {
    setEditing(null);
    setDialogOpen(true);
  };

  const ownerFilter = (
    <Select
      size="sm"
      aria-label="Owner"
      value={owner}
      onChange={(e) => setParam('owner', e.target.value || null)}
      className="min-w-[10rem]"
    >
      <option value="">Every owner</option>
      {meId && <option value="me">Mine</option>}
      <option value="none">No owner</option>
      {(owners.data?.owners ?? []).filter((o) => o.id !== meId).map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </Select>
  );
  const viewChips = (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Show">
      <FilterChip active={!view} onClick={() => setParam('view', null)}>
        All
      </FilterChip>
      {VIEWS.filter((v) => v !== 'unpriced' || money).map((v) => (
        <FilterChip key={v} active={view === v} onClick={() => setParam('view', view === v ? null : v)}>
          {VIEW_LABEL[v]}
        </FilterChip>
      ))}
    </div>
  );
  const activeFilters = (view ? 1 : 0) + (owner ? 1 : 0);

  return (
    <ListTemplate
      title="Pipeline"
      subtitle="New business from first call to signed client, weighted by how likely each stage is to close."
      breadcrumbs={[{ label: 'Clients', to: '/clients' }, { label: 'Pipeline' }]}
      primaryAction={
        canWrite ? (
          <Button onClick={openAdd}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add prospect
          </Button>
        ) : undefined
      }
      summary={
        pipeline.isPending ? (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-28" />
            ))}
          </div>
        ) : data ? (
          <PipelineTiles data={data} stalled={stalledCount} />
        ) : null
      }
      filters={
        data && data.prospects.length > 0 ? (
          <FilterBar>
            <SearchInput
              aria-label="Search prospects"
              placeholder="Search prospects"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              wrapperClassName="min-w-[12rem] flex-1 lg:max-w-xs"
              className="h-8"
            />
            <FilterSheet mobile={!desktop} open={filtersOpen} onOpenChange={setFiltersOpen} summary={activeFilters ? `Filters (${activeFilters})` : 'Filters'}>
              {ownerFilter}
              {viewChips}
            </FilterSheet>
            {filtered && (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  setSearch('');
                  setParams({}, { replace: true });
                }}
              >
                Clear
              </Button>
            )}
          </FilterBar>
        ) : null
      }
    >
      {pipeline.isError && <QueryError what="the pipeline" query={pipeline} />}
      {pipeline.isPending && <Skeleton className="h-96" />}
      {data && data.prospects.length === 0 && (
        <EmptyState
          icon={Target}
          title="The pipeline is empty"
          description={
            canWrite
              ? 'Add the businesses you are working to win. Each gets a value from its hours and rate, weighted by its stage.'
              : 'When the client team adds prospects, they show here with their value and stage.'
          }
          action={
            canWrite ? (
              <Button onClick={openAdd}>
                <Plus className="h-4 w-4" aria-hidden="true" />
                Add prospect
              </Button>
            ) : undefined
          }
        />
      )}
      {data && data.prospects.length > 0 && rows.length === 0 && (
        <EmptyState
          size="sm"
          title="Nothing matches these filters"
          description="Clear the filters to see the whole pipeline."
        />
      )}
      {data && rows.length > 0 && (
        <>
          {view && (
            <p className="text-xs2 text-ink-muted" role="status">
              Showing {rows.length} prospect{rows.length === 1 ? '' : 's'}: {VIEW_LABEL[view].toLowerCase()}
              {view === 'stalled' && ` (${STALLED_DAYS}+ days in a stage, or the start date has passed)`}.
            </p>
          )}
          {desktop ? (
            <ProspectBoard rows={rows} today={today} money={money} weights={data.weights} pendingId={pendingId} {...actions} />
          ) : (
            <ProspectList rows={rows} today={today} money={money} weights={data.weights} pendingId={pendingId} {...actions} />
          )}
        </>
      )}

      {data && (
        <ProspectDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          prospect={editing}
          owners={owners.data?.owners ?? []}
          meId={meId}
          money={money}
          weights={data.weights}
          onSaved={refresh}
          onDelete={canWrite ? (p) => void onDelete(p) : undefined}
        />
      )}
      <WonDialog
        prospect={wonFor}
        onOpenChange={(o) => !o && setWonFor(null)}
        onCreateClient={(p) => {
          setWonFor(null);
          setCreatingFor(p);
        }}
        onLinkClient={async (p, clientId) => {
          setWonFor(null);
          await save(p, { stage: 'WON', wonClientId: clientId }, `${p.name} marked won and linked.`);
        }}
        onWonWithoutClient={async (p) => {
          setWonFor(null);
          await save(p, { stage: 'WON' }, `${p.name} marked won.`);
        }}
      />
      {creatingFor && (
        <NewClientDialog
          open
          onOpenChange={(o) => !o && setCreatingFor(null)}
          initialName={creatingFor.name}
          initialContactEmail={creatingFor.contactEmail}
          initialStatus="ACTIVE"
          title="Create the client"
          description={`${creatingFor.name} becomes a client. The prospect is marked won and links to it.`}
          onCreated={(c) => {
            const p = creatingFor;
            setCreatingFor(null);
            void onClientCreated(p, c);
          }}
        />
      )}
    </ListTemplate>
  );
}

/** The header: open, weighted value, starting soon, stalled — each opens the prospects behind it. */
function PipelineTiles({ data, stalled }: { data: ProspectListResponse; stalled: number }) {
  const { totals, weights, money } = data;
  const link = (view: View) => (card: React.ReactElement) => (
    <Link to={`?view=${view}`} className="block h-full rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright">
      {card}
    </Link>
  );
  const weightLines = OPEN_PROSPECT_STAGES.map((s) => `${STAGE_LABEL[s]} ${fmtWeight(weights[s])}`).join(' · ');
  return (
    <div className={money ? 'grid grid-cols-2 gap-3 lg:grid-cols-4' : 'grid grid-cols-2 gap-3 lg:grid-cols-3'} data-testid="pipeline-tiles">
      <MetricCard
        className="h-full"
        label="Open prospects"
        value={String(totals.open)}
        hint={totals.open === 0 ? 'None in a working stage' : 'Lead to verbal yes'}
        wrap={link('open')}
        cta={false}
      />
      {money && (
        <MetricCard
        className="h-full"
          label="Weighted pipeline"
          value={totals.open - totals.unpriced > 0 ? `${fmtMoneyCompact(totals.weightedValue ?? 0)}/yr` : '—'}
          hint={
            <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
              {totals.open - totals.unpriced > 0 ? <span>of {fmtMoneyCompact(totals.unweightedValue ?? 0)} if every one closes</span> : <span>Add hours and a rate to value a prospect</span>}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button type="button" aria-label="How it is weighted" className="inline-grid h-5 w-5 place-items-center rounded-full text-ink-muted hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright">
                    <Info className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-xs">
                  Hours a week × bill rate × 52, times the chance the stage closes: {weightLines}.
                </TooltipContent>
              </Tooltip>
              {totals.unpriced > 0 && (
                <Link to="?view=unpriced" className="text-accent underline-offset-2 hover:underline">
                  {totals.unpriced} not priced
                </Link>
              )}
            </span>
          }
        />
      )}
      <MetricCard
        className="h-full"
        label="Starting in 90 days"
        value={String(totals.startsNext90)}
        hint={totals.startsNext90 === 0 ? 'No expected starts' : `${totals.startsNext90Won} won · ${totals.startsNext90 - totals.startsNext90Won} still open`}
        wrap={link('starts90')}
        cta={false}
      />
      <MetricCard
        className="h-full"
        label="Needs a nudge"
        value={String(stalled)}
        accent={stalled > 0}
        hint={`${STALLED_DAYS}+ days in a stage, or start date passed`}
        wrap={link('stalled')}
        cta={false}
      />
    </div>
  );
}

/**
 * Won: create the client it became (the usual path), link a client that
 * already exists, or mark it won and create the client later.
 */
function WonDialog({
  prospect,
  onOpenChange,
  onCreateClient,
  onLinkClient,
  onWonWithoutClient,
}: {
  prospect: ProspectRow | null;
  onOpenChange: (open: boolean) => void;
  onCreateClient: (p: ProspectRow) => void;
  onLinkClient: (p: ProspectRow, clientId: string) => void | Promise<void>;
  onWonWithoutClient: (p: ProspectRow) => void | Promise<void>;
}) {
  const clients = useQuery({
    // Under ['clients'] so a client created anywhere refreshes it.
    queryKey: ['clients', 'list', 'pipeline-link'],
    queryFn: () => listClients({}),
    enabled: !!prospect,
    staleTime: 60_000,
  });
  const options = useMemo(
    () => [...(clients.data?.clients ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [clients.data],
  );
  const [linkId, setLinkId] = useState('');
  // A client already named like the prospect is the likely one.
  useEffect(() => {
    if (!prospect) return;
    const same = options.find((c) => c.name.trim().toLowerCase() === prospect.name.trim().toLowerCase());
    setLinkId(same?.id ?? '');
  }, [prospect, options]);

  return (
    <Dialog open={!!prospect} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{prospect ? `${prospect.name} won` : 'Won'}</DialogTitle>
          <DialogDescription>
            Create the client now to start setting it up: sites, rates and portal access. The prospect links to it.
          </DialogDescription>
        </DialogHeader>
        <Button className="w-full sm:w-auto sm:justify-self-start" onClick={() => prospect && onCreateClient(prospect)}>
          <Building2 className="h-4 w-4" aria-hidden="true" />
          Create the client
        </Button>
        {options.length > 0 && (
          <div className="flex flex-col gap-2 border-t border-line pt-3 sm:flex-row sm:items-end">
            <Field label="Already a client? Link it" className="min-w-0 flex-1">
              {(p) => (
                <Select value={linkId} onChange={(e) => setLinkId(e.target.value)} {...p}>
                  <option value="">Choose the client</option>
                  {options.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Button variant="secondary" disabled={!linkId} onClick={() => prospect && linkId && void onLinkClient(prospect, linkId)}>
              Link and mark won
            </Button>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => prospect && void onWonWithoutClient(prospect)}>
            Mark won, create the client later
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
