import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { CalendarPlus, Mail, Phone, UserCheck } from '@/components/ui/icons';
import { Card, CardContent } from '@/components/ui/Card';
import { cn } from '@/lib/cn';
import { useI18n } from '@/lib/i18n';
import { fmtDate } from '@/lib/format';
import { listReadyToSchedule } from '@/lib/readyToWorkApi';
import '@/lib/i18n/en/floorUi';

/**
 * A shift supervisor's queue of hires handed to their store with no first
 * shift yet: the associate's contact card and one link that opens
 * Scheduling on their row. Gone once each one has a shift or has punched
 * in. Renders nothing when the queue is empty.
 */
export function ReadyToScheduleCard({ className }: { className?: string }) {
  const { t } = useI18n();
  const q = useQuery({
    queryKey: ['ready-to-work', 'mine'],
    queryFn: () => listReadyToSchedule().catch(() => []),
    staleTime: 60_000,
  });
  const items = q.data ?? [];
  if (items.length === 0) return null;

  return (
    <Card className={cn('animate-enter', className)} data-testid="ready-to-schedule-card">
      <CardContent className="p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="flex items-center gap-1.5 text-sm font-medium text-white">
            <UserCheck className="h-4 w-4 text-gold" aria-hidden="true" />
            {t('floorUi.readyToSchedule')}
          </h2>
          <span className="text-xs tabular-nums text-silver/70">
            {items.length === 1 ? t('floorUi.newAssociateOne') : t('floorUi.newAssociatesMany', { n: items.length })}
          </span>
        </div>
        <p className="mt-1 text-xs text-silver/80">
          {t('floorUi.readyDesc')}
        </p>
        <ul className="mt-3 divide-y divide-navy-secondary/60">
          {items.map((item) => (
            <li key={item.associate.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="text-sm text-white">
                  {item.associate.name}
                  {item.associate.position && (
                    <span className="ml-2 text-xs text-silver/70">{item.associate.position}</span>
                  )}
                </div>
                <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-silver/80">
                  {item.store && <span>{item.store.name}</span>}
                  {item.associate.hireDate && <span>{t('floorUi.hiredOn', { date: fmtDate(item.associate.hireDate) })}</span>}
                  <span>{t('floorUi.clearedOn', { date: fmtDate(item.issuedAt) })}</span>
                  {item.nudgedAt && <span className="text-warning">{t('floorUi.waiting')}</span>}
                </div>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                  {item.associate.phone && (
                    <a
                      href={`tel:${item.associate.phone}`}
                      className="inline-flex items-center gap-1 text-gold hover:underline"
                    >
                      <Phone className="h-3 w-3" aria-hidden="true" />
                      {item.associate.phone}
                    </a>
                  )}
                  <a
                    href={`mailto:${item.associate.email}`}
                    className="inline-flex items-center gap-1 text-gold hover:underline"
                  >
                    <Mail className="h-3 w-3" aria-hidden="true" />
                    {item.associate.email}
                  </a>
                </div>
              </div>
              <Link
                to={`/scheduling?associate=${item.associate.id}`}
                className="inline-flex h-9 items-center gap-1.5 rounded-md border border-gold/40 bg-gold/10 px-3 text-sm text-gold hover:bg-gold/20"
              >
                <CalendarPlus className="h-4 w-4" aria-hidden="true" />
                {t('floorUi.schedule')}
              </Link>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
