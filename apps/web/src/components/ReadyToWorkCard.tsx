import { useQuery } from '@tanstack/react-query';
import { CalendarCheck, Mail, MapPin, Phone } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/Card';
import { cn } from '@/lib/cn';
import { fmtDate } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { getMyReadyToWork, storeAddress } from '@/lib/readyToWorkApi';

/**
 * The associate's first-day kit, on their home page from the moment HR
 * issues their clock-in number until their first punch: where they work,
 * who runs the floor there (with a way to reach them), and what happens
 * next. The person to call is on the screen they open every day, not in
 * an email they cannot find.
 */
export function ReadyToWorkCard({ className }: { className?: string }) {
  const { t } = useI18n();
  const q = useQuery({
    queryKey: ['me', 'ready-to-work'],
    queryFn: () => getMyReadyToWork().catch(() => null),
    staleTime: 5 * 60_000,
  });
  const kit = q.data;
  if (!kit) return null;
  const address = storeAddress(kit.store);
  const where = kit.store?.name ?? kit.client.name;

  return (
    <Card className={cn('animate-enter', className)} data-testid="ready-to-work-card">
      <CardContent className="p-5">
        <h2 className="flex items-center gap-2 text-sm font-medium text-white">
          <CalendarCheck className="h-4 w-4 text-gold" aria-hidden="true" />
          {t('rtw.title')}
        </h2>
        <p className="mt-1.5 text-sm text-silver">
          {t('rtw.clearedAt')} <span className="font-medium text-white">{where}</span>
          {kit.store && kit.store.name !== kit.client.name ? (
            <span className="text-silver/70"> · {kit.client.name}</span>
          ) : null}
        </p>
        {address && (
          <p className="mt-1 flex items-start gap-1.5 text-xs text-silver/80">
            <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{address}</span>
          </p>
        )}

        <h3 className="mt-4 text-2xs font-medium uppercase tracking-wider text-silver/70">
          {t('rtw.supervisors')}
        </h3>
        {kit.supervisors.length === 0 ? (
          <p className="mt-1 text-sm text-silver">{t('rtw.noSupervisors')}</p>
        ) : (
          <ul className="mt-1.5 space-y-2">
            {kit.supervisors.map((s) => (
              <li key={s.userId} className="rounded-md border border-navy-secondary bg-navy-secondary/20 px-3 py-2">
                <div className="text-sm text-white">
                  {s.name}
                  {s.windows.length > 0 && (
                    <span className="ml-2 text-xs text-silver/70">{s.windows.join(' · ')}</span>
                  )}
                </div>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                  {s.phone && (
                    <a href={`tel:${s.phone}`} className="inline-flex items-center gap-1 text-gold hover:underline">
                      <Phone className="h-3 w-3" aria-hidden="true" />
                      {s.phone}
                    </a>
                  )}
                  <a href={`mailto:${s.email}`} className="inline-flex items-center gap-1 text-gold hover:underline">
                    <Mail className="h-3 w-3" aria-hidden="true" />
                    {s.email}
                  </a>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-4 border-t border-navy-secondary/60 pt-3">
          {kit.firstShiftAt ? (
            <p className="text-sm text-white">
              {t('rtw.firstShift')}{' '}
              <span className="font-medium">{fmtDate(kit.firstShiftAt)}</span>
            </p>
          ) : (
            <p className="text-sm text-silver">{t('rtw.next')}</p>
          )}
          <p className="mt-1 text-xs text-silver/70">{t('rtw.kioskReminder')}</p>
        </div>
      </CardContent>
    </Card>
  );
}
