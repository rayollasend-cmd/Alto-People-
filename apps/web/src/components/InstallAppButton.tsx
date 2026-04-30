import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/Button';

// Captures Chrome's deferred install prompt and surfaces it as a button in
// the topbar. iOS Safari does not fire `beforeinstallprompt`; users install
// there via the share sheet → "Add to Home Screen". The apple-mobile-web-app
// meta tags in index.html make that path work.
//
// Once the user installs (`appinstalled` fires) or dismisses for the
// session, we hide the button until the next session.

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: ReadonlyArray<string>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
  prompt(): Promise<void>;
}

const DISMISS_KEY = 'alto.install.dismissed';

export function InstallAppButton() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (sessionStorage.getItem(DISMISS_KEY) === '1') return;

    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setDeferred(null);

    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (!deferred) return null;

  const handleInstall = async () => {
    try {
      await deferred.prompt();
      const choice = await deferred.userChoice;
      if (choice.outcome === 'dismissed') {
        sessionStorage.setItem(DISMISS_KEY, '1');
      }
    } finally {
      setDeferred(null);
    }
  };

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleInstall}
      className="hidden sm:inline-flex"
      aria-label="Install Alto People as an app"
    >
      <Download className="h-3.5 w-3.5" aria-hidden="true" />
      <span>Install app</span>
    </Button>
  );
}
