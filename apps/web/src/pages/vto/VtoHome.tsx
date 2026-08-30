import { useEffect, useMemo, useState } from 'react';
import { safeHref } from '@alto-people/shared';
import { Heart, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { hasCapability } from '@/lib/roles';
import {
  decideVolunteerEntry,
  getVtoPolicy,
  getVolunteerSummary,
  listMyVolunteer,
  listVolunteerQueue,
  matchVolunteerEntry,
  submitVolunteerEntry,
  type MyVolunteerEntry,
  type MyVolunteerResponse,
  type QueueVolunteerEntry,
  type VolunteerSummary,
  type VtoStatus,
} from '@/lib/vto130Api';
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
  Select,
  SkeletonRows,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from '@/components/ui';
import { Label } from '@/components/ui/Label';
import { fmtDate, fmtMoney, parseYmd, ymdLocal } from '@/lib/format';
import { downloadCsv } from '@/lib/csv';
import { StatusBadge } from '@/lib/status';

// MATCHED is domain-only (not in the shared vocabulary): a matched entry is
// terminal-good, so it reads green like APPROVED. Everything else comes from
// the shared status vocabulary.
const VTO_STATUS_TONES = { MATCHED: 'success' } as const;

export function VtoHome() {
  const { user } = useAuth();
  const canManage = user
    ? hasCapability(user.role, 'manage:performance')
    : false;
  const [tab, setTab] = useState<'mine' | 'queue'>('mine');
  const [mine, setMine] = useState<MyVolunteerResponse | null>(null);
  const [queue, setQueue] = useState<QueueVolunteerEntry[] | null>(null);
  const [summary, setSummary] = useState<VolunteerSummary | null>(null);
  const [statusFilter, setStatusFilter] = useState<VtoStatus | 'ALL'>('PENDING');
  const [showNew, setShowNew] = useState(false);
  const [openMine, setOpenMine] = useState<MyVolunteerEntry | null>(null);
  const [openQueueId, setOpenQueueId] = useState<string | null>(null);
  const [mineError, setMineError] = useState<string | null>(null);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  // `soft` refetches WITHOUT nulling the current rows or clearing the
  // selection — used after mutations so the queue doesn't collapse to a
  // skeleton and lose scroll/selection; fresh rows reconcile in place
  // (selection pruned to rows that still exist). Hard refresh (initial
  // load, tab/filter change, Retry) keeps the skeleton.
  const refresh = (opts?: { soft?: boolean }) => {
    const soft = opts?.soft === true;
    if (tab === 'mine') {
      if (!soft) setMine(null);
      setMineError(null);
      listMyVolunteer()
        .then(setMine)
        .catch((err) =>
          setMineError(
            err instanceof ApiError
              ? err.message
              : 'Failed to load your volunteer hours.',
          ),
        );
    } else {
      if (!soft) {
        setQueue(null);
        setSelected(new Set());
      }
      setQueueError(null);
      listVolunteerQueue(statusFilter === 'ALL' ? undefined : statusFilter)
        .then((r) => {
          setQueue(r.entries);
          setSelected((prev) => {
            const ids = new Set(r.entries.map((e) => e.id));
            return new Set(Array.from(prev).filter((id) => ids.has(id)));
          });
        })
        .catch((err) =>
          setQueueError(
            err instanceof ApiError
              ? err.message
              : 'Failed to load the review queue.',
          ),
        );
    }
  };
  // Filter-independent KPI summary — fetched once on mount and re-fetched
  // explicitly after mutations, never on tab/filter clicks.
  const refreshSummary = () => {
    setSummaryError(null);
    getVolunteerSummary()
      .then(setSummary)
      .catch((err) =>
        setSummaryError(
          err instanceof ApiError
            ? err.message
            : 'Failed to load the summary.',
        ),
      );
  };
  useEffect(() => {
    refresh();
  }, [tab, statusFilter]);
  useEffect(() => {
    if (canManage) refreshSummary();
  }, [canManage]);

  // Memoized: these four passes over the full queue used to re-run on
  // EVERY render — including each keystroke in the search box.
  const term = search.trim().toLowerCase();
  const filteredQueue = useMemo(
    () =>
      queue === null
        ? null
        : term
          ? queue.filter(
              (e) =>
                e.associateName.toLowerCase().includes(term) ||
                e.associateEmail.toLowerCase().includes(term),
            )
          : queue,
    [queue, term],
  );

  const { decidableIds, matchableIds } = useMemo(() => {
    const rows = (filteredQueue ?? []).filter((e) => selected.has(e.id));
    return {
      decidableIds: rows.filter((e) => e.status === 'PENDING').map((e) => e.id),
      matchableIds: rows
        .filter(
          (e) => e.status === 'APPROVED' && e.matchRequested && !e.matchAmount,
        )
        .map((e) => e.id),
    };
  }, [filteredQueue, selected]);

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const runBulk = async (
    ids: string[],
    run: (id: string) => Promise<unknown>,
    verb: string,
  ) => {
    setBulkBusy(true);
    try {
      const results = await Promise.allSettled(ids.map((id) => run(id)));
      const okIds = ids.filter((_, i) => results[i].status === 'fulfilled');
      const failed = results.length - okIds.length;
      if (failed === 0) toast.success(`${okIds.length} ${verb}.`);
      else toast.error(`${okIds.length} ${verb}, ${failed} failed.`);
      // Only acted rows leave the selection — failed ones stay selected
      // so the reviewer can retry exactly those.
      const drop = new Set(okIds);
      setSelected((prev) => new Set(Array.from(prev).filter((id) => !drop.has(id))));
    } finally {
      setBulkBusy(false);
      refresh({ soft: true });
      if (canManage) refreshSummary();
    }
  };

  const exportCsv = () => {
    if (!filteredQueue) return;
    downloadCsv(`volunteer-queue-${ymdLocal()}.csv`, [
      [
        'Associate',
        'Email',
        'Date',
        'Hours',
        'Organization',
        'Cause',
        'Status',
        'Match requested',
        'Match amount',
        'Currency',
        'Reviewer notes',
      ],
      ...filteredQueue.map((e) => [
        e.associateName,
        e.associateEmail,
        e.activityDate,
        e.hours,
        e.organization,
        e.cause ?? '',
        e.status,
        e.matchRequested ? 'yes' : 'no',
        e.matchAmount ?? '',
        e.matchCurrency,
        e.reviewerNotes ?? '',
      ]),
    ]);
  };

  const openQueueRow =
    openQueueId && queue
      ? queue.find((q) => q.id === openQueueId) ?? null
      : null;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Volunteer time"
        subtitle="Log volunteer hours and request employer match. Approved hours roll into your annual cap."
        breadcrumbs={[{ label: 'Total rewards' }, { label: 'Volunteer' }]}
      />

      <div className="flex items-center justify-between">
        <SegmentedControl<'mine' | 'queue'>
          options={[
            { value: 'mine', label: 'My hours' },
            ...(canManage
              ? [
                  {
                    value: 'queue' as const,
                    label: (
                      <span className="inline-flex items-center">
                        Queue
                        {summary && summary.pendingCount > 0 && (
                          <Badge variant="destructive" className="ml-2">
                            {summary.pendingCount}
                          </Badge>
                        )}
                      </span>
                    ),
                  },
                ]
              : []),
          ]}
          value={tab}
          onChange={setTab}
          ariaLabel="Volunteer time view"
        />
        <div className="flex gap-2">
          {canManage && tab === 'queue' && (
            <Select
              size="sm"
              value={statusFilter}
              onChange={(e) =>
                setStatusFilter(e.target.value as VtoStatus | 'ALL')
              }
              aria-label="Filter by status"
            >
              <option value="ALL">All statuses</option>
              <option value="PENDING">Pending</option>
              <option value="APPROVED">Approved</option>
              <option value="MATCHED">Matched</option>
              <option value="REJECTED">Rejected</option>
            </Select>
          )}
          {tab === 'mine' && (
            <Button onClick={() => setShowNew(true)}>
              <Plus className="mr-2 h-4 w-4" /> Log hours
            </Button>
          )}
        </div>
      </div>

      {tab === 'queue' && queue !== null && (
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput
            wrapperClassName="w-56"
            className="h-8 text-xs"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search associate name…"
            aria-label="Search by associate name"
          />
          <Button
            size="sm"
            variant="secondary"
            onClick={exportCsv}
            disabled={!filteredQueue || filteredQueue.length === 0}
          >
            Export CSV
          </Button>
          {selected.size > 0 && (
            <>
              <span className="text-xs text-silver">
                {selected.size} selected
              </span>
              <Button
                size="sm"
                disabled={bulkBusy || decidableIds.length === 0}
                onClick={() =>
                  runBulk(
                    decidableIds,
                    (id) => decideVolunteerEntry(id, 'APPROVED'),
                    'approved',
                  )
                }
              >
                Approve ({decidableIds.length})
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={bulkBusy || decidableIds.length === 0}
                onClick={() =>
                  runBulk(
                    decidableIds,
                    (id) => decideVolunteerEntry(id, 'REJECTED'),
                    'rejected',
                  )
                }
              >
                Reject ({decidableIds.length})
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={bulkBusy || matchableIds.length === 0}
                onClick={() =>
                  runBulk(
                    matchableIds,
                    (id) => matchVolunteerEntry(id),
                    'marked matched',
                  )
                }
              >
                Mark matched ({matchableIds.length})
              </Button>
            </>
          )}
        </div>
      )}

      {tab === 'queue' && summaryError && (
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

      {tab === 'mine' && mine && (
        <Card>
          <CardContent className="p-4">
            <div className="flex justify-between items-baseline mb-2">
              <div>
                <div className="text-xs2 font-medium uppercase tracking-[0.14em] text-silver/70">
                  {mine.year} approved hours
                </div>
                <div className="text-2xl font-semibold text-white mt-1">
                  {mine.usedHours} / {mine.capHours}
                </div>
              </div>
              {mine.matchRatio > 0 && (
                <div className="text-right text-xs text-silver">
                  Employer match: {mine.matchCurrency} {mine.matchRatio}/hour
                </div>
              )}
            </div>
            <div className="w-full bg-navy-secondary rounded-full h-2 overflow-hidden">
              <div
                className="bg-steel h-full transition-all"
                style={{
                  width: `${Math.min(100, (mine.usedHours / Math.max(1, mine.capHours)) * 100)}%`,
                }}
              />
            </div>
          </CardContent>
        </Card>
      )}

      {tab === 'queue' && summary && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <MetricCard
            label="Pending review"
            value={summary.pendingCount}
            accent={summary.pendingCount > 0}
          />
          <MetricCard label="Hours YTD" value={summary.hoursYtd} />
          <MetricCard
            label="Matched $ YTD"
            value={fmtMoney(summary.matchedAmountYtd)}
          />
        </div>
      )}

      {tab === 'mine' ? (
        <Card>
          <CardContent className="p-0">
            {mine === null ? (
              mineError ? (
                <div className="p-6">
                  <ErrorBanner
                    action={
                      <Button size="sm" variant="secondary" onClick={() => refresh()}>
                        Retry
                      </Button>
                    }
                  >
                    {mineError}
                  </ErrorBanner>
                </div>
              ) : (
                <div className="p-6">
                  <SkeletonRows count={3} />
                </div>
              )
            ) : mine.entries.length === 0 ? (
              <EmptyState
                icon={Heart}
                title="No volunteer hours yet"
                description={`Log your first session — up to ${mine.capHours} hours per year.`}
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead className="text-right">Hours</TableHead>
                    <TableHead className="hidden md:table-cell">Organization</TableHead>
                    <TableHead className="hidden lg:table-cell">Cause</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="hidden md:table-cell">Match</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {mine.entries.map((e) => (
                    <TableRow
                      key={e.id}
                      className="cursor-pointer"
                      onClick={() => setOpenMine(e)}
                    >
                      <TableCell className="text-xs text-silver">
                        {fmtDate(parseYmd(e.activityDate))}
                        <div className="md:hidden text-xs2 text-silver/70 truncate">
                          {e.organization}{e.cause ? ` · ${e.cause}` : ''}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm font-medium text-white text-right tabular-nums">
                        {Number(e.hours).toFixed(2)}
                      </TableCell>
                      <TableCell className="text-sm hidden md:table-cell">
                        {e.organization}
                      </TableCell>
                      <TableCell className="text-sm text-silver hidden lg:table-cell">
                        {e.cause ?? '—'}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={e.status} overrides={VTO_STATUS_TONES} />
                      </TableCell>
                      <TableCell className="text-sm hidden md:table-cell">
                        {e.matchAmount
                          ? `${e.matchCurrency} ${e.matchAmount}`
                          : e.matchRequested
                          ? <span className="text-silver text-xs">requested</span>
                          : <span className="text-silver text-xs">—</span>}
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
            {queue === null ? (
              queueError ? (
                <div className="p-6">
                  <ErrorBanner
                    action={
                      <Button size="sm" variant="secondary" onClick={() => refresh()}>
                        Retry
                      </Button>
                    }
                  >
                    {queueError}
                  </ErrorBanner>
                </div>
              ) : (
                <div className="p-6">
                  <SkeletonRows count={4} />
                </div>
              )
            ) : !filteredQueue || filteredQueue.length === 0 ? (
              <EmptyState
                icon={Heart}
                title={term ? 'No matches' : 'Queue is empty'}
                description={
                  term
                    ? `No entries match “${search.trim()}”.`
                    : 'Nothing pending.'
                }
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      <input
                        type="checkbox"
                        aria-label="Select all"
                        checked={
                          filteredQueue.length > 0 &&
                          filteredQueue.every((e) => selected.has(e.id))
                        }
                        onChange={(ev) =>
                          setSelected(
                            ev.target.checked
                              ? new Set(filteredQueue.map((e) => e.id))
                              : new Set(),
                          )
                        }
                      />
                    </TableHead>
                    <TableHead>Associate</TableHead>
                    <TableHead className="hidden md:table-cell">Date</TableHead>
                    <TableHead className="text-right">Hours</TableHead>
                    <TableHead className="hidden md:table-cell">Organization</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="hidden lg:table-cell">Match</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredQueue.map((e) => (
                    <TableRow
                      key={e.id}
                      className="cursor-pointer"
                      onClick={() => setOpenQueueId(e.id)}
                    >
                      <TableCell onClick={(ev) => ev.stopPropagation()}>
                        <input
                          type="checkbox"
                          aria-label={`Select ${e.associateName}`}
                          checked={selected.has(e.id)}
                          onChange={() => toggleSelected(e.id)}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="font-medium text-white">
                          {e.associateName}
                        </div>
                        <div className="text-xs text-silver">
                          {e.associateEmail}
                        </div>
                        <div className="md:hidden text-xs2 text-silver/70 truncate">
                          {fmtDate(parseYmd(e.activityDate))} · {e.organization}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs text-silver hidden md:table-cell">
                        {fmtDate(parseYmd(e.activityDate))}
                      </TableCell>
                      <TableCell className="text-sm text-right tabular-nums">
                        {Number(e.hours).toFixed(2)}
                      </TableCell>
                      <TableCell className="text-sm hidden md:table-cell">
                        {e.organization}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={e.status} overrides={VTO_STATUS_TONES} />
                      </TableCell>
                      <TableCell className="text-xs hidden lg:table-cell">
                        {e.matchRequested ? (
                          e.matchAmount ? (
                            <span className="text-success">
                              {e.matchCurrency} {e.matchAmount}
                            </span>
                          ) : (
                            <span className="text-silver">requested</span>
                          )
                        ) : (
                          <span className="text-silver">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

      {showNew && (
        <NewEntryDrawer
          mine={mine}
          onClose={() => setShowNew(false)}
          onSaved={() => {
            setShowNew(false);
            refresh({ soft: true });
            if (canManage) refreshSummary();
          }}
        />
      )}
      {openMine && (
        <MyDetailDrawer entry={openMine} onClose={() => setOpenMine(null)} />
      )}
      {openQueueRow && (
        <QueueDetailDrawer
          row={openQueueRow}
          onClose={() => setOpenQueueId(null)}
          onSaved={() => {
            setOpenQueueId(null);
            // Soft — the queue stays rendered (scroll + remaining
            // selection intact) while the decided row reconciles.
            refresh({ soft: true });
            if (canManage) refreshSummary();
          }}
        />
      )}
    </div>
  );
}

function NewEntryDrawer({
  mine,
  onClose,
  onSaved,
}: {
  mine: MyVolunteerResponse | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  // ymdLocal, not toISOString: UTC "today" is tomorrow for an evening
  // user west of Greenwich.
  const today = ymdLocal();
  const [activityDate, setActivityDate] = useState(today);
  const [hours, setHours] = useState('');
  const [organization, setOrganization] = useState('');
  const [cause, setCause] = useState('');
  const [description, setDescription] = useState('');
  const [evidenceUrl, setEvidenceUrl] = useState('');
  const [matchRequested, setMatchRequested] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!hours || !organization.trim() || !description.trim()) {
      toast.error('Hours, organization, and description are required.');
      return;
    }
    setBusy(true);
    try {
      await submitVolunteerEntry({
        activityDate,
        hours: parseFloat(hours),
        organization: organization.trim(),
        cause: cause.trim() || null,
        description: description.trim(),
        evidenceUrl: evidenceUrl.trim() || null,
        matchRequested,
      });
      toast.success('Submitted for review.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setBusy(false);
    }
  };

  const dirty =
    hours.trim() !== '' ||
    organization.trim() !== '' ||
    cause.trim() !== '' ||
    description.trim() !== '' ||
    evidenceUrl.trim() !== '' ||
    matchRequested ||
    activityDate !== today;

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()} confirmDiscard={() => dirty}>
      <DrawerHeader>
        <DrawerTitle>Log volunteer hours</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Date</Label>
            <Input
              type="date"
              className="mt-1"
              max={today}
              value={activityDate}
              onChange={(e) => setActivityDate(e.target.value)}
            />
          </div>
          <div>
            <Label>Hours</Label>
            <Input
              type="number"
              min="0"
              max="24"
              step="0.25"
              className="mt-1"
              value={hours}
              onChange={(e) => setHours(e.target.value)}
            />
          </div>
        </div>
        {mine && Number.isFinite(parseFloat(hours)) && parseFloat(hours) > 0 && (
          <p className="text-xs text-silver">
            {parseFloat(hours)}h → {mine.usedHours + parseFloat(hours)}h of{' '}
            {mine.capHours}h used
            {mine.matchRatio > 0 && (
              <>
                {' '}· est. match{' '}
                <span className="text-gold">
                  {fmtMoney(parseFloat(hours) * mine.matchRatio, {
                    currency: mine.matchCurrency,
                  })}
                </span>
              </>
            )}
          </p>
        )}
        <div>
          <Label>Organization</Label>
          <Input
            className="mt-1"
            value={organization}
            onChange={(e) => setOrganization(e.target.value)}
            placeholder="Habitat for Humanity, local food bank…"
          />
        </div>
        <div>
          <Label>Cause (optional)</Label>
          <Input
            className="mt-1"
            value={cause}
            onChange={(e) => setCause(e.target.value)}
            placeholder="Hunger relief, education, environment…"
          />
        </div>
        <div>
          <Label>What did you do?</Label>
          <Textarea
            className="mt-1 h-24"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Brief description of the activity"
          />
        </div>
        <div>
          <Label>Evidence URL (optional)</Label>
          <Input
            type="url"
            className="mt-1"
            value={evidenceUrl}
            onChange={(e) => setEvidenceUrl(e.target.value)}
            placeholder="Photo, write-up, sign-in sheet…"
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-white">
          <input
            type="checkbox"
            checked={matchRequested}
            onChange={(e) => setMatchRequested(e.target.checked)}
          />
          Request employer match payout for these hours
        </label>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={busy}>
          {busy ? 'Submitting…' : 'Submit'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

function MyDetailDrawer({
  entry,
  onClose,
}: {
  entry: MyVolunteerEntry;
  onClose: () => void;
}) {
  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>{entry.organization}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div className="flex items-center gap-2">
          <StatusBadge status={entry.status} overrides={VTO_STATUS_TONES} />
          <span className="text-sm text-silver">
            {fmtDate(parseYmd(entry.activityDate))} · {entry.hours} hours
          </span>
        </div>
        {entry.cause && (
          <div className="text-sm">
            <span className="text-silver">Cause: </span>
            <span className="text-white">{entry.cause}</span>
          </div>
        )}
        <div className="text-sm text-white whitespace-pre-wrap">
          {entry.description}
        </div>
        {entry.evidenceUrl && (
          <a
            href={safeHref(entry.evidenceUrl)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-gold hover:underline"
          >
            Evidence ↗
          </a>
        )}
        {entry.matchRequested && (
          <div className="text-sm border-t border-navy-secondary pt-3">
            <span className="text-silver">Employer match: </span>
            {entry.matchAmount ? (
              <span className="text-success font-semibold">
                {entry.matchCurrency} {entry.matchAmount}
              </span>
            ) : (
              <span className="text-silver">requested · awaiting payout</span>
            )}
          </div>
        )}
        {entry.reviewerNotes && (
          <div className="text-sm text-silver italic p-3 rounded border border-navy-secondary">
            HR: {entry.reviewerNotes}
          </div>
        )}
      </DrawerBody>
      <DrawerFooter>
        <Button onClick={onClose}>Close</Button>
      </DrawerFooter>
    </Drawer>
  );
}

function QueueDetailDrawer({
  row,
  onClose,
  onSaved,
}: {
  row: QueueVolunteerEntry;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [notes, setNotes] = useState(row.reviewerNotes ?? '');
  const [matchAmount, setMatchAmount] = useState('');
  const [busy, setBusy] = useState(false);
  // What "blank = use policy ratio" would actually pay — fetched so the
  // reviewer isn't left doing hours × ratio in their head. Uses the org
  // default policy; the server applies the entry's client policy if one
  // overrides it.
  const [policyRatio, setPolicyRatio] = useState<{
    ratio: number;
    currency: string;
  } | null>(null);
  const [policyError, setPolicyError] = useState(false);
  const showMatchForm =
    row.status === 'APPROVED' && row.matchRequested && !row.matchAmount;
  useEffect(() => {
    if (!showMatchForm) return;
    let cancelled = false;
    setPolicyError(false);
    getVtoPolicy()
      .then((p) => {
        if (cancelled) return;
        const ratio = Number(p.effective.matchRatio);
        if (Number.isFinite(ratio) && ratio > 0) {
          setPolicyRatio({ ratio, currency: p.effective.matchCurrency });
        }
      })
      .catch(() => {
        if (!cancelled) setPolicyError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [showMatchForm]);
  const policyEstimate =
    policyRatio && Number.isFinite(Number(row.hours))
      ? Number(row.hours) * policyRatio.ratio
      : null;

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>
          {row.associateName} · {row.organization}
        </DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div className="flex items-center gap-2">
          <StatusBadge status={row.status} overrides={VTO_STATUS_TONES} />
          <span className="text-sm text-silver">
            {fmtDate(parseYmd(row.activityDate))} · {row.hours} hours
          </span>
        </div>
        {row.cause && (
          <div className="text-sm">
            <span className="text-silver">Cause: </span>
            <span className="text-white">{row.cause}</span>
          </div>
        )}
        <div className="text-sm text-white whitespace-pre-wrap">
          {row.description}
        </div>
        {row.evidenceUrl && (
          <a
            href={safeHref(row.evidenceUrl)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-gold hover:underline"
          >
            Evidence ↗
          </a>
        )}
        {row.matchRequested && (
          <div className="text-sm">
            <span className="text-silver">Match: </span>
            {row.matchAmount ? (
              <span className="text-success">
                {row.matchCurrency} {row.matchAmount} (paid)
              </span>
            ) : (
              <span className="text-warning">requested</span>
            )}
          </div>
        )}

        {row.status === 'PENDING' && (
          <div className="space-y-2 pt-2 border-t border-navy-secondary">
            <Label>Reviewer notes</Label>
            <Textarea
              className="h-20"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={async () => {
                  setBusy(true);
                  try {
                    await decideVolunteerEntry(row.id, 'APPROVED', notes);
                    toast.success('Approved.');
                    onSaved();
                  } catch (err) {
                    toast.error(
                      err instanceof ApiError ? err.message : 'Failed.',
                    );
                  } finally {
                    setBusy(false);
                  }
                }}
                disabled={busy}
              >
                Approve
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={async () => {
                  setBusy(true);
                  try {
                    await decideVolunteerEntry(row.id, 'REJECTED', notes);
                    toast.success('Rejected.');
                    onSaved();
                  } catch (err) {
                    toast.error(
                      err instanceof ApiError ? err.message : 'Failed.',
                    );
                  } finally {
                    setBusy(false);
                  }
                }}
                disabled={busy}
              >
                Reject
              </Button>
            </div>
          </div>
        )}

        {showMatchForm && (
          <div className="space-y-2 pt-2 border-t border-navy-secondary">
            <Label>Match amount (USD, blank = use policy ratio)</Label>
            <Input
              type="number"
              min="0"
              step="0.01"
              value={matchAmount}
              onChange={(e) => setMatchAmount(e.target.value)}
              placeholder="Auto from policy if blank"
            />
            {policyError && (
              <ErrorBanner severity="warning" className="text-xs">
                Couldn’t load the policy ratio — leaving this blank still
                applies the server-side policy, or enter an amount manually.
              </ErrorBanner>
            )}
            {policyEstimate !== null && matchAmount === '' && (
              <p className="text-xs text-silver">
                Policy would pay {row.hours}h × {policyRatio!.ratio} ≈{' '}
                <span className="text-gold">
                  {policyRatio!.currency} {policyEstimate.toFixed(2)}
                </span>
                {' '}(org default ratio; a client-specific policy may differ).
              </p>
            )}
            <Button
              size="sm"
              onClick={async () => {
                setBusy(true);
                try {
                  await matchVolunteerEntry(
                    row.id,
                    matchAmount ? parseFloat(matchAmount) : undefined,
                  );
                  toast.success('Marked matched.');
                  onSaved();
                } catch (err) {
                  toast.error(
                    err instanceof ApiError ? err.message : 'Failed.',
                  );
                } finally {
                  setBusy(false);
                }
              }}
              disabled={busy}
            >
              Mark matched
            </Button>
          </div>
        )}

        {row.reviewerNotes && row.status !== 'PENDING' && (
          <div className="text-sm text-silver italic">
            Reviewer: {row.reviewerNotes}
          </div>
        )}
      </DrawerBody>
      <DrawerFooter>
        <Button onClick={onClose}>Close</Button>
      </DrawerFooter>
    </Drawer>
  );
}
