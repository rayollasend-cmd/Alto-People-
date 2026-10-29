import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MonitorSmartphone } from '@/components/ui/icons';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { forgetMyDevice, listMyDevices } from '@/lib/accessApi';
import { fmtDate } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { useI18n } from '@/lib/i18n';
import '@/lib/i18n/en/settings';

/**
 * Access pack — the devices two-step sign-in remembers. Forget one and its
 * next password sign-in asks for the code again. Shown only when the
 * organization turned device trust on.
 */
export function DevicesCard() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['me', 'devices'], queryFn: listMyDevices });
  if (q.data && !q.data.enabled) return null;
  const forget = async (id: string) => {
    try {
      await forgetMyDevice(id);
      toast.success(t('settings.devices.forgotten'));
      await qc.invalidateQueries({ queryKey: ['me', 'devices'] });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('settings.devices.forgetFailed'));
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MonitorSmartphone className="h-4 w-4 text-gold" />
          {t('settings.devices.title')}
        </CardTitle>
        <CardDescription>{q.data ? t('settings.devices.descDays', { days: q.data.days }) : t('settings.devices.desc')}</CardDescription>
      </CardHeader>
      <CardContent>
        {!q.data ? (
          <Skeleton className="h-10 w-full" />
        ) : q.data.devices.length === 0 ? (
          <p className="text-sm text-ink-muted">{t('settings.devices.none')}</p>
        ) : (
          <ul className="divide-y divide-line">
            {q.data.devices.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-ink">{d.label}</div>
                  <div className="text-xs text-ink-muted">
                    {t('settings.devices.meta', { used: fmtDate(d.lastSeenAt), until: fmtDate(d.expiresAt) })}{d.ip ? ` · ${d.ip}` : ''}
                  </div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => void forget(d.id)}>{t('settings.devices.forget')}</Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
