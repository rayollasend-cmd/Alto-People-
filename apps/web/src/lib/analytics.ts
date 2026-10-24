/**
 * Product analytics (PostHog) — usage, funnels, web vitals and, for office
 * staff only, masked session replays. docs/analytics.md has the whole policy;
 * the rules this file enforces:
 *
 *  - Off unless VITE_POSTHOG_KEY is set at build time (never in tests, CI or
 *    the visual baselines). Loaded after the page has settled, as its own
 *    chunk, so it never competes with the first screen.
 *  - Everything goes through our own origin (/api/ux, the API's relay), so
 *    the CSP stays 'self', no third-party script is ever loaded, and PostHog
 *    never sees an employee's IP address.
 *  - People are identified by internal id, role and company only — never a
 *    name or an email. Visitors who aren't signed in get no profile and
 *    nothing stored in the browser (memory persistence).
 *  - Autocapture records that a button was pressed, never its text or
 *    attributes. URLs lose their query string (search terms can be names)
 *    except utm_* campaign tags, and secret-link tokens are masked.
 *    Page titles are dropped (a person's record is titled with their name).
 *  - The whistleblower hotline and the clock-in kiosk are not tracked at all.
 *  - Recordings: office roles only, never in the phone app, every word and
 *    input masked and images blocked, and stopped on pay, tax, bank, ID,
 *    document, case and message pages.
 */
import type { CaptureResult, PostHog, PostHogConfig } from 'posthog-js';
import type { Role } from '@alto-people/shared';
import { isNative, nativePlatform } from '@/lib/native/platform';

const KEY = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
/** The API's relay to PostHog's US cloud (apps/api/src/routes/analyticsRelay.ts). */
const RELAY = '/api/ux';

export interface AnalyticsUser {
  id: string;
  role: Role;
  tenantId: string;
}

/** Never tracked at all: an anonymous hotline report must stay anonymous, and the kiosk is a shared, face-scanning tablet. */
const UNTRACKED_PATHS = [/^\/hotline(\/|$)/, /^\/kiosk(\/|$)/, /^\/time-attendance\/kiosk(\/|$)/];

/** Never recorded, even masked: pay, tax, bank, ID, documents, cases, messages, and every secret link. */
const PRIVATE_PATHS = [
  /^\/payroll(\/|$)/,
  /^\/payrules(\/|$)/,
  /^\/compensation(\/|$)/,
  /^\/benefits(\/|$)/,
  /^\/books(\/|$)/,
  /^\/finance(\/|$)/,
  /^\/labor-costs(\/|$)/,
  /^\/reimbursements(\/|$)/,
  /^\/equity(\/|$)/,
  /^\/me(\/|$)/,
  /^\/onboarding\/(me|applications|in-person)\//,
  /^\/people\/.+/,
  /^\/documents(\/|$)/,
  /^\/expirations(\/|$)/,
  /^\/compliance(\/|$)/,
  /^\/hr-cases(\/|$)/,
  /^\/discipline(\/|$)/,
  /^\/separations(\/|$)/,
  /^\/leave(\/|$)/,
  /^\/vaccinations(\/|$)/,
  /^\/claims\//,
  /^\/messages(\/|$)/,
  /^\/audit(\/|$)/,
  /^\/hotline-admin(\/|$)/,
  /^\/admin\/(billing|employers|finance|document-retention|compliance-evidence)(\/|$)/,
  /^\/(accept-invite|candidate|confirm-email-change|nps|offer|reset-password|track|w)\//,
  /^\/verify(\/|$)/,
];

/** Paths whose last segment is a secret-link token. */
const TOKEN_PATH = /^\/(accept-invite|candidate|confirm-email-change|nps|offer|reset-password|track|w)\/[^/]+/;

/** Office roles. Associates, drivers and client-portal users get analytics without recordings. */
const RECORDED_ROLES: ReadonlySet<Role> = new Set<Role>([
  'EXECUTIVE_CHAIRMAN',
  'HR_ADMINISTRATOR',
  'OPERATIONS_MANAGER',
  'FINANCE_ACCOUNTANT',
  'INTERNAL_RECRUITER',
  'MANAGER',
  'WORKFORCE_MANAGER',
  'MARKETING_MANAGER',
  'SHIFT_SUPERVISOR',
  'FLOOR_SUPERVISOR',
  'TRANSPORTATION_DIRECTOR',
]);

export function isUntrackedPath(pathname: string): boolean {
  return UNTRACKED_PATHS.some((re) => re.test(pathname));
}

export function isPrivatePath(pathname: string): boolean {
  return isUntrackedPath(pathname) || PRIVATE_PATHS.some((re) => re.test(pathname));
}

export function canRecord(role: Role, native: boolean): boolean {
  return !native && RECORDED_ROLES.has(role);
}

function maskPath(pathname: string): string {
  return pathname.replace(TOKEN_PATH, (m) => `${m.slice(0, m.lastIndexOf('/'))}/:token`);
}

/** A URL with its query string dropped (utm_* tags kept), its hash dropped and any secret-link token masked. */
export function scrubUrl(value: string): string {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return value;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return value;
  const kept = new URLSearchParams();
  u.searchParams.forEach((v, k) => {
    if (k.startsWith('utm_')) kept.append(k, v);
  });
  const search = kept.toString();
  return `${u.origin}${maskPath(u.pathname)}${search ? `?${search}` : ''}`;
}

const looksLikeUrl = (s: string) => s.startsWith('http://') || s.startsWith('https://');

/** True for a URL on an untracked page — it is removed, not just trimmed: even "came from the hotline" says too much. */
function isUntrackedUrl(value: string): boolean {
  try {
    return isUntrackedPath(new URL(value).pathname);
  } catch {
    return false;
  }
}

function scrubValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') {
    if (!looksLikeUrl(value)) return value;
    return isUntrackedUrl(value) ? null : scrubUrl(value);
  }
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    // Heatmap data is keyed by URL.
    out[looksLikeUrl(k) ? scrubUrl(k) : k] = scrubValue(v, depth + 1);
  }
  return out;
}

const PATH_PROPS = ['$pathname', '$prev_pageview_pathname', '$initial_pathname'];

/** PostHog's before_send: drops untracked pages' events and scrubs every URL an event carries. */
export function scrubEvent(cr: CaptureResult | null): CaptureResult | null {
  if (!cr) return cr;
  const props = (cr.properties ?? {}) as Record<string, unknown>;
  const current = typeof props.$current_url === 'string' ? props.$current_url : null;
  let path = typeof props.$pathname === 'string' ? props.$pathname : null;
  if (!path && current) {
    try {
      path = new URL(current).pathname;
    } catch {
      path = null;
    }
  }
  if (path && isUntrackedPath(path)) return null;

  const properties = scrubValue(props, 0) as Record<string, unknown>;
  delete properties.title;
  delete properties.$title;
  // The page before this one was the hotline or the kiosk: forget it.
  if (typeof properties.$prev_pageview_pathname === 'string' && isUntrackedPath(properties.$prev_pageview_pathname)) {
    for (const key of Object.keys(properties)) if (key.startsWith('$prev_pageview_')) delete properties[key];
  }
  for (const key of PATH_PROPS) {
    if (typeof properties[key] === 'string') properties[key] = maskPath(properties[key] as string);
  }
  const next: CaptureResult = { ...cr, properties };
  if (cr.$set) next.$set = scrubValue(cr.$set, 0) as CaptureResult['$set'];
  if (cr.$set_once) next.$set_once = scrubValue(cr.$set_once, 0) as CaptureResult['$set_once'];
  return next;
}

export const POSTHOG_CONFIG: Partial<PostHogConfig> = {
  api_host: RELAY,
  ui_host: 'https://us.posthog.com',
  defaults: '2026-08-30',
  person_profiles: 'identified_only',
  // Nothing stored for a visitor who isn't signed in; localStorage once they are (see apply).
  persistence: 'memory',
  // The CDN is never used: the extensions we want ship in our own chunks.
  disable_external_dependency_loading: true,
  respect_dnt: true,
  capture_pageview: 'history_change',
  mask_all_text: true,
  mask_all_element_attributes: true,
  // Sentry owns errors; nothing here PostHog would otherwise pop up on screen.
  capture_exceptions: false,
  disable_surveys: true,
  disable_product_tours: true,
  disable_conversations: true,
  disable_web_experiments: true,
  // Web vitals yes; per-request timing would carry API URLs.
  capture_performance: { web_vitals: true, network_timing: false },
  disable_session_recording: true,
  enable_recording_console_log: false,
  session_recording: {
    maskAllInputs: true,
    maskTextSelector: '*',
    blockSelector: 'img, video, canvas, picture, [data-private]',
    recordHeaders: false,
    recordBody: false,
    recordCrossOriginIframes: false,
    // If the project ever turns network capture on: addresses only, no query strings.
    maskCapturedNetworkRequestFn: (req) => ({ ...req, name: scrubUrl(req.name) }),
  },
  before_send: scrubEvent,
};

let client: PostHog | null = null;
let user: AnalyticsUser | null = null;
let path = typeof window === 'undefined' ? '/' : window.location.pathname;
let identifiedAs: string | null = null;
let recorder: Promise<unknown> | null = null;
/** Whether we've asked PostHog to record — true before it actually starts (it waits for the project's settings). */
let recordingOn = false;

/** Kick off the lazy load. No-op without VITE_POSTHOG_KEY. Called once from main.tsx. */
export function initAnalytics(): void {
  if (!KEY || import.meta.env.MODE === 'test') return;
  // Opened straight onto the hotline or the kiosk: don't even load the SDK.
  if (isUntrackedPath(window.location.pathname)) return;
  const start = () => {
    const idle = (window as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
    const load = () => void loadAnalytics(KEY);
    if (idle) idle(load, { timeout: 5000 });
    else window.setTimeout(load, 2000);
  };
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
}

async function loadAnalytics(key: string): Promise<void> {
  const [{ default: posthog }] = await Promise.all([
    import('posthog-js/no-external'),
    // The two extensions PostHog would otherwise fetch from its CDN.
    import('posthog-js/dist/web-vitals'),
    import('posthog-js/dist/dead-clicks-autocapture'),
  ]);
  posthog.init(key, POSTHOG_CONFIG);
  attachAnalyticsClient(posthog);
}

/** Hand over a started client (the lazy load, or a fake in tests) and replay the current user and page onto it. */
export function attachAnalyticsClient(next: PostHog | null): void {
  client = next;
  identifiedAs = null;
  recordingOn = false;
  client?.register({ platform: nativePlatform() ?? 'web' });
  apply();
}

/** Who is signed in (null when nobody is). From AnalyticsIdentity, inside AuthProvider. */
export function setAnalyticsUser(next: AnalyticsUser | null): void {
  user = next;
  apply();
}

/** The page being shown. From the router's subscription in main.tsx. */
export function setAnalyticsPath(pathname: string): void {
  if (pathname === path) return;
  path = pathname;
  applyRecording();
}

function apply(): void {
  if (!client) return;
  if (user) {
    const props = { role: user.role, tenant_id: user.tenantId };
    if (identifiedAs !== user.id) {
      if (identifiedAs) client.reset();
      client.set_config({ persistence: 'localStorage' });
      client.identify(user.id, props);
      identifiedAs = user.id;
    } else {
      // Same person, another of their roles.
      client.setPersonProperties(props);
    }
  } else if (identifiedAs) {
    client.reset();
    client.set_config({ persistence: 'memory' });
    identifiedAs = null;
  }
  applyRecording();
}

const wantsRecording = () => !!user && canRecord(user.role, isNative()) && !isPrivatePath(path);

function applyRecording(): void {
  const c = client;
  if (!c) return;
  if (!wantsRecording()) {
    // Unconditionally: a recording still waiting on the project's settings
    // would otherwise start on this page when they arrive.
    if (recordingOn) {
      c.stopSessionRecording();
      recordingOn = false;
    }
    return;
  }
  // The recorder (rrweb) is only ever downloaded for office staff.
  recorder ??= import('posthog-js/dist/posthog-recorder');
  void recorder.then(() => {
    // The page or the person may have changed while the chunk loaded.
    if (client === c && wantsRecording() && !recordingOn) {
      c.startSessionRecording();
      recordingOn = true;
    }
  });
}
