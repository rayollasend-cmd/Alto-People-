import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Scale } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useAuth, useTerm } from '@/lib/auth';
import { fmtDate } from '@/lib/format';
import { calibrateReview, getCalibration, type CalibrationReview, type CalibrationReviewer } from '@/lib/performanceApi';
import { ListTemplate } from '@/components/templates';
import { AssociateLink } from '@/components/ui/AssociateLink';
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
  EmptyState,
  Field,
  FilterChip,
  Input,
  MetricCard,
  SectionTitle,
  Select,
  SkeletonRows,
  Textarea,
} from '@/components/ui';
import { QueryError } from '@/components/ui/QueryError';
import { cn } from '@/lib/cn';

/**
 * Review calibration: before reviews go out, every reviewer's ratings side
 * by side — the spread of 1–5 overall and per reviewer, and who rates well
 * above or below everyone else. A draft's rating can be moved, by someone
 * other than its reviewer, with a reason; the reviewer's own rating stays
 * beside it on the record.
 */

/** The last completed calendar quarter, as YYYY-MM-DD. */
function lastQuarter(now = new Date()): { from: string; to: string } {
  const q = Math.floor(now.getMonth() / 3) * 3;
  const start = new Date(now.getFullYear(), q - 3, 1);
  const end = new Date(now.getFullYear(), q, 0);
  const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { from: ymd(start), to: ymd(end) };
}

const LEAN_LABEL: Record<'generous' | 'strict', string> = {
  generous: 'Rates above everyone',
  strict: 'Rates below everyone',
};

const STATUS_LABEL: Record<CalibrationReview['status'], string> = {
  DRAFT: 'Not shared',
  SUBMITTED: 'Shared',
  ACKNOWLEDGED: 'Acknowledged',
};

/** Five bars, one per rating — the shape of how a group was rated. */
function Spread({ distribution, label }: { distribution: number[]; label: string }) {
  const max = Math.max(1, ...distribution);
  return (
    <div className="flex items-end gap-1" role="img" aria-label={`${label}: ${distribution.map((n, i) => `${n} rated ${i + 1}`).join(', ')}`}>
      {distribution.map((n, i) => (
        <div key={i} className="flex w-6 flex-col items-center gap-0.5">
          <div className="w-full rounded-sm bg-accent/70" style={{ height: `${Math.max(2, (n / max) * 40)}px` }} />
          <span className="text-2xs tabular-nums text-ink-muted">{i + 1}</span>
        </div>
      ))}
    </div>
  );
}

export function ReviewCalibration() {
  const { user } = useAuth();
  const term = useTerm();
  const qc = useQueryClient();
  const [range, setRange] = useState(lastQuarter);
  const [reviewer, setReviewer] = useState<string>('');
  const [onlyDrafts, setOnlyDrafts] = useState(true);
  const [moving, setMoving] = useState<CalibrationReview | null>(null);

  const data = useQuery({ queryKey: ['performance', 'calibration', range], queryFn: () => getCalibration(range) });
  const reviews = useMemo(
    () =>
      (data.data?.reviews ?? []).filter(
        (r) => (!onlyDrafts || r.status === 'DRAFT') && (!reviewer || (r.reviewerUserId ?? 'none') === reviewer),
      ),
    [data.data, onlyDrafts, reviewer],
  );
  const moved = (data.data?.reviews ?? []).filter((r) => r.originalRating !== null).length;
  const leaning = (data.data?.reviewers ?? []).filter((r) => r.lean).length;

  return (
    <ListTemplate
      title="Review calibration"
      subtitle="Every reviewer's ratings side by side, before reviews are shared."
      breadcrumbs={[{ label: 'Workforce' }, { label: 'Performance', to: '/performance' }, { label: 'Calibration' }]}
      secondaryActions={
        <Button asChild variant="ghost" size="sm">
          <Link to="/performance">All reviews</Link>
        </Button>
      }
      filters={
        <div className="flex flex-wrap items-end gap-3">
          <Field label="From">{(p) => <Input type="date" size="sm" value={range.from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} {...p} />}</Field>
          <Field label="To">{(p) => <Input type="date" size="sm" value={range.to} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} {...p} />}</Field>
        </div>
      }
    >
      {data.isError ? (
        <QueryError what="calibration" query={data} />
      ) : data.isLoading || !data.data ? (
        <SkeletonRows count={6} />
      ) : data.data.total === 0 ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState icon={Scale} title="No reviews in this period" description="Pick another period, or write reviews first — calibration reads the ratings they carry." />
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <MetricCard label="Reviews" value={data.data.total} hint={`${data.data.reviewers.length} reviewers`} />
            <MetricCard label="Average rating" value={data.data.mean === null ? '—' : data.data.mean.toFixed(2)} hint="Out of 5" />
            <MetricCard label="Reviewers far from the average" value={leaning} hint="0.75 or more away, 3+ reviews" />
            <MetricCard label="Ratings moved" value={moved} hint="In calibration, with a reason" />
          </div>

          <section aria-labelledby="cal-spread">
            <SectionTitle id="cal-spread" title="How ratings spread" />
            <Card>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap items-center gap-6">
                  <div>
                    <div className="mb-1 text-xs text-ink-muted">Everyone</div>
                    <Spread distribution={data.data.distribution} label="Everyone" />
                  </div>
                </div>
                <ul className="divide-y divide-line">
                  {data.data.reviewers.map((r: CalibrationReviewer) => (
                    <li key={r.reviewerUserId ?? 'none'} className="flex flex-wrap items-center gap-x-6 gap-y-2 py-3">
                      <div className="min-w-[10rem] flex-1">
                        <div className="text-sm text-ink">{r.name}</div>
                        <div className="text-xs tabular-nums text-ink-muted">
                          {r.count} review{r.count === 1 ? '' : 's'} · average {r.mean === null ? '—' : r.mean.toFixed(2)}
                          {r.delta !== 0 ? ` (${r.delta > 0 ? '+' : ''}${r.delta.toFixed(2)})` : ''}
                        </div>
                      </div>
                      <Spread distribution={r.distribution} label={r.name} />
                      {r.lean ? <Badge variant="pending">{LEAN_LABEL[r.lean]}</Badge> : <span className="w-24" />}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          </section>

          <section aria-labelledby="cal-reviews">
            <SectionTitle id="cal-reviews" title="Reviews" trailing={<span className="text-xs tabular-nums text-ink-muted">{reviews.length}</span>} />
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <FilterChip active={onlyDrafts} onClick={() => setOnlyDrafts(true)}>
                Not shared yet
              </FilterChip>
              <FilterChip active={!onlyDrafts} onClick={() => setOnlyDrafts(false)}>
                All
              </FilterChip>
              <label htmlFor="cal-reviewer" className="sr-only">
                Reviewer
              </label>
              <Select id="cal-reviewer" size="sm" value={reviewer} onChange={(e) => setReviewer(e.target.value)}>
                <option value="">Every reviewer</option>
                {data.data.reviewers.map((r) => (
                  <option key={r.reviewerUserId ?? 'none'} value={r.reviewerUserId ?? 'none'}>
                    {r.name}
                  </option>
                ))}
              </Select>
            </div>
            {reviews.length === 0 ? (
              <Card>
                <CardContent className="p-0">
                  <EmptyState icon={Scale} title="Nothing to calibrate here" description="Every review in this view has been shared. Switch to All to read them." />
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardContent className="p-0">
                  <ul className="divide-y divide-line">
                    {reviews.map((r) => {
                      const own = !!user && r.reviewerUserId === user.id;
                      return (
                        <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
                          <div className="min-w-0 flex-1">
                            <AssociateLink associateId={r.associateId} className="text-sm text-ink">
                              {r.associateName}
                            </AssociateLink>
                            <div className="text-xs text-ink-muted">
                              {r.reviewerName ?? 'No reviewer'} · {fmtDate(r.periodStart)} – {fmtDate(r.periodEnd)}
                            </div>
                            {r.calibrationNote && (
                              <div className="mt-1 text-xs text-ink-muted">
                                Moved from {r.originalRating} by {r.calibratedByName ?? 'HR'}: “{r.calibrationNote}”
                              </div>
                            )}
                          </div>
                          <span className={cn('text-lg font-semibold tabular-nums', r.originalRating !== null ? 'text-accent' : 'text-ink')} aria-label={`Rated ${r.overallRating} of 5`}>
                            {r.overallRating}
                          </span>
                          <Badge variant={r.status === 'DRAFT' ? 'pending' : 'outline'}>{STATUS_LABEL[r.status]}</Badge>
                          {r.status === 'DRAFT' && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={own}
                              title={own ? 'Someone other than the reviewer calibrates a review.' : undefined}
                              onClick={() => setMoving(r)}
                            >
                              Move rating
                            </Button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </CardContent>
              </Card>
            )}
          </section>
        </div>
      )}

      <MoveRatingDialog
        review={moving}
        worker={term('worker').toLowerCase()}
        onClose={() => setMoving(null)}
        onDone={() => {
          setMoving(null);
          void qc.invalidateQueries({ queryKey: ['performance'] });
        }}
      />
    </ListTemplate>
  );
}

function MoveRatingDialog({
  review,
  worker,
  onClose,
  onDone,
}: {
  review: CalibrationReview | null;
  worker: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [rating, setRating] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const save = useMutation({
    mutationFn: () => calibrateReview(review!.id, { rating: rating!, note: note.trim() }),
    onSuccess: () => {
      toast.success('Rating moved. The reviewer’s own rating stays on the record.');
      setRating(null);
      setNote('');
      onDone();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not move the rating.'),
  });
  const valid = rating !== null && rating !== review?.overallRating && note.trim().length >= 3;
  return (
    <Dialog open={!!review} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move {review?.associateName}&rsquo;s rating</DialogTitle>
          <DialogDescription>
            Rated {review?.overallRating} by {review?.reviewerName ?? 'the reviewer'}. The {worker} sees only the final rating once the review is shared; the
            reviewer&rsquo;s rating and your reason stay on the record.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <fieldset>
            <legend className="mb-2 text-sm text-ink">New rating</legend>
            <div className="flex gap-2">
              {[1, 2, 3, 4, 5].map((n) => (
                <FilterChip key={n} active={rating === n} onClick={() => setRating(n)} aria-label={`Rating ${n}`}>
                  {n}
                </FilterChip>
              ))}
            </div>
          </fieldset>
          <Field label="Why" required hint="Shown to anyone who opens this review's history.">
            {(p) => <Textarea rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} {...p} />}
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={!valid} loading={save.isPending}>
            Move rating
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
