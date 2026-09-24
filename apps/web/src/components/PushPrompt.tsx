import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BellRing } from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n';
import { getPushStatus, subscribeToPush } from '@/lib/push';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';

const DISMISSED_KEY = 'alto:portal-push-prompt-dismissed';

/**
 * "Get alerts on this device" — shown once on the portal and region home
 * pages while push is available and not yet on. Short-staffing alerts,
 * replies and messages then reach the phone with the app closed. Settings
 * stays the place to turn it on later or off again.
 */
export function PushPrompt() {
  const { t } = useI18n();
  const [status, setStatus] = useState<Awaited<ReturnType<typeof getPushStatus>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return window.localStorage.getItem(DISMISSED_KEY) === '1';
    } catch {
      return false;
    }
  });
  const statusQuery = useQuery({
    queryKey: ['PushPrompt', 'status'],
    queryFn: () => getPushStatus(),
  });
  useEffect(() => {
    const s = statusQuery.data;
    if (s === undefined) return;
    setStatus(s);
  }, [statusQuery.data]);

  if (dismissed || status !== 'available') return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      window.localStorage.setItem(DISMISSED_KEY, '1');
    } catch {
      /* per-device convenience only */
    }
  };
  const enable = async () => {
    setBusy(true);
    try {
      await subscribeToPush();
      toast.success(t('push.on'));
      setStatus('subscribed');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('push.failed'));
      getPushStatus()
        .then(setStatus)
        .catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="print:hidden">
      <CardContent className="flex flex-wrap items-center gap-3 p-4">
        <BellRing className="h-5 w-5 shrink-0 text-gold" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-white">{t('push.promptTitle')}</div>
          <div className="text-xs text-silver/70">{t('push.promptBody')}</div>
        </div>
        <div className="flex w-full gap-2 sm:w-auto">
          <Button size="sm" variant="ghost" onClick={dismiss} disabled={busy}>
            {t('push.notNow')}
          </Button>
          <Button size="sm" onClick={() => void enable()} loading={busy}>
            {t('push.turnOn')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
