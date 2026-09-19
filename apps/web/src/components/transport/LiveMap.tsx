import { useEffect, useRef, useState } from 'react';
import { LngLatBounds, Map as MapLibreMap, Marker, NavigationControl, setWorkerUrl } from 'maplibre-gl/dist/maplibre-gl-csp.js';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-csp-worker.js?url';
import 'maplibre-gl/dist/maplibre-gl.css';
import { cn } from '@/lib/cn';

/**
 * The vans' map. MapLibre (open source) on OpenFreeMap tiles — no API key.
 *
 * MapLibre's CSP build: its web worker is a same-origin file, so the page's
 * Content-Security-Policy never has to allow blob: workers; the only
 * outside host is tiles.openfreemap.org (connect-src).
 *
 * Markers are kept by id and moved in place, so a van gliding along on
 * each refresh doesn't tear the map down. The view fits everything once,
 * and again only when the set of markers changes — the viewer can pan
 * and zoom without the map snapping back every few seconds.
 *
 * Loaded lazily (LazyLiveMap) — MapLibre is only downloaded by the pages
 * that show a map.
 */

setWorkerUrl(workerUrl);

const STYLE = {
  light: 'https://tiles.openfreemap.org/styles/positron',
  dark: 'https://tiles.openfreemap.org/styles/dark',
};

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
}

export interface LiveMapProps {
  markers: MapMarker[];
  /** Where the van goes next, in order — a dashed line. [lng, lat] pairs. */
  route?: Array<[number, number]>;
  /** Where the van has been — a solid line. [lng, lat] pairs. */
  trail?: Array<[number, number]>;
  /** The leg being driven right now — bold, flowing toward where it's
   *  headed (the van to the rider's pickup, or on to the store). */
  path?: Array<[number, number]>;
  ariaLabel: string;
  className?: string;
  /** Fit padding in px — room for a sheet laid over the map's foot. */
  padding?: number | { top: number; bottom: number; left: number; right: number };
  /** The closest a fit zooms in. */
  maxZoom?: number;
  /** Change it to fit everything again ("recenter"). */
  fitKey?: string | number;
  /** Zoom buttons (off for a thumbnail or a page with its own). */
  controls?: boolean;
  /** Off: a thumbnail — no panning, no zooming. */
  interactive?: boolean;
  /** Px a sheet overlaps the map's foot — the map credit sits above it. */
  footInset?: number;
  /** Set: tapping the map reports that spot — dropping a pickup's pin. */
  onPick?: (point: { lat: number; lng: number }) => void;
}

const BUS_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 6v6"/><path d="M15 6v6"/><path d="M2 12h19.6"/><path d="M18 18h3s.5-1.7.8-2.8c.1-.4.2-.8.2-1.2 0-.4-.1-.8-.2-1.2l-1.4-5C20.1 6.8 19.1 6 18 6H4a2 2 0 0 0-2 2v10h3"/><circle cx="7" cy="18" r="2"/><path d="M9 18h5"/><circle cx="16" cy="18" r="2"/></svg>';
const HOME_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const STORE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7"/><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="M15 22v-4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4"/><path d="M2 7h20"/></svg>';

// MapLibre positions a marker by writing its root element's transform, so
// the look lives on an inner element — repainting it on every refresh must
// never touch the root's style (that snapped markers to the corner).
function markerElement(m: MapMarker): HTMLElement {
  const root = document.createElement('div');
  root.setAttribute('role', 'img');
  root.appendChild(document.createElement('div'));
  paint(root, m);
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
    '.alto-radar{position:absolute;inset:0;border-radius:9999px;border:2px solid #D4A017;animation:alto-radar 2.4s cubic-bezier(0,0,.2,1) infinite;pointer-events:none}' +
    '@media (prefers-reduced-motion: reduce){.alto-radar{display:none}}';
  document.head.appendChild(st);
}
const RINGS = '<span class="alto-radar"></span><span class="alto-radar" style="animation-delay:1.2s"></span>';

function paint(root: HTMLElement, m: MapMarker) {
  if (m.label) {
    root.title = m.label;
    root.setAttribute('aria-label', m.label);
  }
  const el = root.firstElementChild as HTMLElement;
  const ring = m.highlight ? 'box-shadow:0 0 0 4px rgba(212,160,23,.35);' : '';
  if (m.kind === 'van') {
    // Built once, then only updated — so the heading arrow turns smoothly
    // and the pulse doesn't restart on every refresh.
    if (el.dataset.kind !== 'van') {
      el.dataset.kind = 'van';
      el.innerHTML = `<span data-pulse style="position:absolute;inset:-6px;border-radius:9999px;background:rgba(212,160,23,.35)" class="animate-ping motion-reduce:hidden"></span><span style="position:relative;display:grid;place-items:center">${BUS_SVG}</span><span data-arrow style="position:absolute;top:-9px;left:50%;width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-bottom:8px solid #D4A017;transform-origin:50% 26px;transition:transform .9s ease"></span>`;
    }
    el.style.cssText = `position:relative;width:34px;height:34px;border-radius:9999px;display:grid;place-items:center;background:#D4A017;color:#0B1832;border:2px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.35);${ring}opacity:${m.stale ? 0.55 : 1};transition:opacity .3s`;
    const pulse = el.querySelector<HTMLElement>('[data-pulse]');
    if (pulse) pulse.style.display = m.stale ? 'none' : '';
    const arrow = el.querySelector<HTMLElement>('[data-arrow]');
    if (arrow) {
      const has = m.heading !== null && m.heading !== undefined;
      arrow.style.display = has ? '' : 'none';
      if (has) arrow.style.transform = `translateX(-50%) rotate(${m.heading}deg)`;
    }
  } else if (m.kind === 'store' || m.kind === 'home') {
    const store = m.kind === 'store';
    const look = `position:relative;width:28px;height:28px;border-radius:${store ? '8px' : '9999px'};display:grid;place-items:center;background:${store ? '#0B1832' : '#2F6FDE'};color:#fff;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.3);${ring}`;
    const key = `${m.kind}:${m.pulse ? 1 : 0}`;
    el.style.cssText = look;
    // Rebuilt only when it changes, so the rings don't restart each refresh.
    if (el.dataset.kind !== key) {
      el.dataset.kind = key;
      if (m.pulse) ensureRadarCss();
      el.innerHTML = `${m.pulse ? RINGS : ''}<span style="position:relative;display:grid;place-items:center">${store ? STORE_SVG : HOME_SVG}</span>`;
    }
  } else {
    el.style.cssText = `min-width:22px;height:22px;padding:0 5px;border-radius:9999px;display:grid;place-items:center;background:#fff;color:#0B1832;border:2px solid #0B1832;font:600 11px/1 system-ui,sans-serif;box-shadow:0 1px 4px rgba(0,0,0,.25);${ring}`;
    el.textContent = m.order !== undefined ? String(m.order) : '•';
  }
}

function lineSource(coords: Array<[number, number]>) {
  return {
    type: 'Feature' as const,
    properties: {},
    geometry: { type: 'LineString' as const, coordinates: coords },
  };
}

/** The flowing dash on the leg being driven — MapLibre can't offset a
 *  dash, so the pattern steps through a sequence that reads as motion. */
const FLOW = [
  [0, 4, 3],
  [0.5, 4, 2.5],
  [1, 4, 2],
  [1.5, 4, 1.5],
  [2, 4, 1],
  [2.5, 4, 0.5],
  [3, 4, 0],
  [0, 0.5, 3, 3.5],
  [0, 1, 3, 3],
  [0, 1.5, 3, 2.5],
  [0, 2, 3, 2],
  [0, 2.5, 3, 1.5],
  [0, 3, 3, 1],
  [0, 3.5, 3, 0.5],
];

const GLIDE_MS = 1_600;
/** Further than this in one refresh is a jump (a reconnect), not a drive. */
const SNAP_M = 5_000;

function metersBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const x = rad(b.lng - a.lng) * Math.cos(rad((a.lat + b.lat) / 2));
  return Math.hypot(x, rad(b.lat - a.lat)) * 6_371_000;
}

export default function LiveMap({
  markers,
  route,
  trail,
  path,
  ariaLabel,
  className,
  padding = 48,
  maxZoom = 15,
  fitKey,
  controls = true,
  interactive = true,
  footInset = 0,
  onPick,
}: LiveMapProps) {
  const box = useRef<HTMLDivElement | null>(null);
  const map = useRef<MapLibreMap | null>(null);
  const pins = useRef(new Map<string, { marker: Marker; el: HTMLElement; kind: MapMarker['kind'] }>());
  const glides = useRef(new Map<string, number>());

  /** The van drives to its new spot instead of jumping — eased over
   *  ~1.6s — and the map follows it if it leaves the view. */
  function glide(m: MapLibreMap, id: string, marker: Marker, to: { lat: number; lng: number }) {
    const from = marker.getLngLat();
    const start = { lat: from.lat, lng: from.lng };
    cancelAnimationFrame(glides.current.get(id) ?? 0);
    const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced || metersBetween(start, to) > SNAP_M || metersBetween(start, to) < 1) {
      marker.setLngLat([to.lng, to.lat]);
      return;
    }
    const t0 = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / GLIDE_MS);
      const e = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
      marker.setLngLat([start.lng + (to.lng - start.lng) * e, start.lat + (to.lat - start.lat) * e]);
      if (t < 1) glides.current.set(id, requestAnimationFrame(step));
      else if (!m.getBounds().contains([to.lng, to.lat])) m.easeTo({ center: [to.lng, to.lat], duration: 800 });
    };
    glides.current.set(id, requestAnimationFrame(step));
  }
  const fittedFor = useRef('');
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!box.current) return;
    const dark = document.documentElement.dataset.theme === 'dark';
    let m: MapLibreMap;
    try {
      m = new MapLibreMap({
        container: box.current,
        style: dark ? STYLE.dark : STYLE.light,
        center: [-85.8, 30.2],
        zoom: 10,
        attributionControl: { compact: true },
        interactive,
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
      });
    } catch {
      // No WebGL (an old tablet, a locked-down browser): the page still
      // has every time and stop in text.
      setFailed(true);
      return;
    }
    if (interactive) m.touchZoomRotate.disableRotation();
    if (controls && interactive) m.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    // The map credit (OpenStreetMap's, required) as its small (i) — MapLibre
    // opens it wide on load, over the map's foot — and clear of any sheet.
    const credit = box.current.querySelector<HTMLElement>('.maplibregl-ctrl-bottom-right');
    if (credit && footInset) credit.style.marginBottom = `${footInset}px`;
    m.on('load', () => {
      box.current?.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
      m.addSource('trail', { type: 'geojson', data: lineSource([]) });
      m.addLayer({ id: 'trail', type: 'line', source: 'trail', paint: { 'line-color': '#D4A017', 'line-width': 4, 'line-opacity': 0.7 } });
      m.addSource('route', { type: 'geojson', data: lineSource([]) });
      m.addLayer({
        id: 'route',
        type: 'line',
        source: 'route',
        layout: { 'line-cap': 'round' },
        // Navy disappears on the dark tiles — the planned route reads silver there.
        paint: { 'line-color': dark ? '#C9D3E6' : '#0B1832', 'line-width': 3, 'line-dasharray': [1.5, 1.5], 'line-opacity': dark ? 0.75 : 0.6 },
      });
      m.addSource('path', { type: 'geojson', data: lineSource([]) });
      m.addLayer({
        id: 'path-casing',
        type: 'line',
        source: 'path',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': dark ? '#0B1832' : '#FFFFFF', 'line-width': 9, 'line-opacity': 0.9 },
      });
      m.addLayer({
        id: 'path',
        type: 'line',
        source: 'path',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#D4A017', 'line-width': 5 },
      });
      m.addLayer({
        id: 'path-flow',
        type: 'line',
        source: 'path',
        layout: { 'line-join': 'round' },
        paint: { 'line-color': '#FFF4CC', 'line-width': 2.5, 'line-dasharray': FLOW[0] },
      });
      setReady(true);
    });
    map.current = m;
    // A map whose box changes size (the page reflowing, full screen)
    // redraws at its new size instead of stretching.
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => m.resize()) : null;
    ro?.observe(box.current);
    const markersNow = pins.current;
    const glidesNow = glides.current;
    return () => {
      ro?.disconnect();
      for (const id of glidesNow.values()) cancelAnimationFrame(id);
      markersNow.clear();
      m.remove();
      map.current = null;
    };
    // The map is built once; its options are the first render's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Markers: add, move, repaint, remove — keyed by id. Fitting waits for
  // the map to load: before that it has no real size, and a fit then
  // lands every marker in a corner.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const seen = new Set<string>();
    for (const mk of markers) {
      seen.add(mk.id);
      const have = pins.current.get(mk.id);
      if (have && have.kind === mk.kind) {
        if (mk.kind === 'van') glide(m, mk.id, have.marker, { lat: mk.lat, lng: mk.lng });
        else have.marker.setLngLat([mk.lng, mk.lat]);
        paint(have.el, mk);
      } else {
        have?.marker.remove();
        const el = markerElement(mk);
        const marker = new Marker({ element: el }).setLngLat([mk.lng, mk.lat]).addTo(m);
        pins.current.set(mk.id, { marker, el, kind: mk.kind });
      }
    }
    for (const [id, pin] of pins.current) {
      if (!seen.has(id)) {
        pin.marker.remove();
        pins.current.delete(id);
      }
    }
    // Fit once per set of markers (and again when asked to).
    const key =
      markers
        .map((x) => x.id)
        .sort()
        .join('|') + `#${fitKey ?? ''}`;
    if (markers.length > 0 && key !== fittedFor.current) {
      const first = !fittedFor.current;
      fittedFor.current = key;
      m.resize();
      if (markers.length === 1) {
        m.easeTo({ center: [markers[0]!.lng, markers[0]!.lat], zoom: Math.min(14, maxZoom), duration: first ? 0 : 700 });
      } else {
        const b = new LngLatBounds();
        for (const x of markers) b.extend([x.lng, x.lat]);
        // A planned trip's arc bulges past its two ends — keep it in view.
        for (const c of route ?? []) b.extend(c);
        m.fitBounds(b, { padding, maxZoom, duration: first ? 0 : 700 });
      }
    }
    // The fit follows the markers and the ask; padding and the route's
    // shape ride along with them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markers, ready, fitKey]);

  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    (m.getSource('route') as { setData?: (d: unknown) => void } | undefined)?.setData?.(lineSource(route ?? []));
    (m.getSource('trail') as { setData?: (d: unknown) => void } | undefined)?.setData?.(lineSource(trail ?? []));
    (m.getSource('path') as { setData?: (d: unknown) => void } | undefined)?.setData?.(lineSource(path ?? []));
  }, [route, trail, path, ready]);

  // Dropping a pin: a tap on the map is the spot. The handler lives in a
  // ref so changing it never re-binds (or re-creates) the map.
  const pick = useRef(onPick);
  pick.current = onPick;
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const canvas = m.getCanvas();
    if (onPick) canvas.style.cursor = 'crosshair';
    const onClick = (e: { lngLat: { lat: number; lng: number } }) => pick.current?.({ lat: e.lngLat.lat, lng: e.lngLat.lng });
    m.on('click', onClick);
    return () => {
      m.off('click', onClick);
      if (canvas) canvas.style.cursor = '';
    };
  }, [ready, onPick]);

  // The leg being driven flows toward where it's going — unless the viewer
  // asked for less motion.
  const flowing = ready && (path?.length ?? 0) > 1;
  useEffect(() => {
    const m = map.current;
    if (!m || !flowing) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    let step = 0;
    let last = 0;
    let raf = 0;
    const tick = (now: number) => {
      if (now - last > 70) {
        last = now;
        step = (step + 1) % FLOW.length;
        if (m.getLayer('path-flow')) m.setPaintProperty('path-flow', 'line-dasharray', FLOW[step]);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [flowing]);

  if (failed) {
    return (
      <div className={cn('grid place-items-center rounded-md bg-navy-secondary/40 text-xs text-silver', className)}>
        Map not available on this device.
      </div>
    );
  }
  return <div ref={box} role="region" aria-label={ariaLabel} className={cn('overflow-hidden rounded-md', className)} />;
}
