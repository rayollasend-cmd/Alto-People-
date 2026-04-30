import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import {
  isStandaloneDisplay,
  subscribeInstallPrompt,
  triggerInstall,
} from '@/lib/installPrompt';

// Surfaces Chrome's deferred install prompt as a button in the topbar.
//
// We DON'T add the listener here — that's done at module import time in
// `lib/installPrompt.ts` so the event isn't lost if it fires before this
// component mounts (e.g. while the user is on /login). We just subscribe.
//
// iOS Safari and Firefox Desktop don't fire beforeinstallprompt at all.
// Users on those browsers install via Share → Add to Home Screen / the
// browser's install menu. The button stays hidden in that case rather
// than promising something we can't deliver.

const DISMISS_KEY = 'alto.install.dismissed';

export function InstallAppButton() {
  const [available, setAvailable] = useState(false);
  const [dismissed, setDismissed] = useState(() => {
    if (typeof window === 'undefined') return false;
    return sessionStorage.getItem(DISMISS_KEY) === '1';
  });

  useEffect(() => subscribeInstallPrompt(setAvailable), []);

  // Already running in standalone window — nothing to install.
  if (isStandaloneDisplay()) return null;
  if (!available || dismissed) return null;

  const handleInstall = async () => {
    const outcome = await triggerInstall();
    if (outcome === 'dismissed') {
      sessionStorage.setItem(DISMISS_KEY, '1');
      setDismissed(true);
    }
    // 'accepted' → appinstalled fires → store flips available=false
    // 'unavailable' → state already false; nothing to do
  };

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleInstall}
      aria-label="Install Alto People as an app"
    >
      <Download className="h-3.5 w-3.5" aria-hidden="true" />
      <span className="hidden sm:inline">Install app</span>
    </Button>
  );
}
