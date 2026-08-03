import { useEffect, useState } from 'react';
import { Download, Share, X } from 'lucide-react';
import { Button } from '@/components/ui';
import {
  isStandaloneDisplay,
  subscribeInstallPrompt,
  triggerInstall,
} from '@/lib/installPrompt';

/**
 * Phase 98 — branded install banner.
 *
 * Built on lib/installPrompt's module-level capture (NOT its own
 * `beforeinstallprompt` listener — two listeners sharing one event meant
 * this banner could call prompt() on an event the header button had
 * already spent, which throws).
 *
 * iOS branch: Safari never fires `beforeinstallprompt`, so iPhone/iPad —
 * the platform where install matters MOST, because iOS only delivers web
 * push to home-screen apps — used to never see an install path at all.
 * There we show the manual Share → "Add to Home Screen" instructions.
 */

const DISMISS_KEY = 'alto.pwa.installDismissed';

function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  // iPadOS 13+ reports as "MacIntel" with touch points.
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

export function InstallPrompt() {
  const [promptAvailable, setPromptAvailable] = useState(false);
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => subscribeInstallPrompt(setPromptAvailable), []);

  if (dismissed || isStandaloneDisplay()) return null;
  const ios = isIOS();
  if (!promptAvailable && !ios) return null;

  const onInstall = async () => {
    // triggerInstall burns the shared event and never throws — safe even
    // if another surface (the header install button) raced us to it.
    await triggerInstall();
    setPromptAvailable(false);
  };

  const onDismiss = () => {
    setDismissed(true);
    try {
      window.localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // ignore
    }
  };

  return (
    <div className="fixed z-50 max-w-sm bg-navy-secondary border border-gold/40 rounded-lg elev-2 p-4 flex items-start gap-3 bottom-[max(1rem,env(safe-area-inset-bottom))] right-[max(1rem,env(safe-area-inset-right))]">
      <Download className="h-5 w-5 text-gold mt-0.5 flex-shrink-0" />
      <div className="flex-1">
        <div className="text-sm font-medium text-white">
          Install Alto on this device
        </div>
        {ios && !promptAvailable ? (
          <div className="text-xs text-silver mt-1">
            Tap{' '}
            <Share className="inline h-3.5 w-3.5 align-text-bottom text-gold" aria-label="Share" />{' '}
            then <span className="text-white">Add to Home Screen</span>. Installing
            is also what lets Alto send you notifications on iPhone and iPad.
          </div>
        ) : (
          <div className="text-xs text-silver mt-1">
            Quicker launches and an offline shell. Works on desktop and mobile.
          </div>
        )}
        <div className="mt-3 flex gap-2">
          {promptAvailable && (
            <Button size="sm" onClick={onInstall}>
              Install
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            Not now
          </Button>
        </div>
      </div>
      <button
        onClick={onDismiss}
        className="text-silver hover:text-white transition-colors p-1 coarse:p-2 -m-1 coarse:-m-2"
        aria-label="Dismiss"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
