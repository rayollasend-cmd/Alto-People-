import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, Trash2 } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import { deleteDrafts, getDraftSummary } from '@/lib/schedulingApi';
import { Button } from '@/components/ui/Button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * EVERY UNPUBLISHED DRAFT, AND THE OPTION TO BE RID OF THEM.
 *
 * The page already had a Drafts pill, but it counted only the shifts
 * already loaded — so a draft parked in a week outside the date filter was
 * invisible, and the honest answer to "do I have unpublished work?" was
 * "only within the dates you happen to be looking at". That is how weeks
 * of drafts went missing while quietly inflating hours and projected
 * labor. This asks the server instead, so the number is the real one.
 *
 * Deleting them is irreversible and takes somebody's half-built week with
 * it, so it is deliberately awkward: the count is shown first, broken down
 * by client, and the button only arms once the number has been typed back.
 * The server re-checks that count and refuses if it moved, which is the
 * case where two people tidy up at once.
 */
export function DraftsDialog({
  open,
  onClose,
  onDeleted,
  onReview,
}: {
  open: boolean;
  onClose: () => void;
  onDeleted: () => void;
  /** Jump to the earliest draft's week instead — the non-destructive way out. */
  onReview: () => void;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const summary = useQuery({
    queryKey: ['scheduling', 'drafts', 'summary'],
    queryFn: getDraftSummary,
    enabled: open,
  });
  const total = summary.data?.total ?? 0;
  const armed = typed.trim() === String(total) && total > 0;

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const { deleted } = await deleteDrafts(total);
      toast.success(`${deleted} draft${deleted === 1 ? '' : 's'} deleted.`);
      setTyped('');
      onDeleted();
      onClose();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'Could not delete the drafts.',
      );
      void summary.refetch();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Unpublished drafts</DialogTitle>
          <DialogDescription>
            Drafts are a scratch pad — nobody is rostered and nobody is paid, so they no
            longer count toward hours scheduled or projected labor.
          </DialogDescription>
        </DialogHeader>

        {summary.isLoading ? (
          <Skeleton className="h-28" />
        ) : total === 0 ? (
          <p className="text-sm text-success">Nothing unpublished. Every shift is live.</p>
        ) : (
          <div className="space-y-3">
            <div className="rounded-lg border border-navy-secondary p-3">
              <div className="flex items-baseline gap-2">
                <span className="font-display text-3xl leading-none text-warning tabular-nums">
                  {total}
                </span>
                <span className="text-sm text-silver">
                  unpublished draft{total === 1 ? '' : 's'}
                </span>
              </div>
              {summary.data?.earliestStartsAt && (
                <p className="mt-1 text-xs text-silver/70">
                  {fmtDate(summary.data.earliestStartsAt)}
                  {summary.data.latestStartsAt &&
                    summary.data.latestStartsAt !== summary.data.earliestStartsAt &&
                    ` — ${fmtDate(summary.data.latestStartsAt)}`}
                </p>
              )}
              <ul className="mt-2 space-y-0.5">
                {(summary.data?.byClient ?? []).map((c) => (
                  <li key={c.clientId} className="flex justify-between text-xs text-silver">
                    <span className="truncate">{c.clientName}</span>
                    <span className="tabular-nums">{c.count}</span>
                  </li>
                ))}
              </ul>
            </div>

            <ErrorBanner severity="warning">
              <span className="flex items-start gap-1.5">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <span>
                  Deleting cannot be undone, and a draft may be a week someone is
                  part-way through building. Review them first if you are not sure.
                </span>
              </span>
            </ErrorBanner>

            <label className="block text-sm">
              <span className="mb-1 block text-silver">
                Type <span className="font-semibold text-white tabular-nums">{total}</span> to
                confirm
              </span>
              <Input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                inputMode="numeric"
                placeholder={String(total)}
                aria-label={`Type ${total} to confirm deleting all drafts`}
              />
            </label>

            {error && <ErrorBanner>{error}</ErrorBanner>}
          </div>
        )}

        <DialogFooter className="sm:justify-between">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Close
          </Button>
          <span className="flex gap-2">
            {total > 0 && (
              <Button
                variant="secondary"
                onClick={() => {
                  onReview();
                  onClose();
                }}
                disabled={busy}
              >
                Review them
              </Button>
            )}
            {total > 0 && (
              <Button variant="destructive" onClick={() => void run()} loading={busy} disabled={!armed || busy}>
                <Trash2 className="h-4 w-4" />
                Delete all {total}
              </Button>
            )}
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
