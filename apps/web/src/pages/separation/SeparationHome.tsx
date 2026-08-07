import { useEffect, useState } from 'react';
import { AssociateLink } from '@/components/ui/AssociateLink';
import { Download, LogOut, MessageSquareQuote, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useConfirm } from '@/lib/confirm';
import { downloadCsv } from '@/lib/csv';
import { fmtDate, fmtDateTime, parseYmd, ymdLocal } from '@/lib/format';
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
import { statusTone } from '@/lib/status';
import {
  AssociatePicker,
  type PickedAssociate,
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
  PageHeader,
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

// Deliberate departure from the shared vocabulary: an IN_PROGRESS offboarding
// is actively being worked by HR (gold per the Badge contract), not a passive
// wait state. PLANNED / COMPLETE come from the shared status vocabulary.
const SEPARATION_STATUS_TONES = { IN_PROGRESS: 'accent' } as const;

const STATUS_LABELS: Record<SeparationStatus, string> = {
  PLANNED: 'Planned',
  IN_PROGRESS: 'In progress',
  COMPLETE: 'Complete',
};

export function SeparationHome() {
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:onboarding') : false;
  const [summary, setSummary] = useState<SeparationSummary | null>(null);
  const [rows, setRows] = useState<SeparationRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<SeparationStatus | 'ALL'>('PLANNED');
  const [showNew, setShowNew] = useState(false);
  const [openRow, setOpenRow] = useState<SeparationRow | null>(null);

  const refresh = () => {
    setRows(null);
    setLoadError(null);
    listSeparations({ status: filter === 'ALL' ? undefined : filter })
      .then((r) => setRows(r.separations))
      .catch((err) =>
        setLoadError(
          err instanceof ApiError
            ? err.message
            : 'Failed to load separations.',
        ),
      );
    getSeparationSummary(90)
      .then(setSummary)
      .catch(() => setSummary(null));
  };
  useEffect(() => {
    refresh();
  }, [filter]);

  const exportCsv = () => {
    if (!rows) return;
    downloadCsv(`separations-${ymdLocal()}.csv`, [
      [
        'Associate',
        'Email',
        'Reason',
        'Status',
        'Notice date',
        'Last day worked',
        'Final paycheck',
        'Exit interview',
        'Rating',
        'Would recommend',
        'Would return',
        'Initiated by',
        'Completed at',
      ],
      ...rows.map((s) => [
        s.associateName,
        s.associateEmail,
        REASON_LABELS[s.reason],
        STATUS_LABELS[s.status],
        s.noticeDate ?? '',
        s.lastDayWorked,
        s.finalPaycheckDate ?? '',
        s.exitInterviewCompletedAt ? 'Done' : 'Pending',
        s.rating ?? '',
        s.wouldRecommend === null ? '' : s.wouldRecommend ? 'Yes' : 'No',
        s.wouldReturn === null ? '' : s.wouldReturn ? 'Yes' : 'No',
        s.initiatedByEmail ?? '',
        s.completedAt ? fmtDateTime(s.completedAt) : '',
      ]),
    ]);
  };

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

      <div className="flex items-center justify-between flex-wrap gap-2">
        <SegmentedControl
          ariaLabel="Filter by separation status"
          options={(['PLANNED', 'IN_PROGRESS', 'COMPLETE', 'ALL'] as const).map(
            (s) => ({
              value: s,
              label: s === 'ALL' ? 'All' : STATUS_LABELS[s],
            }),
          )}
          value={filter}
          onChange={setFilter}
        />
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={exportCsv}
            disabled={!rows || rows.length === 0}
          >
            <Download className="mr-2 h-4 w-4" /> Export CSV
          </Button>
          {canManage && (
            <Button onClick={() => setShowNew(true)}>
              <Plus className="mr-2 h-4 w-4" /> Initiate separation
            </Button>
          )}
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {loadError ? (
            <div className="p-6">
              <ErrorBanner
                action={
                  <Button size="sm" variant="secondary" onClick={refresh}>
                    Retry
                  </Button>
                }
              >
                {loadError}
              </ErrorBanner>
            </div>
          ) : rows === null ? (
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
                  <TableHead className="hidden md:table-cell">Reason</TableHead>
                  <TableHead className="hidden md:table-cell">Last day</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden lg:table-cell">Exit interview</TableHead>
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
                        <AssociateLink associateId={s.associateId}>
                          {s.associateName}
                        </AssociateLink>
                      </div>
                      <div className="text-xs text-silver">{s.associateEmail}</div>
                      <div className="text-xs2 text-silver/70 md:hidden">
                        {fmtDate(parseYmd(s.lastDayWorked))} ·{' '}
                        {REASON_LABELS[s.reason]}
                      </div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-sm text-silver">
                      {REASON_LABELS[s.reason]}
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-sm text-silver">
                      {fmtDate(parseYmd(s.lastDayWorked))}
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusTone(s.status, { overrides: SEPARATION_STATUS_TONES })}>
                        {STATUS_LABELS[s.status]}
                      </Badge>
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
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
        <div className="text-xs2 font-medium uppercase tracking-[0.14em] text-silver/70">
          {label}
        </div>
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
  const [assoc, setAssoc] = useState<PickedAssociate | null>(null);
  const [reason, setReason] = useState<SeparationReason>(
    'VOLUNTARY_OTHER_OPPORTUNITY',
  );
  const [noticeDate, setNoticeDate] = useState(() => ymdLocal());
  // Two weeks out, computed via local date parts — epoch math around DST
  // (and UTC slicing) can land a day off for evening users west of UTC.
  const [lastDayWorked, setLastDayWorked] = useState(() => {
    const t = new Date();
    return ymdLocal(new Date(t.getFullYear(), t.getMonth(), t.getDate() + 14));
  });
  // Defaults to the last day worked; tracks it until manually edited.
  const [finalPaycheckDate, setFinalPaycheckDate] = useState(lastDayWorked);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!assoc) {
      toast.error('Pick an associate.');
      return;
    }
    setSaving(true);
    try {
      await initiateSeparation({
        associateId: assoc.id,
        reason,
        // '' fails the server's date regex — a cleared optional field
        // must go over as null, like its sibling below.
        noticeDate: noticeDate || null,
        lastDayWorked,
        finalPaycheckDate: finalPaycheckDate || null,
      });
      toast.success('Separation initiated.');
      onSaved();
    } catch (err) {
      toast.error(
        err instanceof ApiError
          ? err.message
          : 'Could not initiate the separation.',
      );
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
          <Label>Associate</Label>
          <div className="mt-1">
            <AssociatePicker value={assoc} onChange={setAssoc} />
          </div>
        </div>
        <div>
          <Label>Reason</Label>
          <Select
            className="mt-1"
            value={reason}
            onChange={(e) => setReason(e.target.value as SeparationReason)}
          >
            {(Object.keys(REASON_LABELS) as SeparationReason[]).map((k) => (
              <option key={k} value={k}>
                {REASON_LABELS[k]}
              </option>
            ))}
          </Select>
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
              onChange={(e) => {
                const v = e.target.value;
                // Keep the paycheck date in lockstep until it's been
                // deliberately changed away from the last day worked.
                setFinalPaycheckDate((p) => (p === lastDayWorked ? v : p));
                setLastDayWorked(v);
              }}
            />
          </div>
          <div>
            <Label>Final paycheck date</Label>
            <Input
              type="date"
              className="mt-1"
              value={finalPaycheckDate}
              onChange={(e) => setFinalPaycheckDate(e.target.value)}
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
  const confirm = useConfirm();

  const advance = async () => {
    const next = row.status === 'PLANNED' ? 'IN_PROGRESS' : 'COMPLETE';
    if (next === 'COMPLETE') {
      const ok = await confirm({
        title: 'Complete this separation?',
        description:
          `This marks ${row.associateName}'s separation complete. Their ` +
          'access is revoked and their biometric consent data (check-in ' +
          'selfies and face reference) is permanently purged — it cannot ' +
          'be recovered.',
        confirmLabel: 'Complete separation',
        destructive: true,
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const r = await advanceSeparation(row.id);
      toast.success(`Advanced to ${STATUS_LABELS[r.status]}.`);
      onChanged();
    } catch (err) {
      toast.error(
        err instanceof ApiError
          ? err.message
          : 'Could not advance the separation.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>
          <AssociateLink associateId={row.associateId}>
            {row.associateName}
          </AssociateLink>
        </DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div className="flex items-center gap-2">
          <Badge variant={statusTone(row.status, { overrides: SEPARATION_STATUS_TONES })}>
            {STATUS_LABELS[row.status]}
          </Badge>
          <span className="text-sm text-silver">{REASON_LABELS[row.reason]}</span>
        </div>
        <div className="text-xs text-silver">
          {row.noticeDate && `Notice ${fmtDate(parseYmd(row.noticeDate))} · `}
          Last day {fmtDate(parseYmd(row.lastDayWorked))}
          {row.finalPaycheckDate &&
            ` · Final paycheck ${fmtDate(parseYmd(row.finalPaycheckDate))}`}
        </div>

        {canManage && row.status !== 'COMPLETE' && (
          <Button variant="primary" onClick={advance} disabled={busy}>
            Advance to{' '}
            {row.status === 'PLANNED'
              ? STATUS_LABELS.IN_PROGRESS
              : STATUS_LABELS.COMPLETE}
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
              <Textarea
                className="mt-1 h-20"
                value={reasonNotes}
                onChange={(e) => setReasonNotes(e.target.value)}
              />
            </div>
            <div>
              <Label>What worked well</Label>
              <Textarea
                className="mt-1 h-20"
                value={positive}
                onChange={(e) => setPositive(e.target.value)}
              />
            </div>
            <div>
              <Label>What we should change</Label>
              <Textarea
                className="mt-1 h-20"
                value={improvement}
                onChange={(e) => setImprovement(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Would recommend us?</Label>
                <Select
                  className="mt-1"
                  value={wouldRecommend}
                  onChange={(e) =>
                    setWouldRecommend(e.target.value as '' | 'yes' | 'no')
                  }
                >
                  <option value="">—</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </Select>
              </div>
              <div>
                <Label>Would return?</Label>
                <Select
                  className="mt-1"
                  value={wouldReturn}
                  onChange={(e) =>
                    setWouldReturn(e.target.value as '' | 'yes' | 'no')
                  }
                >
                  <option value="">—</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </Select>
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
                  toast.error(
                    err instanceof ApiError
                      ? err.message
                      : 'Could not save the exit interview.',
                  );
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
