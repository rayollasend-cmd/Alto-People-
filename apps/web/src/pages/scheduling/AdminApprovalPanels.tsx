import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { BellRing } from 'lucide-react';
import {
  listUnconfirmedShifts,
  nudgeUnconfirmedShifts,
  type UnconfirmedShiftRow,
} from '@/lib/schedulingApi';
import { ApiError } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Avatar } from '@/components/ui/Avatar';
import { toast } from '@/components/ui/Toaster';
import { fmtRelativeDayTz, fmtTime } from '@/lib/format';
import { cn } from '@/lib/cn';

/**
 * The unconfirmed-shifts chase panel, shared by /approvals (the decisions
 * inbox) and anywhere else that needs it. Its own small module so the
 * approvals chunk never drags in the scheduling views. (The swap and
 * pickup panels that also lived here were /scheduling's second copy of
 * the inbox; that copy is gone — /approvals owns them.)
 */

/* ===== Unconfirmed shifts panel ========================================== */

/**
 * Published, assigned shifts starting in the next 48h whose associate has
 * NOT tapped "I'll be there". Hidden entirely when everyone confirmed —
 * this panel exists to chase silence, not to celebrate compliance.
 */
const UNCONFIRMED_KEY = ['approvals', 'unconfirmed'] as const;

export function AdminUnconfirmedPanel({ className = 'mt-8' }: { className?: string } = {}) {
  const [nudging, setNudging] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const unconfirmedQuery = useQuery({
    queryKey: UNCONFIRMED_KEY,
    queryFn: async () => {
      try {
        // Dedicated endpoint: exactly the chase rows, phone included —
        // "worth a call" is useless advice without the number on screen.
        return (await listUnconfirmedShifts()).shifts;
      } catch {
        // Best-effort chase list — a load failure just hides the panel.
        return [];
      }
    },
  });
  const items = unconfirmedQuery.data ?? null;

  // One group per start time — the crew that walks in together — so a
  // 21-person evening reads as faces under one line, never "Unconfirmed"
  // twenty-one times (the store manager's Day page, same grammar).
  const groups = useMemo(() => {
    const byStart = new Map<string, UnconfirmedShiftRow[]>();
    for (const r of items ?? []) {
      const list = byStart.get(r.startsAt) ?? [];
      list.push(r);
      byStart.set(r.startsAt, list);
    }
    return [...byStart.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([startsAt, rows]) => ({ startsAt, rows }));
  }, [items]);
  // The client only earns a place on a row when rows span clients.
  const multiClient = new Set((items ?? []).map((r) => r.clientName ?? '')).size > 1;

  if (!items || items.length === 0) return null;
  const picked = items.find((r) => r.shiftId === selected) ?? null;

  return (
    <Card className={className}>
      <CardContent className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-sm font-medium text-white">
            <BellRing className="h-4 w-4 text-warning" aria-hidden="true" />
            Not confirmed yet
            <span className="rounded-full bg-navy-secondary px-2 py-0.5 text-2xs tabular-nums text-silver">
              {items.length}
            </span>
          </h2>
          <Button
            size="sm"
            variant="outline"
            loading={nudging}
            onClick={() => {
              setNudging(true);
              nudgeUnconfirmedShifts()
                .then((r) => {
                  toast.success(
                    r.nudged > 0
                      ? `Reminder sent to ${r.nudged} associate${r.nudged === 1 ? '' : 's'} — asked to tap "I'll be there".`
                      : 'Everyone here was already reminded in the last 20 hours.',
                  );
                })
                .catch((err) => {
                  toast.error(
                    err instanceof ApiError ? err.message : 'Could not send reminders.',
                  );
                })
                .finally(() => setNudging(false));
            }}
            title='One tap asks every unconfirmed associate to confirm; anyone reminded in the last 20 hours is skipped. The system also auto-reminds 24 hours before start.'
          >
            Remind everyone
          </Button>
        </div>
        <p className="mt-1 text-xs text-silver/70">
          Starting in the next 48 hours without an &ldquo;I&rsquo;ll be there.&rdquo; Reminders
          also go out automatically 24 hours ahead. Tap a face for the name and number.
        </p>

        <div className="mt-4 space-y-4">
          {groups.map((g) => {
            const positions = [...new Set(g.rows.map((r) => r.position))];
            return (
              <div key={g.startsAt}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                  <span className="text-sm text-white tabular-nums">
                    {fmtRelativeDayTz(g.startsAt)} · {fmtTime(g.startsAt)}
                  </span>
                  <span className="text-xs text-silver/70">
                    {positions.slice(0, 3).join(', ')}
                    {positions.length > 3 ? ` +${positions.length - 3}` : ''}
                    <span className="text-warning"> · {g.rows.length} to confirm</span>
                  </span>
                </div>
                <ul className="mt-2 flex flex-wrap gap-2" role="list">
                  {g.rows.map((r) => {
                    const isSel = selected === r.shiftId;
                    const label = `${r.associateName} · ${r.position}${
                      multiClient && r.clientName ? ` · ${r.clientName}` : ''
                    }`;
                    return (
                      <li key={r.shiftId}>
                        <button
                          type="button"
                          onClick={() => setSelected(isSel ? null : r.shiftId)}
                          aria-pressed={isSel}
                          aria-label={label}
                          title={label}
                          className={cn(
                            'block rounded-full transition-transform focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
                            'coarse:active:scale-95',
                            isSel && 'scale-110',
                          )}
                        >
                          <Avatar
                            src={`/api/associates/${r.associateId}/photo`}
                            name={r.associateName}
                            email=""
                            size="md"
                            className={cn(
                              'ring-2 ring-offset-2 ring-offset-navy',
                              isSel ? 'ring-gold' : 'ring-warning/50',
                            )}
                          />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>

        {/* The picked face: who, what, and the number — "worth a call". */}
        <div
          className={cn(
            'mt-3 flex min-h-6 flex-wrap items-center gap-x-3 gap-y-1 text-sm transition-opacity',
            picked ? 'opacity-100' : 'opacity-0',
          )}
          aria-live="polite"
        >
          {picked && (
            <>
              <Link
                to={`/people?associateId=${picked.associateId}`}
                className="font-medium text-white hover:text-gold"
                title="Open this associate's profile"
              >
                {picked.associateName}
              </Link>
              <span className="text-silver">
                {picked.position}
                {multiClient && picked.clientName ? ` · ${picked.clientName}` : ''} ·{' '}
                {fmtRelativeDayTz(picked.startsAt)} · {fmtTime(picked.startsAt)}
              </span>
              {picked.phone && (
                <a href={`tel:${picked.phone}`} className="text-sky tabular-nums hover:underline">
                  Call {picked.phone}
                </a>
              )}
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
