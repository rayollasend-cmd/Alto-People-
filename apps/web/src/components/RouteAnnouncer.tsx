import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { usePageTitle } from '@/lib/pageTitle';

/**
 * Phase F500-4 — SPA navigation accessibility (VPAT 2.4.2 / 4.1.3).
 *
 * Client-side route changes are invisible to screen readers: no page
 * load, no announcement, and document.title never moved off the static
 * index.html value. This component closes both gaps:
 *
 *  1. Keeps document.title in sync with the page title that PageHeader
 *     publishes to PageTitleContext ("Time & Attendance · Alto People"),
 *     falling back to a humanized URL segment on pages without a
 *     PageHeader, so tabs, history, and screen-reader window titles all
 *     identify the page.
 *  2. Announces the new page name through a polite live region after
 *     each navigation, the same way a full page load would.
 *
 * Timing: PageHeader publishes its title on mount, which lands a tick
 * AFTER the location change (and the page transition runs ~180ms). We
 * wait one frame past that before reading the title so we announce the
 * real page name, not the previous page's leftovers.
 */

const APP_NAME = 'Alto People';
const ANNOUNCE_DELAY_MS = 250;

/** "/payroll-tax/w2" → "Payroll tax w2" — last-resort label for pages without a PageHeader. */
function humanizePath(pathname: string): string {
  const segment = pathname.split('/').filter(Boolean).pop();
  if (!segment) return 'Home';
  const words = segment.replace(/[-_]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function RouteAnnouncer() {
  const location = useLocation();
  const title = usePageTitle();
  const [announcement, setAnnouncement] = useState('');

  // Keep the freshest title in a ref so the delayed announce below reads
  // the value published by the NEW page, not the one captured at
  // navigation time.
  const titleRef = useRef(title);
  titleRef.current = title;

  // Window/tab title follows the published page title immediately.
  useEffect(() => {
    document.title = title ? `${title} · ${APP_NAME}` : APP_NAME;
  }, [title]);

  // Announce after each navigation, once the incoming page has had a
  // chance to publish its title.
  const isFirstRender = useRef(true);
  useEffect(() => {
    // Skip the initial mount — screen readers already announce the
    // document title on first load; repeating it is noise.
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    const timer = window.setTimeout(() => {
      setAnnouncement(titleRef.current ?? humanizePath(location.pathname));
    }, ANNOUNCE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [location.pathname]);

  return (
    <div aria-live="polite" role="status" className="sr-only">
      {announcement}
    </div>
  );
}
