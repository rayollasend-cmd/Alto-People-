import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock } from 'lucide-react';
import { fmtShiftWindow } from '@alto-people/shared';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/cn';
import { getShiftCoverageGaps, type ShiftCoverageGaps } from '@/lib/shiftWindowsApi';
import { Card, CardContent } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { SupervisorShiftDialog, type ShiftDialogUser } from '@/pages/admin/SupervisorShiftDialog';

/**
 * Shift leads — every store shift nobody leads, every supervisor with no
 * shift, and every floor supervisor with no shift or no shift supervisor,
 * across all clients, with the fix one tap away: tap a person to pick their
 * shift (and a floor supervisor's shift supervisor). A supervisor's shift is focus, not a lock; a shift with
 * no lead still pages every supervisor at the client, so this is a gap in
 * ownership, not in coverage.
 */
export function ShiftLeadsCard({
  hideWhenClear = false,
  onChanged,
  className,
  style,
}: {
  /** Render nothing when every shift has a lead (the users page). */
  hideWhenClear?: boolean;
  /** After a shift is assigned here — the host refreshes its own list. */
  onChanged?: () => void;
  className?: string;
  style?: React.CSSProperties;
}) {
  const { t } = useI18n();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ['shift-windows', 'gaps'], queryFn: getShiftCoverageGaps, staleTime: 60_000 });
  const [picking, setPicking] = useState<ShiftDialogUser | null>(null);

  const data = q.data;
  if (q.isError) return null;
  if (hideWhenClear && (!data || data.clients.length === 0)) return null;

  const open = (c: ShiftCoverageGaps['clients'][number], u: ShiftCoverageGaps['clients'][number]['supervisors'][number]) =>
    setPicking({
      id: u.userId,
      email: u.email,
      associateName: u.name,
      clientId: c.clientId,
      clientName: c.clientName,
      shiftWindows: u.windows,
      role: 'SHIFT_SUPERVISOR',
      leadUserId: null,
      leadName: null,
    });
  const openFloor = (
    c: ShiftCoverageGaps['clients'][number],
    f: NonNullable<ShiftCoverageGaps['clients'][number]['floorSupervisors']>[number],
  ) =>
    setPicking({
      id: f.userId,
      email: f.email,
      associateName: f.name,
      clientId: c.clientId,
      clientName: c.clientName,
      shiftWindows: f.windows,
      role: 'FLOOR_SUPERVISOR',
      leadUserId: null,
      leadName: null,
    });

  return (
    <Card className={cn(data && data.clients.length > 0 && 'border-warning/30', className)} style={style}>
      <CardContent className="p-4">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="flex items-center gap-1.5 text-sm font-medium text-white">
            <Clock className="h-4 w-4 text-gold" aria-hidden="true" />
            {t('shiftLeads.title')}
          </h2>
          {data && data.total > 0 && (
            <span className="text-xs tabular-nums text-silver/70">
              {t('shiftLeads.summary', { covered: data.covered, total: data.total })}
            </span>
          )}
        </div>
        {!data ? (
          <Skeleton className="mt-3 h-16" />
        ) : data.total === 0 ? (
          <p className="mt-2 text-sm text-silver/70">{t('shiftLeads.noneNamed')}</p>
        ) : data.clients.length === 0 ? (
          <p className="mt-2 text-sm text-success">{t('shiftLeads.allClear')}</p>
        ) : (
          <ul className="mt-3 space-y-3">
            {data.clients.map((c) => (
              <li key={c.clientId} className="text-xs">
                <div className="font-medium text-white">{c.clientName}</div>
                {c.uncovered.length > 0 && (
                  <ul className="mt-1 space-y-0.5">
                    {c.uncovered.map((w) => (
                      <li key={`${w.locationId}|${w.label}`} className="text-silver">
                        <span className="text-warning">{t('shiftLeads.noLead')}</span> · {w.label}{' '}
                        <span className="text-silver/60">
                          {fmtShiftWindow(w)} · {w.locationName}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {c.supervisors.length === 0 ? (
                  <p className="mt-1 text-silver/60">{t('shiftLeads.noSupervisor')}</p>
                ) : (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <span className="text-silver/60">{t('shiftLeads.assign')}</span>
                    {c.supervisors.map((u) => {
                      const none = c.noShift.includes(u.userId);
                      return (
                        <button
                          key={u.userId}
                          type="button"
                          onClick={() => open(c, u)}
                          className={cn(
                            'rounded-full border px-2 py-0.5 transition hover:border-gold/50 hover:text-white coarse:min-h-9',
                            none ? 'border-warning/40 text-warning' : 'border-navy-secondary text-silver',
                          )}
                          title={
                            none
                              ? t('shiftLeads.noShift')
                              : u.windows.map((w) => w.label).join(', ')
                          }
                        >
                          {u.name}
                          {none && <span className="ml-1 opacity-80">· {t('shiftLeads.noShift')}</span>}
                        </button>
                      );
                    })}
                  </div>
                )}
                {c.floorSupervisors && c.floorSupervisors.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <span className="text-silver/60">Floor supervisors:</span>
                    {c.floorSupervisors.map((f) => (
                      <button
                        key={f.userId}
                        type="button"
                        onClick={() => openFloor(c, f)}
                        className="rounded-full border border-warning/40 px-2 py-0.5 text-warning transition hover:border-gold/50 hover:text-white coarse:min-h-9"
                      >
                        {f.name}
                        <span className="ml-1 opacity-80">
                          · {f.noShift && f.noLead ? 'no shift or shift supervisor' : f.noShift ? t('shiftLeads.noShift') : 'no shift supervisor'}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      {picking && (
        <SupervisorShiftDialog
          user={picking}
          open
          onOpenChange={(o) => !o && setPicking(null)}
          onSaved={() => {
            void queryClient.invalidateQueries({ queryKey: ['shift-windows', 'gaps'] });
            onChanged?.();
          }}
          readOnly={!can('manage:org')}
        />
      )}
    </Card>
  );
}
