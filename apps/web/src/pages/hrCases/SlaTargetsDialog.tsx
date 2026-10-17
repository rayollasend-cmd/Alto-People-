import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { CATEGORY_LABELS, getSlaTargets, updateSlaTargets, type CaseCategory, type CasePriority, type SlaTarget } from '@/lib/hrCases123Api';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { SkeletonRows } from '@/components/ui/Skeleton';

/**
 * The SLA grid (HR pack 2026-10): hours to resolution for every category ×
 * priority. A blank cell restores the built-in default. Read by anyone who
 * works the desk; changed by an HR administrator.
 */

const PRIORITIES: CasePriority[] = ['URGENT', 'HIGH', 'MEDIUM', 'LOW'];
const PRIORITY_LABEL: Record<CasePriority, string> = { URGENT: 'Urgent', HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low' };

export function SlaTargetsDialog({ open, canManage, onClose }: { open: boolean; canManage: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ['hrCases', 'sla-targets'], queryFn: getSlaTargets, enabled: open });
  const [draft, setDraft] = useState<Record<string, string>>({});
  useEffect(() => {
    if (query.data) {
      const next: Record<string, string> = {};
      for (const t of query.data.targets) next[`${t.category}:${t.priority}`] = String(t.targetHours);
      setDraft(next);
    }
  }, [query.data]);
  const targets = query.data?.targets ?? [];
  const byKey = new Map(targets.map((t) => [`${t.category}:${t.priority}`, t]));
  const categories = [...new Set(targets.map((t) => t.category))];
  const changed = targets.filter((t) => (draft[`${t.category}:${t.priority}`] ?? '') !== String(t.targetHours));

  const save = useMutation({
    mutationFn: () =>
      updateSlaTargets(
        changed.map((t) => {
          const v = (draft[`${t.category}:${t.priority}`] ?? '').trim();
          return { category: t.category, priority: t.priority, targetHours: v === '' ? null : Number(v) };
        }),
      ),
    onSuccess: () => {
      toast.success('SLA targets saved. New cases use them; open cases keep their due time.');
      void qc.invalidateQueries({ queryKey: ['hrCases'] });
      onClose();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save the targets.'),
  });

  const cell = (t: SlaTarget | undefined, category: CaseCategory, priority: CasePriority) => {
    const key = `${category}:${priority}`;
    return (
      <td key={key} className="px-2 py-1.5 text-right">
        <div className="flex items-center justify-end gap-1">
          <Input
            type="number"
            min={1}
            max={2160}
            className="w-20 text-right tabular-nums"
            aria-label={`${CATEGORY_LABELS[category]} ${PRIORITY_LABEL[priority]} target hours`}
            value={draft[key] ?? ''}
            disabled={!canManage}
            onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
          />
          {t?.custom && <Badge variant="accent" size="sm" withDot={false}>Custom</Badge>}
        </div>
      </td>
    );
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} confirmDiscard={() => changed.length > 0}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>SLA targets</DialogTitle>
          <DialogDescription>Hours to resolution by category and priority. The clock pauses while a case waits on the person. Clear a cell to go back to the default.</DialogDescription>
        </DialogHeader>
        {query.isLoading ? (
          <SkeletonRows count={6} />
        ) : query.isError ? (
          <div role="alert" className="text-sm text-alert">
            Could not load the targets.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs2 uppercase tracking-wider text-ink-muted">
                  <th className="px-2 py-1.5">Category</th>
                  {PRIORITIES.map((p) => (
                    <th key={p} className="px-2 py-1.5 text-right">
                      {PRIORITY_LABEL[p]} (h)
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {categories.map((c) => (
                  <tr key={c} className="border-t border-line">
                    <td className="px-2 py-1.5 text-ink">{CATEGORY_LABELS[c]}</td>
                    {PRIORITIES.map((p) => cell(byKey.get(`${c}:${p}`), c, p))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            {canManage ? 'Cancel' : 'Close'}
          </Button>
          {canManage && (
            <Button onClick={() => save.mutate()} loading={save.isPending} disabled={changed.length === 0}>
              Save targets
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The SLA chip on a case row: the same words the list, the drawer and the Inbox use. */
export function SlaChip({ sla }: { sla: { state: string; minutesLeft: number | null } }) {
  const hours = sla.minutesLeft === null ? null : Math.round(Math.abs(sla.minutesLeft) / 60);
  const left = hours === null ? '' : hours >= 48 ? `${Math.round(hours / 24)}d` : `${hours}h`;
  switch (sla.state) {
    case 'BREACHED':
      return <Badge variant="destructive">Past SLA{left ? ` · ${left}` : ''}</Badge>;
    case 'AT_RISK':
      return <Badge variant="pending">Due in {left}</Badge>;
    case 'ON_TRACK':
      return <Badge variant="outline">{left} left</Badge>;
    case 'PAUSED':
      return <Badge variant="default">Clock paused</Badge>;
    case 'MET':
      return <Badge variant="success">Met</Badge>;
    default:
      return <span className="text-xs text-ink-muted">—</span>;
  }
}
