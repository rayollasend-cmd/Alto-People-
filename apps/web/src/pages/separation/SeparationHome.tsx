import { useEffect, useState } from 'react';
import { LogOut, MessageSquareQuote, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import {
  advanceSeparation,
  getSeparationSummary,
  initiateSeparation,
  listSeparations,
  REASON_LABELS,
  submitExitInterview,
  type SeparationReason,
  type SeparationRow,
  type SeparationStatus,
  type SeparationSummary,
} from '@/lib/separation119Api';
import { useAuth } from '@/lib/auth';
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
  Input,
  PageHeader,
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
  SeparationStatus,
  'pending' | 'accent' | 'success'
> = {
  PLANNED: 'pending',
  IN_PROGRESS: 'accent',
  COMPLETE: 'success',
};

export function SeparationHome() {
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:onboarding') : false;
  const [summary, setSummary] = useState<SeparationSummary | null>(null);
  const [rows, setRows] = useState<SeparationRow[] | null>(null);
  const [filter, setFilter] = useState<SeparationStatus | 'ALL'>('PLANNED');
  const [showNew, setShowNew] = useState(false);
  const [openRow, setOpenRow] = useState<SeparationRow | null>(null);

  const refresh = () => {
    setRows(null);
    listSeparations({ status: filter === 'ALL' ? undefined : filter })
      .then((r) => setRows(r.separations))
      .catch(() => setRows([]));
    getSeparationSummary(90)
      .then(setSummary)
      .catch(() => setSummary(null));
  };
  useEffect(() => {
    refresh();
  }, [filter]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Separations"
        subtitle="Plan, process, and complete associate departures. Capture exit-interview feedback."
        breadcrumbs={[{ label: 'Workforce' }, { label: 'Separations' }]}
      />

      {summary && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          <KpiCard label="Planned" value={String(summary.planned)} />
          <KpiCard label="In progress" value={String(summary.inProgress)} />
          <KpiCard
            label="Completed (90d)"
            value={String(summary.completedInWindow)}
          />
          <KpiCard
            label="Exit interviews (90d)"
            value={`${summary.exitInterviewCompletedInWindow} / ${summary.completedInWindow}`}
          />
          <KpiCard
            label="Avg rating (90d)"
            value={
              summary.averageRating !== null ? `${summary.averageRating} / 10` : '—'
            }
          />
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="flex gap-1">
          {(['PLANNED', 'IN_PROGRESS', 'COMPLETE', 'ALL'] as const).map((s) => (
            <Button
              key={s}
              size="sm"
              variant={filter === s ? 'primary' : 'ghost'}
              onClick={() => setFilter(s)}
            >
              {s}
            </Button>
          ))}
        </div>
        {canManage && (
          <Button onClick={() => setShowNew(true)}>
            <Plus className="mr-2 h-4 w-4" /> Initiate separation
          </Button>
        )}
      </div>

      <Card>
        <CardContent className="p-0">
          {rows === null ? (
            <div className="p-6">
              <SkeletonRows count={4} />
            </div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={LogOut}
              title="No separations"
              description={
                filter === 'PLANNED'
                  ? 'Nobody is currently scheduled to leave.'
                  : 'Nothing matches this filter.'
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Associate</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Last day</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Exit interview</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((s) => (
                  <TableRow
                    key={s.id}
                    className="cursor-pointer"
                    onClick={() => setOpenRow(s)}
                  >
                    <TableCell>
                      <div className="font-medium text-white">
                        {s.associateName}
                      </div>
                      <div className="text-xs text-silver">{s.associateEmail}</div>
                    </TableCell>
                    <TableCell className="text-sm text-silver">
                      {REASON_LABELS[s.reason]}
                    </TableCell>
                    <TableCell className="text-sm text-silver">
                      {s.lastDayWorked}
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[s.status]}>{s.status}</Badge>
                    </TableCell>
                    <TableCell>
                      {s.exitInterviewCompletedAt ? (
                        <Badge variant="success">
                          Done {s.rating !== null ? `· ${s.rating}/10` : ''}
                        </Badge>
                      ) : (
                        <Badge variant="outline">Pending</Badge>
                      )}
                    </TableCell>
                    <TableCell
                      className="text-right"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Button size="sm" variant="ghost" onClick={() => setOpenRow(s)}>
                        Open
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {showNew && (
        <NewSeparationDrawer
          onClose={() => setShowNew(false)}
          onSaved={() => {
            setShowNew(false);
            refresh();
          }}
        />
      )}
      {openRow && (
        <DetailDrawer
          row={openRow}
          canManage={canManage}
          onClose={() => setOpenRow(null)}
          onChanged={() => {
            setOpenRow(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function KpiCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs uppercase tracking-wider text-silver">{label}</div>
        <div className="text-2xl font-semibold text-white mt-1">{value}</div>
      </CardContent>
    </Card>
  );
}

function NewSeparationDrawer({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [associateId, setAssociateId] = useState('');
  const [reason, setReason] = useState<SeparationReason>(
    'VOLUNTARY_OTHER_OPPORTUNITY',
  );
  const today = new Date().toISOString().slice(0, 10);
  const [noticeDate, setNoticeDate] = useState(today);
  const [lastDayWorked, setLastDayWorked] = useState(
    new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  );
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!associateId.trim()) {
      toast.error('Associate ID required.');
      return;
    }
    setSaving(true);
    try {
      await initiateSeparation({
        associateId: associateId.trim(),
        reason,
        noticeDate,
        lastDayWorked,
      });
      toast.success('Separation initiated.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>Initiate separation</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>Associate ID</Label>
          <Input
            className="mt-1 font-mono text-xs"
            value={associateId}
            onChange={(e) => setAssociateId(e.target.value)}
          />
        </div>
        <div>
          <Label>Reason</Label>
          <select
            className="mt-1 w-full bg-midnight border border-navy-secondary rounded p-2 text-white text-sm"
            value={reason}
            onChange={(e) => setReason(e.target.value as SeparationReason)}
          >
            {(Object.keys(REASON_LABELS) as SeparationReason[]).map((k) => (
              <option key={k} value={k}>
                {REASON_LABELS[k]}
              </option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Notice date</Label>
            <Input
              type="date"
              className="mt-1"
              value={noticeDate}
              onChange={(e) => setNoticeDate(e.target.value)}
            />
          </div>
          <div>
            <Label>Last day worked</Label>
            <Input
              type="date"
              className="mt-1"
              value={lastDayWorked}
              onChange={(e) => setLastDayWorked(e.target.value)}
            />
          </div>
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={saving}>
          {saving ? 'Saving…' : 'Initiate'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

function DetailDrawer({
  row,
  canManage,
  onClose,
  onChanged,
}: {
  row: SeparationRow;
  canManage: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [rating, setRating] = useState<string>(
    row.rating !== null ? String(row.rating) : '',
  );
  const [reasonNotes, setReasonNotes] = useState(row.reasonNotes ?? '');
  const [positive, setPositive] = useState(row.feedbackPositive ?? '');
  const [improvement, setImprovement] = useState(row.feedbackImprovement ?? '');
  const [wouldRecommend, setWouldRecommend] = useState<'' | 'yes' | 'no'>(
    row.wouldRecommend === null ? '' : row.wouldRecommend ? 'yes' : 'no',
  );
  const [wouldReturn, setWouldReturn] = useState<'' | 'yes' | 'no'>(
    row.wouldReturn === null ? '' : row.wouldReturn ? 'yes' : 'no',
  );
  const [busy, setBusy] = useState(false);

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>{row.associateName}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div className="flex items-center gap-2">
          <Badge variant={STATUS_VARIANT[row.status]}>{row.status}</Badge>
          <span className="text-sm text-silver">{REASON_LABELS[row.reason]}</span>
        </div>
        <div className="text-xs text-silver">
          {row.noticeDate && `Notice ${row.noticeDate} · `}
          Last day {row.lastDayWorked}
          {row.finalPaycheckDate && ` · Final paycheck ${row.finalPaycheckDate}`}
        </div>

        {canManage && row.status !== 'COMPLETE' && (
          <Button
            variant="primary"
            onClick={async () => {
              setBusy(true);
              try {
                const r = await advanceSeparation(row.id);
                toast.success(`Advanced to ${r.status}.`);
                onChanged();
              } catch (err) {
                toast.error(err instanceof ApiError ? err.message : 'Failed.');
              } finally {
                setBusy(false);
              }
            }}
            disabled={busy}
          >
            Advance to {row.status === 'PLANNED' ? 'IN_PROGRESS' : 'COMPLETE'}
          </Button>
        )}

        {canManage && (
          <div className="space-y-3 pt-3 border-t border-navy-secondary">
            <div className="flex items-center gap-2 text-sm uppercase tracking-wider text-silver">
              <MessageSquareQuote className="h-4 w-4" /> Exit interview
            </div>
            <div>
              <Label>Rating (1–10)</Label>
              <Input
                type="number"
                min="1"
                max="10"
                className="mt-1 max-w-[80px]"
                value={rating}
                onChange={(e) => setRating(e.target.value)}
              />
            </div>
            <div>
              <Label>Reason in their words</Label>
              <textarea
                className="mt-1 w-full h-20 rounded-md border border-navy-secondary bg-midnight p-2 text-white text-sm"
                value={reasonNotes}
                onChange={(e) => setReasonNotes(e.target.value)}
              />
            </div>
            <div>
              <Label>What worked well</Label>
              <textarea
                className="mt-1 w-full h-20 rounded-md border border-navy-secondary bg-midnight p-2 text-white text-sm"
                value={positive}
                onChange={(e) => setPositive(e.target.value)}
              />
            </div>
            <div>
              <Label>What we should change</Label>
              <textarea
                className="mt-1 w-full h-20 rounded-md border border-navy-secondary bg-midnight p-2 text-white text-sm"
                value={improvement}
                onChange={(e) => setImprovement(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Would recommend us?</Label>
                <select
                  className="mt-1 w-full bg-midnight border border-navy-secondary rounded p-2 text-white text-sm"
                  value={wouldRecommend}
                  onChange={(e) =>
                    setWouldRecommend(e.target.value as '' | 'yes' | 'no')
                  }
                >
                  <option value="">—</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              </div>
              <div>
                <Label>Would return?</Label>
                <select
                  className="mt-1 w-full bg-midnight border border-navy-secondary rounded p-2 text-white text-sm"
                  value={wouldReturn}
                  onChange={(e) =>
                    setWouldReturn(e.target.value as '' | 'yes' | 'no')
                  }
                >
                  <option value="">—</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              </div>
            </div>
            <Button
              onClick={async () => {
                setBusy(true);
                try {
                  await submitExitInterview(row.id, {
                    rating: rating ? parseInt(rating, 10) : null,
                    reasonNotes: reasonNotes.trim() || null,
                    feedbackPositive: positive.trim() || null,
                    feedbackImprovement: improvement.trim() || null,
                    wouldRecommend:
                      wouldRecommend === '' ? null : wouldRecommend === 'yes',
                    wouldReturn:
                      wouldReturn === '' ? null : wouldReturn === 'yes',
                  });
                  toast.success('Exit interview saved.');
                  onChanged();
                } catch (err) {
                  toast.error(err instanceof ApiError ? err.message : 'Failed.');
                } finally {
                  setBusy(false);
                }
              }}
              disabled={busy}
            >
              {row.exitInterviewCompletedAt ? 'Update' : 'Save interview'}
            </Button>
          </div>
        )}
      </DrawerBody>
      <DrawerFooter>
        <Button onClick={onClose}>Close</Button>
      </DrawerFooter>
    </Drawer>
  );
}
