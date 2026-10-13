import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bus, CheckCircle2, LifeBuoy, Siren } from 'lucide-react';
import type { EmergencyCheckInStatus, MyEmergencyResponse } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { emergencyCheckIn, getMyEmergency } from '@/lib/emergencyApi';
import { useI18n } from '@/lib/i18n';
import { fmtTime } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { cn } from '@/lib/cn';

/**
 * THE ONE TAP.
 *
 * While an emergency that includes this associate is active, this card sits
 * at the top of their home: what was declared, in their language, and two
 * buttons — I'm safe, I need help — plus a ride switch when evacuation
 * vans are running. It renders nothing the rest of the year, so it is its
 * own feature switch: declaring is what turns it on.
 */
export function EmergencyBanner() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['emergency', 'me'],
    queryFn: getMyEmergency,
    // A storm is the one time a stale answer costs something: poll.
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
  const [needsRide, setNeedsRide] = useState<boolean | null>(null);
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const emergency = q.data?.emergency ?? null;
  const checkIn = q.data?.checkIn ?? null;

  const respond = useMutation({
    mutationFn: (status: EmergencyCheckInStatus) =>
      emergencyCheckIn(emergency!.id, { status, needsRide: needsRide ?? checkIn?.needsRide ?? false }),
    onSuccess: (data: MyEmergencyResponse) => {
      qc.setQueryData(['emergency', 'me'], data);
      setChanging(false);
      setError(null);
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError && err.code === 'no_address') setError(t('emergency.noAddress'));
      else setError(t('emergency.failed'));
    },
  });

  if (!emergency) return null;
  const rideOn = needsRide ?? checkIn?.needsRide ?? false;
  const answered = checkIn && !changing;

  return (
    <Card className="mb-4 border-alert/60 bg-alert/10" role="region" aria-label={t('emergency.title', { title: emergency.title })}>
      <CardContent className="space-y-3 pt-4">
        <div className="flex items-start gap-3">
          <Siren className="mt-0.5 h-5 w-5 shrink-0 text-alert" aria-hidden="true" />
          <div className="min-w-0 space-y-1">
            <h2 className="text-base font-semibold text-white">{t('emergency.title', { title: emergency.title })}</h2>
            <p className="whitespace-pre-line text-sm text-white/90">{emergency.message}</p>
            <p className="text-xs text-silver">{t('emergency.shiftsSuspended')}</p>
          </div>
        </div>

        {answered ? (
          <div className="space-y-2">
            <p className="flex items-center gap-2 text-sm text-white">
              {checkIn.status === 'SAFE' ? (
                <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />
              ) : (
                <LifeBuoy className="h-4 w-4 text-warning" aria-hidden="true" />
              )}
              {checkIn.status === 'SAFE'
                ? t('emergency.respondedSafe', { time: fmtTime(checkIn.respondedAt) })
                : t('emergency.respondedHelp', { time: fmtTime(checkIn.respondedAt) })}
            </p>
            {checkIn.needsRide && (
              <p className="flex items-center gap-2 text-sm text-silver">
                <Bus className="h-4 w-4" aria-hidden="true" />
                {checkIn.ride && checkIn.ride.status !== 'REQUESTED' ? t('emergency.rideBooked') : t('emergency.rideRequested')}
              </p>
            )}
            <Button variant="ghost" size="sm" onClick={() => setChanging(true)}>
              {t('emergency.change')}
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm font-medium text-white">{t('emergency.prompt')}</p>
            {emergency.rideOffered && (
              <label className={cn('flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm', rideOn ? 'border-gold/60 bg-gold/10' : 'border-navy-secondary')}>
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4"
                  checked={rideOn}
                  onChange={(e) => setNeedsRide(e.target.checked)}
                />
                <span>
                  <span className="block text-white">{t('emergency.needRide')}</span>
                  <span className="block text-xs text-silver">{t('emergency.rideHint')}</span>
                </span>
              </label>
            )}
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="primary"
                className="min-h-12"
                onClick={() => respond.mutate('SAFE')}
                disabled={respond.isPending}
              >
                {respond.isPending ? t('emergency.sending') : t('emergency.safe')}
              </Button>
              <Button
                variant="destructive"
                className="min-h-12"
                onClick={() => respond.mutate('NEEDS_HELP')}
                disabled={respond.isPending}
              >
                {t('emergency.needHelp')}
              </Button>
            </div>
            {error && (
              <p className="text-sm text-alert" role="alert">
                {error}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
