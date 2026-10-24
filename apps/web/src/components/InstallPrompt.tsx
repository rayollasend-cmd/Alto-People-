import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useI18n } from '@/lib/i18n';
import { useMinWidth } from '@/lib/useViewport';
import { Download, Share, X } from '@/components/ui/icons';
import { Button } from '@/components/ui';
import {
  installPromptAvailable,
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
  const { t } = useI18n();
  const { pathname } = useLocation();
  const [promptAvailable, setPromptAvailable] = useState(installPromptAvailable);
  // Chrome offers the install a few seconds after load, by when the page is
  // on screen. Below lg the banner sits above the content, so showing it
  // then pushed the whole page down under the reader (a layout shift on
  // every first visit); an offer that arrives late waits for the next page
  // there. The desktop corner card floats, so it shows at once.
  const floats = useMinWidth(1024);
  const [lateOn, setLateOn] = useState<string | null>(null);
  const availableRef = useRef(promptAvailable);
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  });

  useEffect(
    () =>
      subscribeInstallPrompt((available) => {
        if (available && !availableRef.current) setLateOn(window.location.pathname);
        availableRef.current = available;
        setPromptAvailable(available);
      }),
    [],
  );

  if (dismissed || isStandaloneDisplay()) return null;
  const ios = isIOS();
  if (!promptAvailable && !ios) return null;
  if (promptAvailable && !ios && !floats && lateOn === pathname) return null;

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

  // Phones and iPads: an in-page banner at the top of the content — the
  // shape of Safari's own app banner — that scrolls away with the page.
  // It was a fixed card pinned bottom-right, which on a phone sat squarely
  // on the tab bar (every page, until dismissed). Desktop keeps the corner
  // card. lg, not md: the supervisor's and store manager's tab bar stays
  // through iPad widths.
  return (
    <div
      role="region"
      aria-label={t('install.region')}
      className="mb-4 flex items-center gap-3 rounded-xl border border-gold/30 bg-navy-secondary/60 px-3 py-2.5 lg:fixed lg:bottom-6 lg:right-6 lg:z-50 lg:mb-0 lg:max-w-sm lg:items-start lg:rounded-lg lg:border-gold/40 lg:bg-navy-secondary lg:p-4 lg:elev-2"
    >
      <img
        src="/icon-96.png"
        alt=""
        aria-hidden="true"
        className="h-10 w-10 shrink-0 rounded-[0.6rem] lg:hidden"
      />
      <Download className="mt-0.5 hidden h-5 w-5 shrink-0 text-gold lg:block" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-white">
          <span className="lg:hidden">{t('install.title')}</span>
          <span className="hidden lg:inline">{t('install.titleLong')}</span>
        </div>
        {ios && !promptAvailable ? (
          <div className="text-xs text-silver">
            {t('install.tap')}{' '}
            <Share className="inline h-3.5 w-3.5 align-text-bottom text-gold" aria-label={t('install.share')} />{' '}
            {t('install.then')} <span className="text-white">{t('install.addToHome')}</span>
            <span className="hidden lg:inline">
              . {t('install.iosPush')}
            </span>
          </div>
        ) : (
          <div className="text-xs text-silver">
            {t('install.body')}
          </div>
        )}
        <div className="mt-3 hidden gap-2 lg:flex">
          {promptAvailable && (
            <Button size="sm" onClick={onInstall}>
              {t('install.install')}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            {t('install.notNow')}
          </Button>
        </div>
      </div>
      {promptAvailable && (
        <Button size="sm" onClick={onInstall} className="shrink-0 lg:hidden">
          {t('install.install')}
        </Button>
      )}
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 rounded-md p-2 -m-1 text-silver transition-colors hover:text-white"
        aria-label={t('install.dismiss')}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
