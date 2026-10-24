import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CheckCircle2, ExternalLink } from '@/components/ui/icons';
import type { QboConflictRow } from '@alto-people/shared';
import { fmtDateTime } from '@/lib/format';
import { listQboConflicts, QBO_KEY, resolveQboConflict } from '@/lib/books/quickbooksApi';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { QueryError } from '@/components/ui/QueryError';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { cn } from '@/lib/cn';
import { errMsg } from './qboWords';

/** The differences waiting for a person: each side, field by field, and the three ways to settle it. */

const REASON: Record<QboConflictRow['reason'], { label: string; site: string; qbo: string }> = {
  BOTH_CHANGED: { label: 'Changed on both sides', site: 'Keep the version here', qbo: 'Keep QuickBooks’' },
  DELETED_IN_QUICKBOOKS: { label: 'Deleted in QuickBooks', site: 'Send it back to QuickBooks', qbo: 'Remove it here too' },
  SITE_PERIOD_CLOSED: { label: 'A closed month here', site: 'Leave the closed month alone', qbo: 'Post it in the first open month' },
  BOOKS_CLOSED: { label: 'QuickBooks’ books are closed', site: 'Send it anyway', qbo: 'Don’t send it' },
};

const STATUS_WORDS: Record<QboConflictRow['status'], string> = { OPEN: 'Open', KEPT_SITE: 'Kept the version here', KEPT_QUICKBOOKS: 'Kept QuickBooks’', DISMISSED: 'Dismissed' };

export function ConflictsPanel({ manage }: { manage: boolean }) {
  const [view, setView] = useState<'OPEN' | 'ALL'>('OPEN');
  const q = useQuery({ queryKey: [...QBO_KEY, 'conflicts', view], queryFn: () => listQboConflicts(view) });
  if (q.isError) return <QueryError what="the decisions" query={q} />;
  return (
    <div className="space-y-3">
      <SegmentedControl ariaLabel="Which decisions" value={view} onChange={setView} options={[{ value: 'OPEN', label: 'Waiting' }, { value: 'ALL', label: 'All, with what was decided' }]} />
      {!q.data ? (
        <SkeletonRows count={3} />
      ) : q.data.conflicts.length === 0 ? (
        <EmptyState icon={CheckCircle2} title={view === 'OPEN' ? 'Nothing waiting for a decision' : 'No decisions yet'} description="When a record changes on both sides, or lands in a closed month, it waits here." />
      ) : (
        <ul className="space-y-3">
          {q.data.conflicts.map((c) => (
            <li key={c.id}>
              <ConflictCard c={c} manage={manage} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ConflictCard({ c, manage }: { c: QboConflictRow; manage: boolean }) {
  const qc = useQueryClient();
  const words = REASON[c.reason] ?? REASON.BOTH_CHANGED;
  const decide = useMutation({
    mutationFn: (keep: 'SITE' | 'QUICKBOOKS' | 'DISMISS') => resolveQboConflict(c.id, keep),
    onSuccess: () => {
      toast.success('Decided — both sides are in step.');
      void qc.invalidateQueries({ queryKey: QBO_KEY });
    },
    onError: (err) => toast.error(errMsg(err, 'Couldn’t settle this.')),
  });
  return (
    <Card className={cn(c.status === 'OPEN' && 'border-warning/40')}>
      <CardContent className="space-y-3 py-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge size="sm" variant={c.status === 'OPEN' ? 'pending' : 'default'}>
                {c.status === 'OPEN' ? words.label : STATUS_WORDS[c.status]}
              </Badge>
              <span className="text-xs text-ink-muted">{`QuickBooks ${c.qboType} ${c.qboId} · ${fmtDateTime(c.createdAt)}`}</span>
            </div>
            <p className="mt-1 text-sm text-ink">{c.summary}</p>
            {c.resolvedAt && <p className="text-xs text-ink-muted">{`Decided ${fmtDateTime(c.resolvedAt)}${c.resolvedByName ? ` by ${c.resolvedByName}` : ''}`}</p>}
          </div>
          {c.link && (
            <Link to={c.link} className="inline-flex items-center gap-1 text-sm text-gold hover:underline">
              Open the record
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          )}
        </div>
        {c.fields.length > 0 && (
          <div className="overflow-x-auto rounded-md border border-line">
            <table className="w-full text-sm">
              <caption className="sr-only">What each side says</caption>
              <thead>
                <tr className="text-left text-xs text-ink-muted">
                  <th scope="col" className="px-3 py-2 font-medium">Field</th>
                  <th scope="col" className="px-3 py-2 font-medium">Here</th>
                  <th scope="col" className="px-3 py-2 font-medium">In QuickBooks</th>
                </tr>
              </thead>
              <tbody>
                {c.fields.map((f) => (
                  <tr key={f.label} className={cn('border-t border-line', f.differs && 'bg-warning/5')}>
                    <th scope="row" className="px-3 py-2 text-left font-normal text-ink-muted">{f.label}</th>
                    <td className={cn('px-3 py-2 tabular-nums', f.differs ? 'font-medium text-ink' : 'text-ink-muted')}>{f.site ?? '—'}</td>
                    <td className={cn('px-3 py-2 tabular-nums', f.differs ? 'font-medium text-ink' : 'text-ink-muted')}>{f.quickbooks ?? (c.reason === 'DELETED_IN_QUICKBOOKS' ? 'Deleted' : '—')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {manage && c.status === 'OPEN' && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => decide.mutate('SITE')} disabled={decide.isPending}>
              {words.site}
            </Button>
            <Button size="sm" variant="outline" onClick={() => decide.mutate('QUICKBOOKS')} disabled={decide.isPending}>
              {words.qbo}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => decide.mutate('DISMISS')} disabled={decide.isPending}>
              Leave both as they are
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
