import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, Smartphone } from '@/components/ui/icons';
import { toast } from 'sonner';
import { ApiError, apiFetch } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { useConfirm } from '@/lib/confirm';
import { isNative } from '@/lib/native/platform';
import { authenticateBiometric, checkBiometry, type Biometry } from '@/lib/native/biometric';
import { biometricLockEnabled, setBiometricLock } from '@/lib/native/session';
import { enablePush, pushPermission, type PushPermission } from '@/lib/native/push';
import { hapticSuccess } from '@/lib/haptics';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * The phones this person has the Alto People app on (routes/nativeApp.ts),
 * and — inside the app — this phone's own switches: notifications, and
 * Face ID / fingerprint to open the app. Removing a phone stops its
 * notifications and signs it out of its saved session.
 */

interface PhoneRow {
  id: string;
  platform: 'IOS' | 'ANDROID';
  deviceModel: string | null;
  osVersion: string | null;
  appVersion: string | null;
  notifications: boolean;
  biometricLock: boolean;
  lastSeenAt: string;
  current: boolean;
}

const listPhones = () => apiFetch<{ devices: PhoneRow[] }>('/devices');

function ThisPhone() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [bio, setBio] = useState<Biometry | null>(null);
  const [lock, setLock] = useState(false);
  const [push, setPush] = useState<PushPermission>('unsupported');
  const [busy, setBusy] = useState<'push' | 'lock' | null>(null);

  useEffect(() => {
    void checkBiometry().then(setBio);
    void biometricLockEnabled().then(setLock);
    void pushPermission().then(setPush);
  }, []);

  const turnOnPush = async () => {
    setBusy('push');
    try {
      const r = await enablePush();
      setPush(r);
      if (r === 'granted') {
        hapticSuccess();
        toast.success(t('phones.pushOn'));
        await qc.invalidateQueries({ queryKey: ['me', 'phones'] });
      }
    } catch {
      toast.error(t('phones.pushFailed'));
    } finally {
      setBusy(null);
    }
  };

  const toggleLock = async (on: boolean) => {
    setBusy('lock');
    try {
      // Turning it on proves the biometrics work first, so nobody locks themselves out.
      if (on && !(await authenticateBiometric(t('phones.lockConfirm', { method: bio?.label ?? 'Face ID' })))) return;
      await setBiometricLock(on);
      setLock(on);
      toast.success(on ? t('phones.lockOn', { method: bio?.label ?? 'Face ID' }) : t('phones.lockOff'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mb-4 space-y-3 rounded-lg border border-line bg-surface-raised/50 p-4">
      <div className="text-xs font-semibold uppercase tracking-wider text-ink-muted">{t('phones.thisPhone')}</div>
      <div className="flex flex-wrap items-center gap-3">
        <BellRing className="h-4 w-4 shrink-0 text-ink-muted" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="text-sm text-ink">{t('phones.notifications')}</div>
          <div className="text-xs text-ink-muted">
            {push === 'granted' ? t('phones.notifOn') : push === 'denied' ? t('phones.notifDenied') : t('phones.notifOff')}
          </div>
        </div>
        {push === 'prompt' && (
          <Button size="sm" onClick={() => void turnOnPush()} loading={busy === 'push'}>
            {t('phones.turnOn')}
          </Button>
        )}
      </div>
      {bio?.available && (
        <label className="flex cursor-pointer items-center gap-3 coarse:min-h-11">
          <input
            type="checkbox"
            className="h-4 w-4 coarse:h-6 coarse:w-6"
            checked={lock}
            disabled={busy === 'lock'}
            onChange={(e) => void toggleLock(e.target.checked)}
          />
          <span className="min-w-0 flex-1">
            <span className="block text-sm text-ink">{t('phones.lockLabel', { method: bio.label })}</span>
            <span className="block text-xs text-ink-muted">{t('phones.lockHint')}</span>
          </span>
        </label>
      )}
    </div>
  );
}

export function PhonesCard() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const q = useQuery({ queryKey: ['me', 'phones'], queryFn: listPhones });
  const native = isNative();

  const remove = async (p: PhoneRow) => {
    const ok = await confirm({
      title: p.current ? t('phones.removeThisTitle') : t('phones.removeTitle'),
      description: t('phones.removeBody'),
      confirmLabel: t('phones.remove'),
      destructive: true,
    });
    if (!ok) return;
    try {
      await apiFetch(`/devices/${p.id}`, { method: 'DELETE' });
      toast.success(t('phones.removed'));
      await qc.invalidateQueries({ queryKey: ['me', 'phones'] });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('phones.removeFailed'));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Smartphone className="h-4 w-4 text-gold" aria-hidden="true" />
          {t('phones.title')}
        </CardTitle>
        <CardDescription>{t('phones.desc')}</CardDescription>
      </CardHeader>
      <CardContent>
        {native && <ThisPhone />}
        {q.isError ? (
          <ErrorBanner
            action={
              <Button size="sm" variant="outline" onClick={() => void q.refetch()}>
                {t('common.retry')}
              </Button>
            }
          >
            {t('phones.loadFailed')}
          </ErrorBanner>
        ) : !q.data ? (
          <Skeleton className="h-12 w-full" />
        ) : q.data.devices.length === 0 ? (
          <p className="text-sm text-ink-muted">{t('phones.empty')}</p>
        ) : (
          <ul className="divide-y divide-line">
            {q.data.devices.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-3 py-2.5">
                <Smartphone className="h-5 w-5 shrink-0 text-ink-muted" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-sm text-ink">
                    {p.deviceModel ?? (p.platform === 'IOS' ? 'iPhone' : 'Android phone')}
                    {p.osVersion ? <span className="text-ink-muted">· {p.platform === 'IOS' ? 'iOS' : 'Android'} {p.osVersion}</span> : null}
                    {p.current && <Badge variant="info">{t('phones.current')}</Badge>}
                  </div>
                  <div className="text-xs text-ink-muted">
                    {t('phones.lastUsed', { date: fmtDate(p.lastSeenAt) })}
                    {' · '}
                    {p.notifications ? t('phones.rowNotifOn') : t('phones.rowNotifOff')}
                    {p.appVersion ? ` · ${t('phones.appVersion', { version: p.appVersion })}` : ''}
                  </div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => void remove(p)}>
                  {t('phones.remove')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
