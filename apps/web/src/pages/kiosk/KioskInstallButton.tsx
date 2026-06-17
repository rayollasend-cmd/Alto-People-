import { useEffect, useState } from 'react';
import { Download, Share } from 'lucide-react';
import {
  isStandaloneDisplay,
  subscribeInstallPrompt,
  triggerInstall,
} from '@/lib/installPrompt';

function isApple(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  if (/iphone|ipad|ipod/i.test(ua)) return true;
  // iPadOS 13+ reports as "MacIntel" but is touch-capable.
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
}

/**
 * "Add to Home Screen" affordance for the kiosk setup screen, so HR can
 * install the kiosk as its own full-screen app on the tablet.
 *  - Android/Chrome: fires the captured `beforeinstallprompt` dialog.
 *  - iOS/iPadOS Safari (no programmatic prompt): shows the Share → Add to
 *    Home Screen instructions.
 *  - Already running as an installed app, or desktop with no prompt: hidden.
 */
export function KioskInstallButton() {
  const [available, setAvailable] = useState(false);
  const [showIosHelp, setShowIosHelp] = useState(false);

  useEffect(() => subscribeInstallPrompt(setAvailable), []);

  if (isStandaloneDisplay()) return null; // already launched as the installed app
  const apple = isApple();
  if (!available && !apple) return null; // nothing installable to offer here

  const onClick = async () => {
    if (available) {
      const outcome = await triggerInstall();
      if (outcome === 'unavailable' && apple) setShowIosHelp(true);
      return;
    }
    setShowIosHelp((v) => !v);
  };

  return (
    <div className="mt-4">
      <button
        type="button"
        onClick={onClick}
        className="w-full flex items-center justify-center gap-2 rounded-md border border-navy-secondary bg-midnight py-3 text-sm text-silver hover:text-white transition-colors"
      >
        {apple ? <Share className="h-4 w-4" /> : <Download className="h-4 w-4" />}
        Add to Home Screen
      </button>
      {showIosHelp && apple && (
        <p className="mt-2 text-xs text-silver/70">
          Tap the <span className="text-white">Share</span> icon in Safari, then
          <span className="text-white"> “Add to Home Screen,”</span> to install
          Alto Kiosk as a full-screen app. Open it from the home screen and pair
          it once with the token above.
        </p>
      )}
    </div>
  );
}
