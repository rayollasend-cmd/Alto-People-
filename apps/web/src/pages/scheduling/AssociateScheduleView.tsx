import { useEffect, useState } from 'react';
import type { Shift } from '@alto-people/shared';
import { listMyShifts } from '@/lib/schedulingApi';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';

function formatRange(s: Shift): string {
  const a = new Date(s.startsAt);
  const b = new Date(s.endsAt);
  return `${a.toLocaleString()} – ${b.toLocaleTimeString()}`;
}

function statusBadge(status: Shift['status']): { label: string; cls: string } {
  switch (status) {
    case 'ASSIGNED':
      return { label: 'Confirmed', cls: 'bg-gold/20 text-gold border-gold/40' };
    case 'OPEN':
      return { label: 'Open', cls: 'bg-silver/10 text-silver border-silver/30' };
    case 'COMPLETED':
      return { label: 'Worked', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' };
    case 'DRAFT':
      return { label: 'Draft', cls: 'bg-silver/10 text-silver border-silver/30' };
    case 'CANCELLED':
      return { label: 'Cancelled', cls: 'bg-alert/15 text-alert border-alert/30' };
  }
}

export function AssociateScheduleView() {
  const [shifts, setShifts] = useState<Shift[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await listMyShifts();
        setShifts(res.shifts);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Failed to load.');
      }
    })();
  }, []);

  return (
    <div className="max-w-3xl mx-auto">
      <header className="mb-6">
        <h1 className="font-display text-4xl md:text-5xl text-white mb-2 leading-tight">
          My schedule
        </h1>
        <p className="text-silver">Upcoming shifts assigned to you.</p>
      </header>

      {error && (
        <p role="alert" className="text-sm text-alert mb-4">
          {error}
        </p>
      )}
      {!shifts && <p className="text-silver">Loading…</p>}
      {shifts && shifts.length === 0 && (
        <p className="text-silver">No upcoming shifts assigned to you.</p>
      )}

      {shifts && shifts.length > 0 && (
        <ul className="space-y-3">
          {shifts.map((s) => {
            const badge = statusBadge(s.status);
            return (
              <li
                key={s.id}
                className="flex items-center justify-between gap-4 p-4 bg-navy border border-navy-secondary rounded-lg"
              >
                <div className="min-w-0">
                  <div className="text-white font-medium">
                    {s.position}{' '}
                    <span className="text-silver text-sm font-normal">
                      · {s.clientName ?? '—'}
                    </span>
                  </div>
                  <div className="text-sm text-silver tabular-nums">
                    {formatRange(s)}
                  </div>
                  {s.location && (
                    <div className="text-xs text-silver/70">{s.location}</div>
                  )}
                </div>
                <span
                  className={cn(
                    'shrink-0 text-xs uppercase tracking-widest px-2 py-1 rounded border',
                    badge.cls
                  )}
                >
                  {badge.label}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
