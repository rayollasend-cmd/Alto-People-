import { describe, expect, it } from 'vitest';
import {
  DEMO_CAST,
  DEMO_CREW_TOTAL,
  DEMO_STORES,
  Rng,
  addDaysToKey,
  dayKeys,
  daysBetweenKeys,
  dealCrews,
  drawAttendance,
  emailLocal,
  mulberry32,
  planDay,
  weekdayOfKey,
} from '../../lib/demoSeed.js';

describe('demo seed: the random source', () => {
  it('is deterministic for a seed and different across seeds', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const c = mulberry32(43);
    const sa = Array.from({ length: 5 }, () => a());
    const sb = Array.from({ length: 5 }, () => b());
    const sc = Array.from({ length: 5 }, () => c());
    expect(sa).toEqual(sb);
    expect(sa).not.toEqual(sc);
    for (const x of sa) expect(x).toBeGreaterThanOrEqual(0);
    for (const x of sa) expect(x).toBeLessThan(1);
  });

  it('draws integers inside the inclusive range and uuids in v4 shape', () => {
    const rng = new Rng(7);
    for (let i = 0; i < 500; i++) {
      const n = rng.int(3, 5);
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(5);
    }
    const id = rng.uuid();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(new Rng(7).uuid()).not.toBe(id); // the 500 draws moved the stream
    expect(new Set(Array.from({ length: 1000 }, () => rng.uuid())).size).toBe(1000);
  });
});

describe('demo seed: the calendar', () => {
  it('walks day keys across month and DST boundaries by the calendar, not by 24h', () => {
    expect(addDaysToKey('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDaysToKey('2026-03-08', 1)).toBe('2026-03-09');
    expect(addDaysToKey('2026-01-01', -1)).toBe('2025-12-31');
    expect(dayKeys('2026-10-30', 3)).toEqual(['2026-10-30', '2026-10-31', '2026-11-01']);
    expect(daysBetweenKeys('2026-10-01', '2026-10-15')).toBe(14);
    expect(weekdayOfKey('2026-10-17')).toBe(6); // a Saturday — the org's week start
  });
});

describe('demo seed: the cast and the crews', () => {
  it('has one cast member per crew seat plus the five still onboarding, in three languages', () => {
    expect(DEMO_CAST.length).toBe(DEMO_CREW_TOTAL + 5);
    expect(new Set(DEMO_CAST.map((c) => c.lang))).toEqual(new Set(['en', 'es', 'tr']));
    const emails = DEMO_CAST.map((c) => emailLocal(c.first, c.last));
    expect(new Set(emails).size).toBe(emails.length);
    for (const e of emails) expect(e).toMatch(/^[a-z]+\.[a-z]+$/);
    expect(emailLocal('Sofía', 'Navarro')).toBe('sofia.navarro');
    expect(emailLocal('Emre', 'Yılmaz')).toBe('emre.yilmaz');
    expect(emailLocal('Zeynep', 'Şahin')).toBe('zeynep.sahin');
  });

  it('deals every store its crew with exactly one lead and both windows covered', () => {
    const crews = dealCrews(new Rng(1));
    expect(crews.length).toBe(DEMO_CREW_TOTAL);
    expect(new Set(crews.map((c) => c.castIndex)).size).toBe(crews.length);
    for (const store of DEMO_STORES) {
      const crew = crews.filter((c) => c.storeKey === store.key);
      expect(crew.length).toBe(store.crew);
      expect(crew.filter((c) => c.isLead).length).toBe(1);
      for (const w of store.windows) expect(crew.some((c) => c.window === w.label)).toBe(true);
      for (const m of crew) expect(m.offDays[0]).not.toBe(m.offDays[1]);
    }
  });

  it('plans a day at or under the window target and never schedules someone on their day off', () => {
    const crews = dealCrews(new Rng(1));
    const frontBeach = DEMO_STORES[0]!;
    const crew = crews.filter((c) => c.storeKey === frontBeach.key);
    for (let day = 0; day < 14; day++) {
      const weekday = day % 7;
      for (const w of frontBeach.windows) {
        const on = planDay(crew, w, day, weekday);
        expect(on.length).toBeLessThanOrEqual(w.target);
        expect(on.length).toBeGreaterThanOrEqual(w.target - 2);
        for (const m of on) {
          expect(m.window).toBe(w.label);
          expect(m.offDays).not.toContain(weekday);
        }
      }
    }
    // The rotation moves who gets cut: two days with the same weekday differ.
    const a = planDay(crew, frontBeach.windows[0]!, 0, 1).map((m) => m.castIndex);
    const b = planDay(crew, frontBeach.windows[0]!, 7, 1).map((m) => m.castIndex);
    expect(a).not.toEqual(b);
  });

  it('draws attendance that is mostly on time, sometimes late, rarely absent', () => {
    const rng = new Rng(99);
    const draws = Array.from({ length: 4000 }, () => drawAttendance(rng));
    const noShows = draws.filter((d) => d.noShow).length / draws.length;
    const late = draws.filter((d) => !d.noShow && d.lateMinutes > 5).length / draws.length;
    expect(noShows).toBeGreaterThan(0.01);
    expect(noShows).toBeLessThan(0.05);
    expect(late).toBeGreaterThan(0.04);
    expect(late).toBeLessThan(0.13);
  });
});
