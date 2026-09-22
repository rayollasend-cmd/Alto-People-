import { describe, expect, it } from 'vitest';

/**
 * What the SOP retyping script will and will not touch.
 *
 * The script rewrites production SOP templates, so the interesting part
 * is not what it catches but what it leaves alone. Two ways to get this
 * wrong, and they are not symmetrical:
 *
 *   too greedy   "Check the freezer door seal" becomes a TEMPERATURE with
 *                a -30..0 band, so a supervisor is asked for a reading
 *                where there is nothing to read and the shift cannot be
 *                submitted clean.
 *   too generous a cooler task handed the freezer band alarms at 35°F, or
 *                worse, a freezer handed the cooler band stays silent at
 *                +15°F — the exact failure the retyping exists to end.
 *
 * So the rule is "looks like a measurement", not "mentions a cold thing",
 * and a band is only applied where the title names a case. Anything else
 * is reported for a human rather than guessed at.
 */

const READS_A_TEMPERATURE =
  /(\btemp(erature)?\b|°\s*[fc]\b|\bdeg(rees)?\b|\bthermometer\b)/i;
const ABOUT_THE_PAPERWORK =
  /(\blogs?\b|\bcoverage\b|\bapproved\b|\breviewed\b|\bsigned\b|\bsign[- ]?off\b|\bcomplete[d]?\b|\binspected\b|\bhandoff\b|\btraining\b|\bpolicy\b)/i;
const readsATemperature = (title: string) =>
  READS_A_TEMPERATURE.test(title) && !ABOUT_THE_PAPERWORK.test(title);

const BANDS: Array<{ name: string; test: RegExp; min: number; max: number }> = [
  { name: 'freezer', test: /\b(freezer|frozen)\b/i, min: -30, max: 0 },
  { name: 'meat case', test: /\b(meat|deli|seafood|poultry)\b/i, min: 28, max: 40 },
  { name: 'cooler', test: /\b(cooler|chill|refrigerat|dairy|produce|milk)\b/i, min: 32, max: 40 },
];
const bandFor = (title: string) => BANDS.find((b) => b.test.test(title)) ?? null;

describe('which tasks are asking for a reading', () => {
  it('catches the ways a temperature task is actually named', () => {
    for (const title of [
      'Freezer case temperature',
      'Check deli cooler temp',
      'Record walk-in °F',
      'Milk case temperature check',
      'Thermometer check — frozen load',
      'Dock temp on arrival',
    ]) {
      expect(readsATemperature(title), title).toBe(true);
    }
  });

  it('leaves alone the tasks that merely mention something cold', () => {
    // Each of these is a real CHECK. Retyping one asks for a number that
    // does not exist, and a required task with no answer blocks a submit.
    for (const title of [
      'Check the freezer door seal',
      'Freezer floor swept and clear',
      'Rotate frozen stock, oldest to the front',
      'Cooler curtains hung',
      'Report any freezer alarm to the manager',
      'Deli case fronted and faced',
    ]) {
      expect(readsATemperature(title), title).toBe(false);
    }
  });

  it('leaves alone the paperwork, which is what the first dry run caught', () => {
    // Verbatim from the seeded library. Every one matched on the word
    // "temperature" alone and every one is a correctly-typed YES_NO or
    // CHECK — a sign-off, a rota, an inspection. Ten of them, presented
    // as "set the band by hand", which is advice that would have turned
    // ten answerable questions into ten unanswerable ones.
    for (const title of [
      'Temperature logs complete for the shift',
      'Temperature and sanitation logs signed off',
      'Temperature and sanitation logs complete',
      'Overnight handoff notes and temperature logs reviewed',
      'Lunches approved by the Team Lead, with floor and temperature coverage kept',
      'Load inspected for damage and temperature',
    ]) {
      expect(readsATemperature(title), title).toBe(false);
      // The word IS there — the exclusion is doing the work, not luck.
      expect(READS_A_TEMPERATURE.test(title), title).toBe(true);
    }
  });
});

describe('which band a title earns', () => {
  it('gives a freezer the below-zero band', () => {
    expect(bandFor('Freezer case temperature')).toMatchObject({ min: -30, max: 0 });
    expect(bandFor('Frozen load temp on arrival')).toMatchObject({ min: -30, max: 0 });
  });

  it('reads frozen BEFORE case, so a frozen food case is not a cooler', () => {
    // Order-dependent, and the consequence of getting it wrong is a
    // freezer that never alarms: 32..40 would pass a freezer at +35°F.
    const band = bandFor('Frozen food case temperature');
    expect(band).toMatchObject({ name: 'freezer', min: -30, max: 0 });
  });

  it('separates the meat case from the general cooler band', () => {
    expect(bandFor('Deli case temperature')).toMatchObject({ min: 28, max: 40 });
    expect(bandFor('Dairy cooler temperature')).toMatchObject({ min: 32, max: 40 });
  });

  it('refuses to guess when the title names no case', () => {
    // Reported for a human instead. A TEMPERATURE with no band records
    // and never alerts, which is the same silence in a different costume.
    expect(bandFor('Record the temperature')).toBeNull();
    expect(bandFor('Back room temp check')).toBeNull();
  });
});
