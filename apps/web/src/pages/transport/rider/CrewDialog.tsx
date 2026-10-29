import { useQuery } from '@tanstack/react-query';
import { useI18n } from '@/lib/i18n';
import { fmtMonthShortYear } from '@/lib/format';
import { getMyCrew } from '@/lib/transportApi';
import { personPhotoUrl } from '@/lib/photoUrl';
import { Avatar } from '@/components/ui/Avatar';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { QueryError } from '@/components/ui/QueryError';
import { Skeleton } from '@/components/ui/Skeleton';
import { PlateChip } from './PlateChip';
import '@/lib/i18n/en/ride';

/** The van to look for and who's driving it — the ride-hailing card. */
export function CrewDialog({ rideId, onClose }: { rideId: string; onClose: () => void }) {
  const { t } = useI18n();
  const q = useQuery({ queryKey: ['transport', 'me', 'crew', rideId], queryFn: () => getMyCrew(rideId) });
  const crew = q.data?.crew;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('ride.crewTitle')}</DialogTitle>
        </DialogHeader>
        {q.isError ? (
          <QueryError what={t('ride.load.crew')} query={q} />
        ) : !crew ? (
          <Skeleton className="h-40" />
        ) : (
          <div className="space-y-4">
            <div className="rounded-lg border border-line bg-surface-raised/40 p-4 text-center">
              <div className="text-2xs font-medium uppercase tracking-[0.18em] text-ink-muted">{t('ride.lookFor')}</div>
              {crew.van.plate && <PlateChip plate={crew.van.plate} size="lg" className="mt-2" />}
              <div className="mt-2 text-lg font-semibold text-ink">{crew.van.look || crew.van.name}</div>
              <div className="text-sm text-ink-muted">
                {crew.van.name} · {t('ride.crewSeats', { count: crew.van.capacity })}
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Avatar src={personPhotoUrl(crew.driver)} name={crew.driver.name} email="" size="lg" />
              <div className="min-w-0">
                <div className="text-base font-semibold text-ink">{crew.driver.name}</div>
                <div className="text-xs text-ink-muted">{t('ride.crewSince', { date: fmtMonthShortYear(crew.driver.since) })}</div>
                <div className="mt-0.5 text-xs text-ink-muted">
                  {t('ride.crewTrips', { count: crew.driver.trips })} · {t('ride.crewRiders', { count: crew.driver.riders })}
                </div>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
