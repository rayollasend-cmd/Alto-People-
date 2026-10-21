import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ClipboardX } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { usePrompt } from '@/lib/confirm';
import { fmtDateTime } from '@/lib/format';
import { cancelOpsShift, closeOutOpsShift, type OpsShiftRow } from '@/lib/opsApi';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { SectionTitle } from '@/components/ui/SectionTitle';

/**
 * Shifts left running past their end — the supervisor walked out without
 * submitting. They aren't live (their headcount no longer counts toward
 * "on the floor"), they're exceptions: close one out as it stands, or void
 * one opened by mistake. Both stay on the record with who and why.
 */
export function NeverClosedCard({ shifts, onOpenRecord }: { shifts: OpsShiftRow[]; onOpenRecord: (id: string) => void }) {
  const { can } = useAuth();
  const prompt = usePrompt();
  const qc = useQueryClient();
  const canAct = can('manage:ops-library');
  const refresh = () => void qc.invalidateQueries({ queryKey: ['ops'] });
  const closeOut = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) => closeOutOpsShift(id, reason),
    onSuccess: (r) => {
      toast.success(r.closedIncomplete ? 'Closed out — filed incomplete, with the reason.' : 'Closed out.');
      refresh();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not close it out.'),
  });
  const voidIt = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => cancelOpsShift(id, reason),
    onSuccess: () => {
      toast.success('Voided — it stays on the record.');
      refresh();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not void it.'),
  });
  if (shifts.length === 0) return null;

  const askClose = async (s: OpsShiftRow) => {
    const reason = await prompt({
      title: `Close out ${s.department}?`,
      description: 'Files it with the counts as they stand. Open required items mark it incomplete.',
      reasonLabel: 'Note (optional)',
      reasonPlaceholder: 'Supervisor forgot to submit',
      required: false,
      confirmLabel: 'Close out',
    });
    if (reason === null) return;
    closeOut.mutate({ id: s.id, reason: reason.trim() || undefined });
  };
  const askVoid = async (s: OpsShiftRow) => {
    const reason = await prompt({
      title: `Void ${s.department}?`,
      description: 'For a shift opened by mistake. It stays on the record as voided.',
      reasonLabel: 'Why',
      confirmLabel: 'Void it',
      destructive: true,
    });
    if (reason && reason.trim().length >= 3) voidIt.mutate({ id: s.id, reason });
  };

  return (
    <Card className="border-warning/40">
      <CardContent className="space-y-3 p-4">
        <SectionTitle
          as="h3"
          icon={ClipboardX}
          title="Never closed"
          description="Still open 6 hours or more past their end — left out of the live numbers until someone closes them out."
          trailing={<span className="text-xs tabular-nums text-ink-muted">{shifts.length}</span>}
        />
        <ul className="divide-y divide-line">
          {shifts.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-3 py-2">
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onOpenRecord(s.id)}>
                <span className="block truncate text-sm font-medium text-ink">
                  {s.department} · {s.locationName ?? s.clientName}
                </span>
                <span className="block truncate text-xs text-ink-muted">
                  Opened {fmtDateTime(s.openedAt)}
                  {s.dueAt ? ` · ended ${fmtDateTime(s.dueAt)}` : ''} · {s.taskDone}/{s.taskTotal} tasks ·{' '}
                  {s.openedByAccount ?? s.openedByEmail ?? 'unknown account'}
                </span>
              </button>
              {canAct && (
                <span className="flex gap-2">
                  <Button size="xs" variant="secondary" onClick={() => void askClose(s)} loading={closeOut.isPending && closeOut.variables?.id === s.id}>
                    Close out
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => void askVoid(s)} loading={voidIt.isPending && voidIt.variables?.id === s.id}>
                    Void
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
