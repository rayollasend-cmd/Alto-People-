import { MODULES } from '@/lib/modules';
import { deepestModule } from '@/lib/navTrail';

/**
 * Words for the platform pages (Reliability, Product usage) — F500
 * 2026-10-26: one duration format across both, and a page or endpoint
 * named the way the sidebar names it, with the raw path kept as the quiet
 * second line (and in the CSV) for whoever has to find it in the code.
 */

/** One duration format: "25 ms", "17.5 s", "2.4 min". */
export function fmtMs(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (v < 1000) return `${Math.round(v)} ms`;
  const s = v / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  return `${(s / 60).toFixed(1)} min`;
}

/** "kiosk-pins" → "Kiosk pins". */
function sentence(segment: string): string {
  const words = segment.replace(/^:/, '').split(/[-_]/).filter(Boolean);
  if (words.length === 0) return segment;
  const text = words.join(' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A page path in the sidebar's words: "/time-attendance/kiosk" → "Kiosk", "/" → "Home". */
export function pageLabel(path: string): string {
  const clean = path.split('?')[0] || '/';
  if (clean === '/') return 'Home';
  const mod = deepestModule(clean, MODULES);
  if (mod) return mod.label;
  const segs = clean.split('/').filter(Boolean);
  return sentence(segs[segs.length - 1] ?? clean);
}

/** API areas that are not a page of their own. */
const API_AREA: Record<string, string> = {
  auth: 'Sign-in and session',
  telemetry: 'App measurements',
  events: 'Live updates',
  hugo: 'Assistant',
  'kiosk-pins': 'Kiosk',
  'release-notes': 'What’s new',
  support: 'Support',
  associates: 'People',
  admin: 'Settings',
  v1: 'Public API',
};

/** An API endpoint in words: "/communications/me/inbox" → "Communications", "/auth/me" → "Sign-in and session". */
export function endpointLabel(route: string): string {
  const segs = route.split('?')[0]!.split('/').filter(Boolean);
  const first = segs[0];
  if (!first) return 'Home';
  if (API_AREA[first]) return API_AREA[first]!;
  // "/me/inbox" is the person's own inbox; "/me/nav-pins" their pins.
  const path = first === 'me' && segs[1] ? `/${segs[1]}` : `/${segs.join('/')}`;
  const mod = deepestModule(path, MODULES);
  if (mod) return mod.label;
  return first === 'me' ? 'Your own settings' : sentence(first);
}

/** An endpoint in words, its method and path as the quiet second line. */
export function EndpointCell({ method, route }: { method: string; route: string }) {
  // A bounded width so the path truncates inside a half-width card instead
  // of pushing the numbers out of it; the whole path is the tooltip.
  return (
    <span className="flex min-w-0 max-w-[13rem] flex-col" title={`${method} ${route}`}>
      <span className="truncate text-ink">{endpointLabel(route)}</span>
      <span className="truncate font-mono text-2xs text-ink-muted">
        {method} {route}
      </span>
    </span>
  );
}

/** A page in the sidebar's words, its path as the quiet second line. */
export function PageCell({ path }: { path: string }) {
  return (
    <span className="flex min-w-0 max-w-[16rem] flex-col" title={path}>
      <span className="truncate text-ink">{pageLabel(path)}</span>
      <span className="truncate font-mono text-2xs text-ink-muted">{path}</span>
    </span>
  );
}
