/**
 * `?return=` — the way back from a deep link.
 *
 * A name clicked on Compliance opens the People profile; "Issue a number"
 * on that profile opens the kiosk admin. Each hop carries where it came
 * from so the far end can offer one click back. Same-origin app paths
 * only: anything not starting with a single '/' — absolute URLs,
 * protocol-relative '//host' — is dropped so it can't become an open
 * redirect.
 */
export function sanitizeReturnPath(raw: string | null): string | null {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return null;
  return raw;
}

/**
 * A link out that carries the way back: `withReturn('/compliance?tab=i9',
 * '/people/123')`. Every page header renders the "← Back to …" link when
 * `?return=` is present (components/ui/ReturnLink), so any page can be the
 * far end — the ease-of-use sweep (2026-10-22) found that only People, the
 * kiosk admin and the Compliance tabs honored it, and every other link into
 * HR cases, Time, the Finance queue, Pay schedules, Org or Separations was
 * one-way.
 */
export function withReturn(path: string, returnTo: string | null | undefined): string {
  const back = sanitizeReturnPath(returnTo ?? null);
  if (!back) return path;
  return `${path}${path.includes('?') ? '&' : '?'}return=${encodeURIComponent(back)}`;
}

/** The current page, as a return path — for links built outside a hook. */
export function hereAsReturn(): string {
  if (typeof window === 'undefined') return '/';
  return `${window.location.pathname}${window.location.search}`;
}

// Friendly names for the "← Back to …" action. Matched on the path
// prefix; anything unrecognized still gets a working link, just a generic
// label.
const RETURN_PATH_LABELS: ReadonlyArray<readonly [string, string]> = [
  ['/compliance', 'Compliance'],
  ['/time-attendance/kiosk', 'Kiosk admin'],
  ['/time-attendance', 'Time & attendance'],
  ['/people', 'People'],
  ['/payroll', 'Payroll'],
  ['/scheduling', 'Scheduling'],
  ['/approvals', 'Approvals'],
  ['/expirations', 'Expirations'],
  ['/onboarding', 'Onboarding'],
  ['/hr-cases', 'HR cases'],
  ['/clients', 'Clients'],
];

export function returnPathLabel(path: string): string {
  const hit = RETURN_PATH_LABELS.find(
    ([prefix]) =>
      path === prefix ||
      path.startsWith(`${prefix}/`) ||
      path.startsWith(`${prefix}?`),
  );
  return hit ? hit[1] : 'previous page';
}
