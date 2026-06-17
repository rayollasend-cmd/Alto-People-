import { useEffect } from 'react';

/**
 * While the kiosk page is mounted, point the document at the KIOSK web app
 * manifest (start_url /kiosk, scope /kiosk, name "Alto Kiosk") instead of the
 * main Alto People manifest. This is what makes "Add to Home Screen" install
 * a separate, standalone kiosk app that launches straight into /kiosk —
 * rather than the full Alto People app at "/".
 *
 * iOS Safari reads `apple-mobile-web-app-title` for the home-screen label, so
 * we swap that too. Everything is restored on unmount so navigating back into
 * the main SPA installs the main app as before.
 */
export function useKioskAppManifest(): void {
  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    const appleTitle = document.querySelector<HTMLMetaElement>(
      'meta[name="apple-mobile-web-app-title"]',
    );

    const prevManifest = link?.getAttribute('href') ?? null;
    const prevAppleTitle = appleTitle?.getAttribute('content') ?? null;
    const prevDocTitle = document.title;

    link?.setAttribute('href', '/kiosk.webmanifest');
    appleTitle?.setAttribute('content', 'Alto Kiosk');
    document.title = 'Alto Kiosk';

    return () => {
      if (link && prevManifest) link.setAttribute('href', prevManifest);
      if (appleTitle && prevAppleTitle) appleTitle.setAttribute('content', prevAppleTitle);
      document.title = prevDocTitle;
    };
  }, []);
}
