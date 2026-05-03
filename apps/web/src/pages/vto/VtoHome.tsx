import { useEffect, useState } from 'react';
import { Heart, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { hasCapability } from '@/lib/roles';
import {
  decideVolunteerEntry,
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
} from '@/components/ui';
import { Label } from '@/components/ui/Label';

const STATUS_VARIANT: Record<
  VtoStatus,
  'pending' | 'success' | 'destructive' | 'accent'
> = {
  PENDING: 'pending',
  APPROVED: 'accent',
  REJECTED: 'destructive',
  MATCHED: 'success',
};

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

  const refresh = () => {
    if (tab === 'mine') {
      setMine(null);
      listMyVolunteer()
        .then(setMine)
        .catch(() => setMine(null));
    } else {
      setQueue(null);
      listVolunteerQueue(statusFilter === 'ALL' ? undefined : statusFilter)
        .then((r) => setQueue(r.entries))
        .catch(() => setQueue([]));
      getVolunteerSummary()
        .then(setSummary)
        .catch(() => setSummary(null));
    }
  };
  useEffect(() => {
    refresh();
  }, [tab, statusFilter]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Volunteer time"
        subtitle="Log volunteer hours and request employer match. Approved hours roll into your annual cap."
        breadcrumbs={[{ label: 'Total rewards' }, { label: 'Volunteer' }]}
      />

      <div className="flex items-center justify-between">
        <div className="flex gap-1">
          <Button
            size="sm"
            variant={tab === 'mine' ? 'primary' : 'ghost'}
            onClick={() => setTab('mine')}
          >
            My hours
          </Button>
          {canManage && (
            <Button
              size="sm"
              variant={tab === 'queue' ? 'primary' : 'ghost'}
              onClick={() => setTab('queue')}
            >
              Queue
              {summary && summary.pendingCount > 0 && (
                <Badge variant="destructive" className="ml-2">
                  {summary.pendingCount}
                </Badge>
              )}
            </Button>
          )}
        </div>
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

      {tab === 'mine' && mine && (
        <Card>
          <CardContent className="p-4">
            <div className="flex justify-between items-baseline mb-2">
              <div>
                <div className="text-xs uppercase tracking-wider text-silver">
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
                className="bg-blue-500 h-full transition-all"
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
          <SummaryCard label="Pending review" value={summary.pendingCount} />
          <SummaryCard label="Hours YTD" value={summary.hoursYtd} />
          <SummaryCard
            label="Matched $ YTD"
            value={`$${summary.matchedAmountYtd}`}
          />
        </div>
      )}

      {tab === 'mine' ? (
        <Card>
          <CardContent className="p-0">
            {mine === null ? (
              <div className="p-6">
                <SkeletonRows count={3} />
              </div>
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
                    <TableHead>Hours</TableHead>
                    <TableHead>Organization</TableHead>
                    <TableHead>Cause</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Match</TableHead>
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
                        {e.activityDate}
                      </TableCell>
                      <TableCell className="text-sm font-medium text-white">
                        {e.hours}
                      </TableCell>
                      <TableCell className="text-sm">
                        {e.organization}
                      </TableCell>
                      <TableCell className="text-sm text-silver">
                        {e.cause ?? '—'}
                      </TableCell>
                      <TableCell>
                        <Badge variant={STATUS_VARIANT[e.status]}>
                          {e.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm">
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
              <div className="p-6">
                <SkeletonRows count={4} />
              </div>
            ) : queue.length === 0 ? (
              <EmptyState
                icon={Heart}
                title="Queue is empty"
                description="Nothing pending."
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Associate</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Hours</TableHead>
                    <TableHead>Organization</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Match</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {queue.map((e) => (
                    <TableRow
                      key={e.id}
                      className="cursor-pointer"
                      onClick={() => setOpenQueueId(e.id)}
                    >
                      <TableCell>
                        <div className="font-medium text-white">
                          {e.associateName}
                        </div>
                        <div className="text-xs text-silver">
                          {e.associateEmail}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs text-silver">
                        {e.activityDate}
                      </TableCell>
                      <TableCell className="text-sm">{e.hours}</TableCell>
                      <TableCell className="text-sm">
                        {e.organization}
                      </TableCell>
                      <TableCell>
                        <Badge variant={STATUS_VARIANT[e.status]}>
                          {e.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs">
                        {e.matchRequested ? (
                          e.matchAmount ? (
                            <span className="text-green-300">
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
          onClose={() => setShowNew(false)}
          onSaved={() => {
            setShowNew(false);
            refresh();
          }}
        />
      )}
      {openMine && (
        <MyDetailDrawer entry={openMine} onClose={() => setOpenMine(null)} />
      )}
      {openQueueId && queue && (
        <QueueDetailDrawer
          row={queue.find((q) => q.id === openQueueId)!}
          onClose={() => setOpenQueueId(null)}
          onSaved={() => {
            setOpenQueueId(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function SummaryCard({
  label,
  value,
}: {
  label: string;
  value: number | string;
}) {
  return (
    <Card>
      <CardContent className="p-3">
        <div className="text-xs uppercase tracking-wider text-silver">
          {label}
        </div>
        <div className="text-xl font-semibold text-white mt-1">{value}</div>
      </CardContent>
    </Card>
  );
}

function NewEntryDrawer({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
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

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
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
          <textarea
            className="w-full mt-1 h-24 rounded-md border border-navy-secondary bg-midnight p-2 text-white text-sm"
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
          <Badge variant={STATUS_VARIANT[entry.status]}>{entry.status}</Badge>
          <span className="text-sm text-silver">
            {entry.activityDate} · {entry.hours} hours
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
            href={entry.evidenceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-blue-300 hover:underline"
          >
            Evidence ↗
          </a>
        )}
        {entry.matchRequested && (
          <div className="text-sm border-t border-navy-secondary pt-3">
            <span className="text-silver">Employer match: </span>
            {entry.matchAmount ? (
              <span className="text-green-300 font-semibold">
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

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>
          {row.associateName} · {row.organization}
        </DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div className="flex items-center gap-2">
          <Badge variant={STATUS_VARIANT[row.status]}>{row.status}</Badge>
          <span className="text-sm text-silver">
            {row.activityDate} · {row.hours} hours
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
            href={row.evidenceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-blue-300 hover:underline"
          >
            Evidence ↗
          </a>
        )}
        {row.matchRequested && (
          <div className="text-sm">
            <span className="text-silver">Match: </span>
            {row.matchAmount ? (
              <span className="text-green-300">
                {row.matchCurrency} {row.matchAmount} (paid)
              </span>
            ) : (
              <span className="text-yellow-300">requested</span>
            )}
          </div>
        )}

        {row.status === 'PENDING' && (
          <div className="space-y-2 pt-2 border-t border-navy-secondary">
            <Label>Reviewer notes</Label>
            <textarea
              className="w-full h-20 rounded-md border border-navy-secondary bg-midnight p-2 text-white text-sm"
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

        {row.status === 'APPROVED' && row.matchRequested && !row.matchAmount && (
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
