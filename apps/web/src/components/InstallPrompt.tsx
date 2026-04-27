import { useEffect, useState } from 'react';
import { Download, X } from 'lucide-react';
import { Button } from '@/components/ui';

/**
 * Phase 98 — captures the `beforeinstallprompt` event so we can offer a
 * branded install button in our own UI instead of relying on the browser's
 * tiny address-bar icon. Only shows in supported browsers and only until
 * the user installs (or dismisses).
 */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const DISMISS_KEY = 'alto.pwa.installDismissed';

export function InstallPrompt() {
  const [evt, setEvt] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    const onBefore = (e: Event) => {
      e.preventDefault();
      setEvt(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setEvt(null);
    };
    window.addEventListener('beforeinstallprompt', onBefore);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBefore);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (!evt || dismissed) return null;

  const onInstall = async () => {
    await evt.prompt();
    const choice = await evt.userChoice;
    if (choice.outcome === 'accepted') {
      setEvt(null);
    } else {
      // User dismissed in the browser dialog — also hide our banner.
      setEvt(null);
    }
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
    <div className="fixed bottom-4 right-4 z-50 max-w-sm bg-navy-secondary border border-cyan-500/40 rounded-lg shadow-xl p-4 flex items-start gap-3">
      <Download className="h-5 w-5 text-cyan-400 mt-0.5 flex-shrink-0" />
      <div className="flex-1">
        <div className="text-sm font-medium text-white">
          Install Alto on this device
        </div>
        <div className="text-xs text-silver mt-1">
          Quicker launches and an offline shell. Works on desktop and mobile.
        </div>
        <div className="mt-3 flex gap-2">
          <Button size="sm" onClick={onInstall}>
            Install
          </Button>
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            Not now
          </Button>
        </div>
      </div>
      <button
        onClick={onDismiss}
        className="text-silver hover:text-white transition"
        aria-label="Dismiss"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
