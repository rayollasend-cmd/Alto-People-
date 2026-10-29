import { useEffect, useRef, useState } from 'react';
import { LngLatBounds, Map as MapLibreMap, Marker, NavigationControl, setWorkerUrl } from 'maplibre-gl';
// `?worker&url`, not `?url`: the dist worker imports its sibling shared
// chunk, and only Vite's worker pipeline emits it self-contained (a plain
// `?url` copies the file verbatim and the worker dies on its first import).
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import { cn } from '@/lib/cn';
import { tokenColor } from '@/lib/tokenColor';
import { lineSource, markerElement, paintMarker as paint, routeColorExpression, routesSource, type MapMarker, type MapRoute } from './liveMapMarkers';

export type { MapMarker, MapRoute, MarkerTone } from './liveMapMarkers';

/**
 * The vans' map. MapLibre (open source) on OpenFreeMap tiles — no API key.
 *
 * MapLibre 6 is ESM-only and spawns its worker from a URL we hand it; Vite
 * bundles that worker as a same-origin file, so the page's Content-
 * Security-Policy never has to allow blob: workers; the only outside host
 * is tiles.openfreemap.org (connect-src). v6 needs WebGL2 — a device
 * without it lands in the catch below and keeps the text view.
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
  /**
   * One finger scrolls the PAGE, two move the map.
   *
   * For a map sitting INLINE in a scrolling page: a tall map under the
   * thumb swallows every vertical swipe that starts on it, so the page
   * behind it cannot be scrolled past. Off — the default — for a map that
   * owns its screen: a full-screen view or a pin dialog is the only thing
   * you can be touching, so one finger should just work there, and asking
   * for two would be an obstacle rather than a rescue.
   */
  cooperativeGestures?: boolean;
  /** Px a sheet overlaps the map's foot — the map credit sits above it. */
  footInset?: number;
  /** Set: tapping the map reports that spot — dropping a pickup's pin. */
  onPick?: (point: { lat: number; lng: number }) => void;
  /** Set: tapping a marker reports its id — the dispatch map reorders pickups this way. */
  onMarkerClick?: (id: string) => void;
  /** Several runs' routes at once — the desk's fleet map (one line per van on the road). */
  routes?: MapRoute[];
  /** Where the map opens while there is no marker to fit (the depot, the first store). */
  center?: { lat: number; lng: number } | null;
  /** Pan to this point whenever `key` changes — the van just picked from a list. */
  focus?: { lat: number; lng: number; key: string | number } | null;
  /**
   * Fit only the first set of markers (and again when `fitKey` changes),
   * not every time the set changes — for a map whose stops come and go
   * with a selection, so picking a van doesn't throw the view around.
   */
  fitOnce?: boolean;
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
  cooperativeGestures = false,
  footInset = 0,
  onPick,
  onMarkerClick,
  routes,
  center,
  focus,
  fitOnce = false,
}: LiveMapProps) {
  const markerClick = useRef(onMarkerClick);
  markerClick.current = onMarkerClick;
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
        center: center ? [center.lng, center.lat] : [-85.8, 30.2],
        zoom: center ? 11 : 10,
        attributionControl: { compact: true },
        interactive,
        cooperativeGestures,
        // MapLibre's own wording is "Use two fingers to move the map" and
        // "Use ⌘ + scroll to zoom the map". Said plainly, and as an
        // instruction rather than a description of the feature.
        locale: {
          'CooperativeGesturesHandler.MobileHelpText': 'Use two fingers to move the map',
          'CooperativeGesturesHandler.MacHelpText': 'Hold ⌘ and scroll to zoom the map',
          'CooperativeGesturesHandler.WindowsHelpText': 'Hold Ctrl and scroll to zoom the map',
        },
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
      // The fleet's routes sit under every other line: thin dashes for the
      // vans not picked, solid and bold for the one that is.
      m.addSource('fleet', { type: 'geojson', data: routesSource([]) });
      m.addLayer({
        id: 'fleet-routes',
        type: 'line',
        source: 'fleet',
        filter: ['==', ['get', 'strong'], 0],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': routeColorExpression() as never, 'line-width': 2.5, 'line-dasharray': [1.5, 1.5], 'line-opacity': 0.7 },
      });
      m.addLayer({
        id: 'fleet-routes-strong',
        type: 'line',
        source: 'fleet',
        filter: ['==', ['get', 'strong'], 1],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': routeColorExpression() as never, 'line-width': 5, 'line-opacity': 0.95 },
      });
      m.addSource('trail', { type: 'geojson', data: lineSource([]) });
      // MapLibre parses paint colours itself: the tokens, resolved now.
      const gold = tokenColor('gold-fill');
      m.addLayer({ id: 'trail', type: 'line', source: 'trail', paint: { 'line-color': gold, 'line-width': 4, 'line-opacity': 0.7 } });
      m.addSource('route', { type: 'geojson', data: lineSource([]) });
      m.addLayer({
        id: 'route',
        type: 'line',
        source: 'route',
        layout: { 'line-cap': 'round' },
        // The muted-ink token: silver on the dark tiles (navy disappears
        // there), slate on the light ones.
        paint: { 'line-color': tokenColor('silver'), 'line-width': 3, 'line-dasharray': [1.5, 1.5], 'line-opacity': dark ? 0.75 : 0.6 },
      });
      m.addSource('path', { type: 'geojson', data: lineSource([]) });
      m.addLayer({
        id: 'path-casing',
        type: 'line',
        source: 'path',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        // The page surface: navy under the dark tiles, white under the light.
        paint: { 'line-color': tokenColor('navy'), 'line-width': 9, 'line-opacity': 0.9 },
      });
      m.addLayer({
        id: 'path',
        type: 'line',
        source: 'path',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': gold, 'line-width': 5 },
      });
      m.addLayer({
        id: 'path-flow',
        type: 'line',
        source: 'path',
        layout: { 'line-join': 'round' },
        // A pale dash over the gold that reads as motion in either theme.
        paint: { 'line-color': tokenColor('on-solid', 0.8), 'line-width': 2.5, 'line-dasharray': FLOW[0] },
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
        have.marker.setOffset(mk.offset ?? [0, 0]);
        paint(have.el, mk);
      } else {
        have?.marker.remove();
        const el = markerElement(mk);
        el.addEventListener('click', (ev) => {
          if (!markerClick.current) return;
          ev.stopPropagation();
          markerClick.current(mk.id);
        });
        if (markerClick.current) el.style.cursor = 'pointer';
        const marker = new Marker({ element: el, offset: mk.offset ?? [0, 0] }).setLngLat([mk.lng, mk.lat]).addTo(m);
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
    const key = fitOnce
      ? `#${fitKey ?? ''}`
      : markers
          .map((x) => x.id)
          .sort()
          .join('|') + `#${fitKey ?? ''}`;
    if (markers.length > 0 && key !== fittedFor.current) {
      const first = !fittedFor.current;
      fittedFor.current = key;
      m.resize();
      if (markers.length === 1) {
        // ONE marker has no bounds to fit, so there is nothing for maxZoom
        // to cap — it is simply the zoom the caller asked for. It used to
        // be `Math.min(14, maxZoom)`, which meant the prop could only ever
        // zoom OUT: both pin dialogs pass 17 and both got 14.
        //
        // At z14 near 30°N the scale is ~8.3 m/px, so a 390px phone shows
        // ~3.2km and a fingertip covers ~365m of ground. "Tap the map
        // where the van should stop" cannot be done at that zoom — you are
        // tapping a city block — so a rider either gave up or dropped a
        // pin a few hundred metres from their door and the driver could
        // not find them, which is the exact failure the pin exists to
        // prevent. It hit the driver's own pin dialog the same way.
        m.easeTo({ center: [markers[0]!.lng, markers[0]!.lat], zoom: maxZoom, duration: first ? 0 : 700 });
      } else {
        const b = new LngLatBounds();
        for (const x of markers) b.extend([x.lng, x.lat]);
        // A planned trip's arc bulges past its two ends — keep it in view.
        for (const c of route ?? []) b.extend(c);
        for (const r of routes ?? []) for (const c of r.coords) b.extend(c);
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

  // The fleet's routes — their colours resolved again on each change, so a
  // theme switch reaches the lines by the next refresh.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    (m.getSource('fleet') as { setData?: (d: unknown) => void } | undefined)?.setData?.(routesSource(routes ?? []));
    if (routes?.length) {
      for (const id of ['fleet-routes', 'fleet-routes-strong']) if (m.getLayer(id)) m.setPaintProperty(id, 'line-color', routeColorExpression() as never);
    }
  }, [routes, ready]);

  // No marker to fit: open where the work is.
  const centerKey = center ? `${center.lat},${center.lng}` : '';
  const noMarkers = markers.length === 0;
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !center || !noMarkers) return;
    m.jumpTo({ center: [center.lng, center.lat], zoom: Math.max(m.getZoom(), 11) });
    // Only when the place itself changes (or the map becomes ready).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centerKey, ready, noMarkers]);

  // A van picked from a list: glide the view to it, closer if needed.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !focus) return;
    const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    m.easeTo({ center: [focus.lng, focus.lat], zoom: Math.max(m.getZoom(), 13), duration: reduced ? 0 : 700 });
    // Keyed on the ask, not the van's every move.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.key, ready]);

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
