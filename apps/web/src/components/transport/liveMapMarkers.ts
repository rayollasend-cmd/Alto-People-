import { tokenColor, tokenVar, type ColorToken } from '@/lib/tokenColor';

/**
 * The map's markers and lines, painted by hand — kept apart from LiveMap so
 * they can be tested without MapLibre (which needs WebGL and a worker).
 *
 * The fleet look (the desk's Live map, 2026-10-28) rides on the same van
 * marker every map uses: a status fill from the palette's scales instead of
 * the gold, a hollow dashed ring for a van whose phone went quiet, a bar
 * through a van that's out of service, a quiet smaller marker for a parked
 * van, and its name on a tag underneath. A marker without those fields is
 * painted exactly as before.
 */

/** A van's status fill — the palette scale's 600 step, which keeps white ink at 3:1+ in both themes. */
export type MarkerTone = 'positive' | 'caution' | 'negative' | 'neutral';

export interface MapMarker {
  id: string;
  lat: number;
  lng: number;
  kind: 'van' | 'home' | 'store' | 'stop';
  label?: string;
  /** Degrees, for the van's arrow. */
  heading?: number | null;
  /** The van's position is old — shown faded. */
  stale?: boolean;
  /** A numbered stop (the desk's and the driver's view). */
  order?: number;
  /** Draw attention (the selected van, the rider's own pickup). */
  highlight?: boolean;
  /** Radar rings — a pickup still waiting on a driver. */
  pulse?: boolean;
  /** A van's fill by its status (on time, late, very late, parked); gold when unset. */
  tone?: MarkerTone;
  /** A van whose phone stopped reporting: an outline only, dashed — where it was, not where it is. */
  hollow?: boolean;
  /** A van out of service: a bar through it. */
  struck?: boolean;
  /** A parked van: smaller, no live pulse. */
  still?: boolean;
  /** A short name on a tag under the marker ("Van 2"). */
  tag?: string;
  /** Pixels to nudge the marker by — vans parked on one spot sit side by side. */
  offset?: [number, number];
}

/** A run's remaining route on a fleet map. [lng, lat] pairs. */
export interface MapRoute {
  id: string;
  coords: Array<[number, number]>;
  tone?: MarkerTone;
  /** The selected run: solid and bold; the rest are thin dashes. */
  strong?: boolean;
}

const BUS_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 6v6"/><path d="M15 6v6"/><path d="M2 12h19.6"/><path d="M18 18h3s.5-1.7.8-2.8c.1-.4.2-.8.2-1.2 0-.4-.1-.8-.2-1.2l-1.4-5C20.1 6.8 19.1 6 18 6H4a2 2 0 0 0-2 2v10h3"/><circle cx="7" cy="18" r="2"/><path d="M9 18h5"/><circle cx="16" cy="18" r="2"/></svg>';
const HOME_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const STORE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7"/><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="M15 22v-4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4"/><path d="M2 7h20"/></svg>';

/** A palette scale step as a live CSS colour (follows the theme on its own). */
export function scaleVar(tone: MarkerTone, step: number, alpha?: number): string {
  return alpha === undefined ? `rgb(var(--color-${tone}-${step}))` : `rgb(var(--color-${tone}-${step}) / ${alpha})`;
}

// MapLibre positions a marker by writing its root element's transform, so
// the look lives on an inner element — repainting it on every refresh must
// never touch the root's style (that snapped markers to the corner).
export function markerElement(m: MapMarker): HTMLElement {
  const root = document.createElement('div');
  root.setAttribute('role', 'img');
  root.appendChild(document.createElement('div'));
  paintMarker(root, m);
  return root;
}

// Radar rings for a pickup still waiting on a driver — injected once.
let radarCss = false;
function ensureRadarCss() {
  if (radarCss || typeof document === 'undefined') return;
  radarCss = true;
  const st = document.createElement('style');
  st.textContent =
    '@keyframes alto-radar{0%{transform:scale(.7);opacity:.75}100%{transform:scale(2.6);opacity:0}}' +
    `.alto-radar{position:absolute;inset:0;border-radius:9999px;border:2px solid ${tokenVar('gold-fill')};animation:alto-radar 2.4s cubic-bezier(0,0,.2,1) infinite;pointer-events:none}` +
    '@media (prefers-reduced-motion: reduce){.alto-radar{display:none}}';
  document.head.appendChild(st);
}
const RINGS = '<span class="alto-radar"></span><span class="alto-radar" style="animation-delay:1.2s"></span>';

export function paintMarker(root: HTMLElement, m: MapMarker) {
  if (m.label) {
    root.title = m.label;
    root.setAttribute('aria-label', m.label);
  }
  const el = root.firstElementChild as HTMLElement;
  // Theme-stable tokens: a marker sits on map tiles, not on the page, so
  // its fills keep the same ink in both themes (gold fill + on-accent ink,
  // a dark store tile + on-solid white).
  const gold = tokenVar('gold-fill');
  const ink = tokenVar('on-accent');
  const white = tokenVar('on-solid');
  const ring = m.highlight ? `box-shadow:0 0 0 4px ${tokenVar('gold-fill', 0.35)};` : '';
  if (m.kind === 'van') {
    // Built once, then only updated — so the heading arrow turns smoothly
    // and the pulse doesn't restart on every refresh.
    if (el.dataset.kind !== 'van') {
      el.dataset.kind = 'van';
      el.innerHTML =
        `<span data-pulse style="position:absolute;inset:-6px;border-radius:9999px;background:${tokenVar('gold-fill', 0.35)}" class="animate-ping motion-reduce:hidden"></span>` +
        `<span style="position:relative;display:grid;place-items:center">${BUS_SVG}</span>` +
        `<span data-arrow style="position:absolute;top:-9px;left:50%;width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-bottom:8px solid ${gold};transform-origin:50% 26px;transition:transform .9s ease"></span>` +
        `<span data-strike style="display:none;position:absolute;left:50%;top:-5px;bottom:-5px;width:3px;margin-left:-1.5px;border-radius:2px;transform:rotate(45deg);background:${scaleVar('negative', 600)};box-shadow:0 0 0 1.5px ${white}"></span>` +
        `<span data-tag style="display:none;position:absolute;top:calc(100% + 5px);left:50%;transform:translateX(-50%);white-space:nowrap;padding:0 6px;border-radius:6px;font:600 11px/17px system-ui,sans-serif;background:${tokenVar('navy')};color:${tokenVar('fg')};border:1px solid rgb(var(--color-line));box-shadow:0 1px 3px rgba(0,0,0,.25);pointer-events:none"></span>`;
    }
    const size = m.still ? 28 : 34;
    const fill = m.tone ? scaleVar(m.tone, 600) : gold;
    const face = m.hollow
      ? `background:${tokenVar('navy')};color:${tokenVar('fg')};border:2.5px dashed ${tokenVar('silver')};`
      : `background:${fill};color:${m.tone ? white : ink};border:2px solid ${white};`;
    el.style.cssText = `position:relative;width:${size}px;height:${size}px;border-radius:9999px;display:grid;place-items:center;${face}box-shadow:0 2px 8px rgba(0,0,0,.35);${ring}opacity:${m.stale ? 0.55 : 1};transition:opacity .3s`;
    el.dataset.tone = m.tone ?? 'gold';
    el.dataset.hollow = m.hollow ? '1' : '';
    el.dataset.struck = m.struck ? '1' : '';
    const pulse = el.querySelector<HTMLElement>('[data-pulse]');
    if (pulse) {
      pulse.style.display = m.stale || m.still || m.hollow ? 'none' : '';
      pulse.style.background = m.tone ? scaleVar(m.tone, 600, 0.35) : tokenVar('gold-fill', 0.35);
    }
    const arrow = el.querySelector<HTMLElement>('[data-arrow]');
    if (arrow) {
      const has = m.heading !== null && m.heading !== undefined && !m.hollow && !m.still;
      arrow.style.display = has ? '' : 'none';
      arrow.style.borderBottomColor = m.tone ? fill : gold;
      arrow.style.transformOrigin = `50% ${9 + size / 2}px`;
      if (has) arrow.style.transform = `translateX(-50%) rotate(${m.heading}deg)`;
    }
    const strike = el.querySelector<HTMLElement>('[data-strike]');
    if (strike) strike.style.display = m.struck ? '' : 'none';
    const tag = el.querySelector<HTMLElement>('[data-tag]');
    if (tag) {
      tag.style.display = m.tag ? '' : 'none';
      tag.textContent = m.tag ?? '';
    }
  } else if (m.kind === 'store' || m.kind === 'home') {
    const store = m.kind === 'store';
    const look = `position:relative;width:28px;height:28px;border-radius:${store ? '8px' : '9999px'};display:grid;place-items:center;background:${store ? ink : tokenVar('chart-2')};color:${white};border:2px solid ${white};box-shadow:0 2px 6px rgba(0,0,0,.3);${ring}`;
    const key = `${m.kind}:${m.pulse ? 1 : 0}`;
    el.style.cssText = look;
    // Rebuilt only when it changes, so the rings don't restart each refresh.
    if (el.dataset.kind !== key) {
      el.dataset.kind = key;
      if (m.pulse) ensureRadarCss();
      el.innerHTML = `${m.pulse ? RINGS : ''}<span style="position:relative;display:grid;place-items:center">${store ? STORE_SVG : HOME_SVG}</span>`;
    }
  } else {
    el.style.cssText = `min-width:22px;height:22px;padding:0 5px;border-radius:9999px;display:grid;place-items:center;background:${white};color:${ink};border:2px solid ${ink};font:600 11px/1 system-ui,sans-serif;box-shadow:0 1px 4px rgba(0,0,0,.25);${ring}`;
    el.textContent = m.order !== undefined ? String(m.order) : '•';
  }
}

export function lineSource(coords: Array<[number, number]>) {
  return {
    type: 'Feature' as const,
    properties: {},
    geometry: { type: 'LineString' as const, coordinates: coords },
  };
}

/** Several runs' routes as one source — a line needs two points. */
export function routesSource(routes: MapRoute[]) {
  return {
    type: 'FeatureCollection' as const,
    features: routes
      .filter((r) => r.coords.length > 1)
      .map((r) => ({
        type: 'Feature' as const,
        properties: { id: r.id, tone: r.tone ?? 'neutral', strong: r.strong ? 1 : 0 },
        geometry: { type: 'LineString' as const, coordinates: r.coords },
      })),
  };
}

/** The line colour per tone, resolved now (MapLibre parses colours itself) — the state tokens, so they flip with the tiles. */
const LINE_TOKEN: Record<MarkerTone, ColorToken> = { positive: 'success', caution: 'warning', negative: 'alert', neutral: 'silver' };

export function routeColorExpression(root?: Element): unknown[] {
  return [
    'match',
    ['get', 'tone'],
    'positive',
    tokenColor(LINE_TOKEN.positive, undefined, root),
    'caution',
    tokenColor(LINE_TOKEN.caution, undefined, root),
    'negative',
    tokenColor(LINE_TOKEN.negative, undefined, root),
    tokenColor(LINE_TOKEN.neutral, undefined, root),
  ];
}
