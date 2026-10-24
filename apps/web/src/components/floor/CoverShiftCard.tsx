import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarPlus, Check, Clock, Minus } from '@/components/ui/icons';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { coverShift, type CoverStep } from '@/lib/floorApi';
import { listShifts } from '@/lib/schedulingApi';
import { fmtShiftRangeTz, fmtRelativeDayTz } from '@/lib/format';
import { cn } from '@/lib/cn';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { Button } from '@/components/ui/Button';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Card, CardContent } from '@/components/ui/Card';

/**
 * "Cover this shift" — one tap that runs the three moves a supervisor used
 * to make by hand: post it to Open shifts, ask the bench, and let the agent
 * propose a fill. The card lists the next two days' open shifts at their
 * store; each tap shows the three steps as they land.
 */

const STEP_LABEL: Record<CoverStep['key'], MessageKey> = { post: 'floorUi.stepPosted', bench: 'floorUi.benchAsked', agent: 'floorUi.stepAgent' };
const DAY_MS = 86_400_000;

export function CoverShiftCard({ className }: { className?: string }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [steps, setSteps] = useState<Record<string, CoverStep[]>>({});
  const q = useQuery({
    queryKey: ['floor', 'open-soon'],
    queryFn: () => {
      const from = new Date();
      return listShifts({ from: from.toISOString(), to: new Date(from.getTime() + 2 * DAY_MS).toISOString(), status: 'OPEN' });
    },
    refetchInterval: 60_000,
  });
  const open = (q.data?.shifts ?? []).filter((s) => s.status === 'OPEN' && new Date(s.startsAt).getTime() > Date.now()).slice(0, 6);
  if (open.length === 0) return null;

  const cover = async (shiftId: string) => {
    setBusy(shiftId);
    try {
      const r = await coverShift(shiftId);
      setSteps((prev) => ({ ...prev, [shiftId]: r.steps }));
      toast.success(t('floorUi.coveringToast'));
      void qc.invalidateQueries({ queryKey: ['inbox'] });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('floorUi.coverFailed'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className={cn('animate-enter border-warning/30', className)} data-testid="cover-shift">
      <CardContent className="p-5">
        <SectionTitle icon={CalendarPlus} title={t('floorUi.openNextTwoDays')} trailing={<span className="text-xs tabular-nums text-ink-muted">{open.length}</span>} />
        <ul className="divide-y divide-navy-secondary/60">
          {open.map((s) => {
            const done = steps[s.id];
            return (
              <li key={s.id} className="py-2.5">
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-ink tabular-nums">
                      {fmtRelativeDayTz(s.startsAt, s.timezone)} · {fmtShiftRangeTz(s.startsAt, s.endsAt, s.timezone)}
                    </div>
                    <div className="text-xs text-silver">
                      {s.position}
                      {s.locationName ? ` · ${s.locationName}` : ''}
                    </div>
                  </div>
                  {done ? (
                    <span className="text-xs text-success">{t('floorUi.covering')}</span>
                  ) : (
                    <Button size="sm" loading={busy === s.id} disabled={busy !== null} onClick={() => void cover(s.id)}>
                      {t('floorUi.coverThisShift')}
                    </Button>
                  )}
                </div>
                {done && (
                  <ol className="mt-2 grid grid-cols-3 gap-2" aria-label={t('floorUi.coverProgress')}>
                    {done.map((st) => (
                      <li key={st.key} className="rounded-md border border-navy-secondary/60 bg-navy-secondary/20 px-2 py-1.5">
                        <div className={cn('flex items-center gap-1 text-xs font-medium', st.status === 'done' ? 'text-success' : st.status === 'waiting' ? 'text-gold' : 'text-silver/70')}>
                          {st.status === 'done' ? <Check className="h-3 w-3" aria-hidden="true" /> : st.status === 'waiting' ? <Clock className="h-3 w-3" aria-hidden="true" /> : <Minus className="h-3 w-3" aria-hidden="true" />}
                          {t(STEP_LABEL[st.key])}
                        </div>
                        <div className="mt-0.5 text-2xs text-silver/80">{st.detail}</div>
                      </li>
                    ))}
                  </ol>
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
