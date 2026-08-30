import { useRef, useState } from 'react';
import { CheckCircle2, UserCheck, X as XIcon } from 'lucide-react';
import { toast } from 'sonner';
import type { ApplicationSummary, BulkApproveResultRow } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { bulkApproveApplications } from '@/lib/onboardingApi';
import { ymdLocal } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { cn } from '@/lib/cn';

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** The eligible (100% complete, non-terminal) selected rows. */
  applications: ApplicationSummary[];
  /** Called after at least one approval succeeded so the parent refetches. */
  onApproved: () => void;
}

/**
 * One shared hire date for the whole batch → POST /applications/bulk-approve.
 * Per-row failures (verification warnings, already decided, …) surface in a
 * result list after submit — same pattern as BulkInviteDialog. Bulk never
 * acknowledges verification warnings; those rows must be opened one by one.
 */
export function BulkApproveDialog({ open, onOpenChange, applications, onApproved }: Props) {
  const [hireDate, setHireDate] = useState(() => ymdLocal());
  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState<BulkApproveResultRow[] | null>(null);

  // Snapshotted at submit — onApproved clears the parent's selection,
  // which empties `applications` while the results panel is still up.
  const nameByIdRef = useRef<Map<string, string>>(new Map());

  const reset = () => {
    setHireDate(ymdLocal());
    setResults(null);
  };

  const submit = async () => {
    if (!hireDate) {
      toast.error('Pick a hire date.');
      return;
    }
    setSubmitting(true);
    nameByIdRef.current = new Map(applications.map((a) => [a.id, a.associateName]));
    try {
      const res = await bulkApproveApplications({
        applicationIds: applications.map((a) => a.id),
        hireDate,
      });
      setResults(res.results);
      if (res.succeeded > 0) onApproved();
      if (res.failed === 0) {
        toast.success(`Approved ${res.succeeded} application${res.succeeded === 1 ? '' : 's'}.`);
      } else if (res.succeeded === 0) {
        toast.error(`All ${res.failed} approvals failed.`);
      } else {
        toast.message(`Approved ${res.succeeded}, ${res.failed} failed.`, {
          description: 'Open the failed rows individually to review their warnings.',
        });
      }
    } catch (err) {
      const msg =
        err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Bulk approve failed.';
      toast.error('Could not bulk approve.', { description: msg });
    } finally {
      setSubmitting(false);
    }
  };

  // After submit the parent clears its selection (emptying `applications`)
  // while the results panel is still up — count from the results instead.
  const n = results ? results.length : applications.length;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Approve {n} application{n === 1 ? '' : 's'}
          </DialogTitle>
          <DialogDescription>
            One hire date applies to the whole batch. Each new hire (and their
            manager) is emailed, their login activates, and their site
            assignment opens. Rows with verification gaps fail here — open
            those individually to review the warnings.
          </DialogDescription>
        </DialogHeader>

        {results ? (
          <BulkApproveResultsPanel results={results} nameById={nameByIdRef.current} />
        ) : (
          <div className="space-y-3">
            <Field label="Hire date" required hint="Defaults to today.">
              {(p) => (
                <Input
                  type="date"
                  value={hireDate}
                  onChange={(e) => setHireDate(e.target.value)}
                  {...p}
                />
              )}
            </Field>
            <div className="rounded-md border border-navy-secondary divide-y divide-navy-secondary max-h-48 overflow-auto">
              {applications.map((a) => (
                <div key={a.id} className="p-2 text-xs flex items-center gap-2">
                  <span className="text-white truncate">{a.associateName}</span>
                  <span className="text-silver/70 truncate">· {a.clientName}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <DialogFooter>
          {results ? (
            <Button onClick={() => onOpenChange(false)}>Close</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={submit} loading={submitting} disabled={!hireDate || n === 0}>
                <UserCheck className="h-4 w-4" />
                Approve {n}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BulkApproveResultsPanel({
  results,
  nameById,
}: {
  results: BulkApproveResultRow[];
  nameById: Map<string, string>;
}) {
  const failed = results.filter((r) => !r.ok);
  const succeeded = results.filter((r) => r.ok);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-4 text-sm">
        <span className="text-success">
          <CheckCircle2 className="inline h-4 w-4 mr-1 -mt-0.5" />
          {succeeded.length} approved
        </span>
        {failed.length > 0 && (
          <span className="text-alert">
            <XIcon className="inline h-4 w-4 mr-1 -mt-0.5" />
            {failed.length} failed
          </span>
        )}
      </div>
      <div className="rounded-md border border-navy-secondary divide-y divide-navy-secondary max-h-72 overflow-auto">
        {results.map((r) => (
          <div
            key={r.applicationId}
            className={cn(
              'p-2 text-xs flex items-start gap-2',
              r.ok ? 'bg-success/[0.04]' : 'bg-alert/[0.06]'
            )}
          >
            {r.ok ? (
              <CheckCircle2 className="h-3.5 w-3.5 text-success mt-0.5 shrink-0" />
            ) : (
              <XIcon className="h-3.5 w-3.5 text-alert mt-0.5 shrink-0" />
            )}
            <div className="min-w-0 flex-1">
              <div className="text-silver truncate">
                {nameById.get(r.applicationId) ?? r.applicationId}
              </div>
              {!r.ok && r.errorMessage && (
                <div className="text-alert mt-0.5">
                  {r.errorCode}: {r.errorMessage}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
