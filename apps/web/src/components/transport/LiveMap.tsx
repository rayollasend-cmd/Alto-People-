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
}

export interface LiveMapProps {
  markers: MapMarker[];
  /** Where the van goes next, in order — a dashed line. [lng, lat] pairs. */
  route?: Array<[number, number]>;
  /** Where the van has been — a solid line. [lng, lat] pairs. */
  trail?: Array<[number, number]>;
  ariaLabel: string;
  className?: string;
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
  } else if (m.kind === 'store') {
    el.style.cssText = `width:28px;height:28px;border-radius:8px;display:grid;place-items:center;background:#0B1832;color:#fff;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.3);${ring}`;
    el.innerHTML = STORE_SVG;
  } else if (m.kind === 'home') {
    el.style.cssText = `width:28px;height:28px;border-radius:9999px;display:grid;place-items:center;background:#2F6FDE;color:#fff;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.3);${ring}`;
    el.innerHTML = HOME_SVG;
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

const GLIDE_MS = 1_600;
/** Further than this in one refresh is a jump (a reconnect), not a drive. */
const SNAP_M = 5_000;

function metersBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const x = rad(b.lng - a.lng) * Math.cos(rad((a.lat + b.lat) / 2));
  return Math.hypot(x, rad(b.lat - a.lat)) * 6_371_000;
}

export default function LiveMap({ markers, route, trail, ariaLabel, className }: LiveMapProps) {
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
    m.touchZoomRotate.disableRotation();
    m.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    m.on('load', () => {
      m.addSource('trail', { type: 'geojson', data: lineSource([]) });
      m.addLayer({ id: 'trail', type: 'line', source: 'trail', paint: { 'line-color': '#D4A017', 'line-width': 4, 'line-opacity': 0.7 } });
      m.addSource('route', { type: 'geojson', data: lineSource([]) });
      m.addLayer({
        id: 'route',
        type: 'line',
        source: 'route',
        paint: { 'line-color': '#0B1832', 'line-width': 3, 'line-dasharray': [1.5, 1.5], 'line-opacity': 0.6 },
      });
      setReady(true);
    });
    map.current = m;
    const markersNow = pins.current;
    const glidesNow = glides.current;
    return () => {
      for (const id of glidesNow.values()) cancelAnimationFrame(id);
      markersNow.clear();
      m.remove();
      map.current = null;
    };
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
    // Fit once per set of markers.
    const key = markers
      .map((x) => x.id)
      .sort()
      .join('|');
    if (key && key !== fittedFor.current) {
      fittedFor.current = key;
      m.resize();
      if (markers.length === 1) {
        m.jumpTo({ center: [markers[0]!.lng, markers[0]!.lat], zoom: 14 });
      } else {
        const b = new LngLatBounds();
        for (const x of markers) b.extend([x.lng, x.lat]);
        m.fitBounds(b, { padding: 48, maxZoom: 15, duration: 0 });
      }
    }
  }, [markers, ready]);

  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    (m.getSource('route') as { setData?: (d: unknown) => void } | undefined)?.setData?.(lineSource(route ?? []));
    (m.getSource('trail') as { setData?: (d: unknown) => void } | undefined)?.setData?.(lineSource(trail ?? []));
  }, [route, trail, ready]);

  if (failed) {
    return (
      <div className={cn('grid place-items-center rounded-md bg-navy-secondary/40 text-xs text-silver', className)}>
        Map not available on this device.
      </div>
    );
  }
  return <div ref={box} role="region" aria-label={ariaLabel} className={cn('overflow-hidden rounded-md', className)} />;
}
