import { useState } from 'react';
import { BellRing, CalendarClock, Bus, Wallet } from '@/components/ui/icons';
import { toast } from 'sonner';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { enablePush } from '@/lib/native/push';
import { hapticSuccess } from '@/lib/haptics';

/**
 * Our explanation before the phone's own permission prompt — asked once,
 * after sign-in, never cold. "Not now" waits a week. A "no" at the system
 * prompt is final on iOS, so this sheet is where the case is made.
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

const REASONS = [
  { icon: CalendarClock, text: 'A shift is added, moved or opens up near you' },
  { icon: Bus, text: 'Your van is on its way, or running late' },
  { icon: Wallet, text: 'Pay lands, or a request needs your answer' },
];

export function PushPermissionSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const allow = async () => {
    setBusy(true);
    try {
      const result = await enablePush();
      if (result === 'granted') {
        hapticSuccess();
        toast.success('Notifications are on. You can change them in Settings.');
      } else if (result === 'denied') {
        toast('Notifications are off. Turn them on any time in your phone’s Settings.');
      }
    } catch {
      toast.error('Couldn’t turn on notifications. Try again from Settings.');
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
          <DialogTitle>Know the moment something changes</DialogTitle>
          <DialogDescription>Turn on notifications and we’ll tell you when:</DialogDescription>
        </DialogHeader>
        <ul className="space-y-3">
          {REASONS.map(({ icon: Icon, text }) => (
            <li key={text} className="flex items-start gap-3 text-sm text-ink">
              <Icon className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
              {text}
            </li>
          ))}
        </ul>
        <p className="text-xs text-ink-muted">Quiet hours and daily digests in Settings apply here too.</p>
        <div className="flex flex-col gap-2 pt-1">
          <Button size="lg" onClick={() => void allow()} loading={busy} className="w-full">
            Turn on notifications
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
            Not now
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
