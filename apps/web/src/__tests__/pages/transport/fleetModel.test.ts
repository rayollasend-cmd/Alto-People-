import { describe, expect, it } from 'vitest';
import { markerElement, paintMarker, routeColorExpression, routesSource, type MapMarker } from '@/components/transport/liveMapMarkers';
import {
  fleetGroup,
  fleetRoutes,
  groupVans,
  lateTone,
  orderExceptions,
  sosRunIds,
  spreadColocated,
  statusVariant,
  stopMarkers,
  telHref,
  vanMarker,
  vanStatus,
} from '@/pages/transport/live/fleetModel';
import { busyLiveRuns, busyMorning, exception, runOf, van } from './fixtures/busyMorning';

/**
 * The desk's fleet rules, on their own: what a van's state means on the
 * map and in the list, the one lateness scale, and the map's markers —
 * the fleet look added without changing how any other map's van looks.
 */

const NOW = Date.parse('2026-10-28T12:00:00Z');

describe('lateness — one scale everywhere', () => {
  it('is on time under 5 minutes, late from 5, very late from 15', () => {
    expect(lateTone(0)).toBe('positive');
    expect(lateTone(4)).toBe('positive');
    expect(lateTone(4.4)).toBe('positive');
    expect(lateTone(5)).toBe('caution');
    expect(lateTone(14)).toBe('caution');
    expect(lateTone(15)).toBe('negative');
    expect(lateTone(null)).toBe('positive');
  });
});

describe('van state → group, chip and marker', () => {
  const board = busyMorning(NOW);
  const byId = (id: string) => board.vans.find((v) => v.vanId === id)!;

  it('groups the vans the way the desk reads them', () => {
    expect(board.vans.map((v) => fleetGroup(v))).toEqual(['road', 'road', 'road', 'road', 'later', 'idle', 'out']);
    const g = groupVans(board.vans, new Set(['run3']));
    // The SOS first, then the latest, then by name.
    expect(g.road.map((v) => v.name)).toEqual(['Van 3', 'Van 2', 'Van 1', 'Van 4']);
    expect(g.later.map((v) => v.name)).toEqual(['Van 5']);
    expect(g.idle.map((v) => v.name)).toEqual(['Van 6']);
    expect(g.out.map((v) => v.name)).toEqual(['Van 7']);
  });

  it('gives each state one chip — the most urgent wins', () => {
    expect(vanStatus(byId('v1'))).toEqual({ kind: 'on_time' });
    expect(vanStatus(byId('v2'))).toEqual({ kind: 'late', minutes: 9, tone: 'caution' });
    expect(vanStatus(byId('v3'))).toEqual({ kind: 'late', minutes: 17, tone: 'negative' });
    expect(vanStatus(byId('v3'), { sos: true })).toEqual({ kind: 'sos' });
    expect(vanStatus(byId('v4'))).toEqual({ kind: 'no_signal', minutes: 6 });
    expect(vanStatus(byId('v1'), { stuck: true })).toEqual({ kind: 'not_closed' });
    expect(vanStatus(byId('v5'), { now: NOW })).toMatchObject({ kind: 'leaves' });
    expect(vanStatus(byId('v6'))).toEqual({ kind: 'idle' });
    expect(vanStatus(byId('v7'))).toEqual({ kind: 'out' });
    // Planned, its time has passed, and it hasn't started: it hasn't left (and its parked marker turns caution).
    const overdue = van({ vanId: 'o', name: 'Van 9', state: 'planned', position: { lat: 30, lng: -85, heading: null, at: '' }, nextRun: { runId: 'n', departAt: new Date(NOW - 43 * 60_000).toISOString(), driverName: 'Mike', riders: 1 } });
    expect(vanStatus(overdue, { now: NOW })).toMatchObject({ kind: 'not_left', minutes: 43 });
    expect(statusVariant(vanStatus(overdue, { now: NOW }))).toBe('pending');
    expect(vanMarker(overdue, { label: 'x', extras: { now: NOW } })).toMatchObject({ tone: 'caution', still: true });
    expect(vanStatus(byId('v5'), { now: NOW })).toMatchObject({ kind: 'leaves' });
    // Hours past its last stop is a run nobody closed, not "3h late".
    expect(vanStatus(van({ vanId: 'x', name: 'X', state: 'on_road', run: runOf(NOW, { runId: 'r', lateMinutes: 200 }) }))).toEqual({ kind: 'not_closed' });
  });

  it('colours the chip by status: on time positive, late caution, 15+ negative', () => {
    expect(statusVariant({ kind: 'on_time' })).toBe('success');
    expect(statusVariant({ kind: 'late', minutes: 9, tone: 'caution' })).toBe('pending');
    expect(statusVariant({ kind: 'late', minutes: 17, tone: 'negative' })).toBe('destructive');
    expect(statusVariant({ kind: 'sos' })).toBe('destructive');
    expect(statusVariant({ kind: 'no_signal', minutes: 6 })).toBe('pending');
    expect(statusVariant({ kind: 'leaves', at: '' })).toBe('info');
    expect(statusVariant({ kind: 'idle' })).toBe('default');
    expect(statusVariant({ kind: 'out' })).toBe('default');
  });

  it('draws a moving van with its heading in its lateness colour, a quiet one hollow, a parked one muted, an out-of-service one struck', () => {
    const m = (id: string, extras = {}) => vanMarker(byId(id), { label: id, extras: { now: NOW, ...extras } });
    expect(m('v1')).toMatchObject({ id: 'van-v1', kind: 'van', tone: 'positive', heading: 80, tag: 'Van 1' });
    expect(m('v2')).toMatchObject({ tone: 'caution' });
    expect(m('v3')).toMatchObject({ tone: 'negative' });
    expect(m('v3', { sos: true })).toMatchObject({ tone: 'negative' });
    expect(m('v4')).toMatchObject({ hollow: true });
    expect(m('v4')!.tone).toBeUndefined();
    expect(m('v5')).toMatchObject({ tone: 'neutral', still: true });
    expect(m('v5')!.struck).toBeUndefined();
    expect(m('v6')).toMatchObject({ tone: 'neutral', still: true });
    // Never reported a position: in the list, not on the map.
    expect(m('v7')).toBeNull();
    const struck = vanMarker(van({ vanId: 'v8', name: 'Van 8', state: 'out_of_service', position: { lat: 30, lng: -85, heading: null, at: '' } }), { label: 'x' });
    expect(struck).toMatchObject({ struck: true, still: true, tone: 'neutral' });
    expect(vanMarker(byId('v1'), { label: 'x', selected: true })!.highlight).toBe(true);
  });

  it('spreads vans parked on one spot side by side', () => {
    const markers = board.vans.map((v) => vanMarker(v, { label: v.name })).filter(Boolean) as MapMarker[];
    const spread = spreadColocated(markers);
    const v5 = spread.find((x) => x.id === 'van-v5')!;
    const v6 = spread.find((x) => x.id === 'van-v6')!;
    expect(v5.offset).toEqual([-21, 0]);
    expect(v6.offset).toEqual([21, 0]);
    expect(spread.find((x) => x.id === 'van-v1')!.offset).toBeUndefined();
  });

  it('draws a route for each van on the road — the picked one bold — and the picked one’s stops numbered', () => {
    const live = new Map(busyLiveRuns(NOW).map((r) => [r.runId, r]));
    const routes = fleetRoutes(board.vans, live, 'v2');
    expect(routes.map((r) => [r.id, r.tone, r.strong])).toEqual([
      ['run1', 'positive', false],
      ['run2', 'caution', true],
      ['run3', 'negative', false],
      ['run4', 'neutral', false],
    ]);
    // From where the van is, through every remaining stop.
    expect(routes[1]!.coords[0]).toEqual([-85.8601, 30.2012]);
    expect(routes[1]!.coords).toHaveLength(4);
    const stops = stopMarkers(live.get('run2'));
    expect(stops.map((s) => [s.kind, s.order ?? null, s.label])).toEqual([
      ['stop', 1, 'Seaside Housing'],
      ['stop', 2, 'Lagoon Court'],
      ['store', null, 'Front Beach 218'],
    ]);
  });
});

describe('the exceptions’ order', () => {
  it('pins an SOS on top, then the highest severity, then the oldest', () => {
    const list = [
      exception({ id: 'low', kind: 'open_issue', severity: 'low', at: '2026-10-28T10:00:00Z' }),
      exception({ id: 'med-new', kind: 'late', severity: 'medium', at: '2026-10-28T11:50:00Z' }),
      exception({ id: 'med-old', kind: 'late', severity: 'medium', at: '2026-10-28T11:00:00Z' }),
      exception({ id: 'high', kind: 'stalled', severity: 'high', at: '2026-10-28T11:55:00Z' }),
      exception({ id: 'sos', kind: 'sos', severity: 'high', at: '2026-10-28T11:59:00Z', runId: 'run9' }),
    ];
    expect(orderExceptions(list).map((e) => e.id)).toEqual(['sos', 'high', 'med-old', 'med-new', 'low']);
    expect([...sosRunIds(list)]).toEqual(['run9']);
  });

  it('dials a real number only', () => {
    expect(telHref('+1 850-555-0101')).toBe('tel:+18505550101');
    expect(telHref('(850) 555-0101')).toBe('tel:8505550101');
    expect(telHref('n/a')).toBeNull();
    expect(telHref(null)).toBeNull();
  });
});

describe('the map’s markers (liveMapMarkers)', () => {
  const inner = (root: HTMLElement) => root.firstElementChild as HTMLElement;

  it('paints a plain van exactly as before — gold, its arrow, its pulse — with no fleet extras showing', () => {
    const root = markerElement({ id: 'a', kind: 'van', lat: 0, lng: 0, heading: 45, label: 'Van 2 · Mike' });
    const el = inner(root);
    expect(root.getAttribute('aria-label')).toBe('Van 2 · Mike');
    expect(el.dataset.tone).toBe('gold');
    expect(el.style.width).toBe('34px');
    expect(el.querySelector<HTMLElement>('[data-arrow]')!.style.display).toBe('');
    expect(el.querySelector<HTMLElement>('[data-arrow]')!.style.transform).toContain('rotate(45deg)');
    expect(el.querySelector<HTMLElement>('[data-pulse]')!.style.display).toBe('');
    expect(el.querySelector<HTMLElement>('[data-strike]')!.style.display).toBe('none');
    expect(el.querySelector<HTMLElement>('[data-tag]')!.style.display).toBe('none');
  });

  it('paints the fleet looks: a status fill, hollow with no arrow or pulse, struck, a name tag, smaller when parked', () => {
    const root = markerElement({ id: 'a', kind: 'van', lat: 0, lng: 0, heading: 90, tone: 'caution', tag: 'Van 2' });
    const el = inner(root);
    expect(el.dataset.tone).toBe('caution');
    expect(el.querySelector('[data-tag]')!.textContent).toBe('Van 2');
    expect(el.querySelector<HTMLElement>('[data-tag]')!.style.display).toBe('');

    paintMarker(root, { id: 'a', kind: 'van', lat: 0, lng: 0, heading: 90, hollow: true, tag: 'Van 2' });
    expect(el.dataset.hollow).toBe('1');
    expect(el.querySelector<HTMLElement>('[data-arrow]')!.style.display).toBe('none');
    expect(el.querySelector<HTMLElement>('[data-pulse]')!.style.display).toBe('none');

    paintMarker(root, { id: 'a', kind: 'van', lat: 0, lng: 0, tone: 'neutral', still: true, struck: true });
    expect(el.dataset.struck).toBe('1');
    expect(el.querySelector<HTMLElement>('[data-strike]')!.style.display).toBe('');
    expect(el.style.width).toBe('28px');
    expect(el.querySelector<HTMLElement>('[data-tag]')!.style.display).toBe('none');
  });

  it('feeds MapLibre one line per route with two points or more, coloured by tone', () => {
    const src = routesSource([
      { id: 'a', coords: [[0, 0], [1, 1]], tone: 'caution', strong: true },
      { id: 'b', coords: [[0, 0]] },
    ]);
    expect(src.features).toHaveLength(1);
    expect(src.features[0]!.properties).toEqual({ id: 'a', tone: 'caution', strong: 1 });
    const expr = routeColorExpression();
    expect(expr.slice(0, 2)).toEqual(['match', ['get', 'tone']]);
    expect(expr.filter((x) => typeof x === 'string' && x.startsWith('rgb'))).toHaveLength(4);
  });
});
