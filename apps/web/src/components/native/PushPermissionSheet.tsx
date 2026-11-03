import { useState } from 'react';
import { BellRing, CalendarClock, Bus, Wallet, type LucideIcon } from '@/components/ui/icons';
import { toast } from 'sonner';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { enablePush } from '@/lib/native/push';
import { hapticSuccess } from '@/lib/haptics';
import { useI18n, type MessageKey } from '@/lib/i18n';
import '@/lib/i18n/en/push';

/**
 * Our explanation before the phone's own permission prompt — asked once,
 * after sign-in, never cold. "Not now" waits a week. A "no" at the system
 * prompt is final on iOS, so this sheet is where the case is made — in the
 * person's language, and promising only what is true: quiet hours hold
 * all but urgent notices overnight (owner, 2026-11-02; it used to promise
 * "daily digests", which push never had).
 */

const KEY = 'alto:pushPromptDismissedAt';
const WAIT_MS = 7 * 86_400_000;

export function pushPromptDue(now = Date.now()): boolean {
  try {
    const at = Number(window.localStorage.getItem(KEY) ?? 0);
    return !at || now - at > WAIT_MS;
  } catch {
    return true;
  }
}

function remember(): void {
  try {
    window.localStorage.setItem(KEY, String(Date.now()));
  } catch {
    /* storage blocked */
  }
}

const REASONS: Array<{ icon: LucideIcon; text: MessageKey }> = [
  { icon: CalendarClock, text: 'push.sheetShift' },
  { icon: Bus, text: 'push.sheetVan' },
  { icon: Wallet, text: 'push.sheetPay' },
];

export function PushPermissionSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const allow = async () => {
    setBusy(true);
    try {
      const result = await enablePush();
      if (result === 'granted') {
        hapticSuccess();
        toast.success(t('push.sheetOn'));
      } else if (result === 'denied') {
        toast(t('push.sheetDenied'));
      }
    } catch {
      toast.error(t('push.sheetFailed'));
    } finally {
      remember();
      setBusy(false);
      onClose();
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          remember();
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <span className="mb-1 grid h-12 w-12 place-items-center rounded-full bg-accent-fill/15 text-accent" aria-hidden="true">
            <BellRing className="h-6 w-6" />
          </span>
          <DialogTitle>{t('push.sheetTitle')}</DialogTitle>
          <DialogDescription>{t('push.sheetDesc')}</DialogDescription>
        </DialogHeader>
        <ul className="space-y-3">
          {REASONS.map(({ icon: Icon, text }) => (
            <li key={text} className="flex items-start gap-3 text-sm text-ink">
              <Icon className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
              {t(text)}
            </li>
          ))}
        </ul>
        <p className="text-xs text-ink-muted">{t('push.sheetQuiet')}</p>
        <div className="flex flex-col gap-2 pt-1">
          <Button size="lg" onClick={() => void allow()} loading={busy} className="w-full">
            {t('push.sheetAllow')}
          </Button>
          <Button
            size="lg"
            variant="ghost"
            onClick={() => {
              remember();
              onClose();
            }}
            className="w-full"
          >
            {t('push.notNow')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
