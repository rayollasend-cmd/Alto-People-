import { afterEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { I18nProvider, useI18n, type Lang } from '@/lib/i18n';
import { en } from '@/lib/i18n/english';
import { tr } from '@/lib/i18n/tr';
import { ht } from '@/lib/i18n/ht';
import { pt } from '@/lib/i18n/pt';
import { uk } from '@/lib/i18n/uk';
import {
  fmtMoney,
  fmtHours,
  fmtRelativeDayTz,
  fmtWeekdayTz,
  displayLocale,
  numberLocale,
  relativeDayWord,
} from '@/lib/format';
import { dayHeading, isRelativeDayHeading } from '@/lib/dayGroup';
import { DOORS, MODULES, ASSOCIATE_MODULE_KEYS, type ModuleNav } from '@/lib/modules';
import { NAV_DOOR_KEYS, NAV_MODULE_KEYS, localizeModules, localizeShape, homeLabel } from '@/lib/navI18n';
import '@/lib/i18n/en/tabs';
import '@/lib/i18n/en/earn';
import '@/lib/i18n/en/sched';
import '@/lib/i18n/en/hero';

/**
 * Deep audit 2026-10-29, ASSOC-11: in Turkish, Haitian Creole, Portuguese
 * and Ukrainian the associate's app fell back to English — the tabs
 * ("Schedule", "Pay", "Ride"), "4 teammates on with you", "Ready to earn…",
 * "Show recent shifts", the More menu, and dates ("Mon, Nov 2").
 */

const PACKS: Record<Exclude<Lang, 'en' | 'es'>, Partial<Record<string, string>>> = { tr, ht, pt, uk };

afterEach(() => {
  document.documentElement.lang = 'en';
});

describe('the associate app in every language', () => {
  it('has the words the audit found in English, in tr, ht, pt and uk', () => {
    const keys = [
      'tabs.schedule',
      'tabs.pay',
      'tabs.ride',
      'tabs.timeOff',
      'hero.withYouMany',
      'earn.readyToday',
      'sched.showRecent',
      'nav.home',
      'nav.door.mySchedule',
      'nav.door.myPay',
      'nav.door.myRecords',
    ];
    for (const [lang, pack] of Object.entries(PACKS)) {
      for (const k of keys) {
        expect(pack[k], `${lang} ${k}`).toBeTruthy();
        expect(pack[k], `${lang} ${k}`).not.toBe(en[k]);
      }
    }
  });

  it('names every page and door an associate sees in their language', () => {
    for (const key of ASSOCIATE_MODULE_KEYS) {
      if (key === 'payroll') continue; // "Paystubs" (roleNavLabels, nav.paystubs)
      expect(NAV_MODULE_KEYS[key], key).toBeDefined();
    }
    for (const door of ['me', 'my-schedule', 'my-pay', 'my-records'] as const) expect(NAV_DOOR_KEYS[door], door).toBeDefined();
  });

  // A page renamed in lib/modules.ts must take its key with it, or the other
  // languages keep the old name (lib/navI18n shows the English then).
  it('the nav keys say what lib/modules.ts says', () => {
    for (const [mod, key] of Object.entries(NAV_MODULE_KEYS)) {
      expect(en[key!], mod).toBe(MODULES.find((m) => m.key === mod)?.label);
    }
    for (const [door, key] of Object.entries(NAV_DOOR_KEYS)) {
      expect(en[key!], door).toBe(DOORS[door as keyof typeof DOORS].label);
    }
  });

  it('swaps a label only while it still matches its key, and leaves English alone', () => {
    const t = (k: string) => (pt as Record<string, string>)[k] ?? en[k]!;
    const mods: ModuleNav[] = [
      MODULES.find((m) => m.key === 'messages')!,
      { ...MODULES.find((m) => m.key === 'learning')!, label: 'My training' },
    ];
    const out = localizeModules(mods, t as never);
    expect(out[0]!.label).toBe(pt['nav.mod.messages']);
    expect(out[1]!.label).toBe('My training');
    const shape = localizeShape(
      { rows: [], doors: [{ key: 'my-pay', label: 'My pay', target: mods[0]!, children: [] }], dropped: [] },
      t as never,
    );
    expect(shape.doors[0]!.label).toBe(pt['nav.door.myPay']);
    expect(homeLabel(((k: string) => en[k]!) as never)).toBe('Home');
  });

  it('renders the More menu words in Turkish through t()', () => {
    function Probe() {
      const { t } = useI18n();
      return <span data-testid="door">{t('nav.door.mySchedule')}</span>;
    }
    localStorage.setItem('alto.lang', 'tr');
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByTestId('door').textContent).toBe(tr['nav.door.mySchedule']);
    localStorage.clear();
  });
});

describe('dates in the reader’s language, money as the paycheck prints it', () => {
  const MON_NOV_2 = '2026-11-02T18:00:00Z';

  it('weekday and month names follow <html lang>', () => {
    document.documentElement.lang = 'en';
    expect(fmtWeekdayTz(MON_NOV_2, 'America/Chicago')).toBe('Mon');
    const expected: Record<string, RegExp> = { tr: /Pzt/, pt: /seg/, uk: /пн/, ht: /lun/, es: /lun/ };
    for (const [lang, re] of Object.entries(expected)) {
      document.documentElement.lang = lang;
      expect(fmtWeekdayTz(MON_NOV_2, 'America/Chicago'), lang).toMatch(re);
    }
    document.documentElement.lang = 'uk';
    expect(displayLocale()).toBe('uk-UA');
  });

  it('"Today" and "Tomorrow" are words in every language', () => {
    const now = Date.parse('2026-11-02T15:00:00Z');
    for (const [lang, today, tomorrow] of [
      ['tr', 'Bugün', 'Yarın'],
      ['ht', 'Jodi a', 'Demen'],
      ['pt', 'Hoje', 'Amanhã'],
      ['uk', 'Сьогодні', 'Завтра'],
    ] as const) {
      document.documentElement.lang = lang;
      expect(fmtRelativeDayTz('2026-11-02T20:00:00Z', 'America/Chicago', now)).toBe(today);
      expect(fmtRelativeDayTz('2026-11-03T20:00:00Z', 'America/Chicago', now)).toBe(tomorrow);
      expect(relativeDayWord('yesterday')).toBeTruthy();
    }
  });

  it('day headings (paystubs, notifications) say Today in the language and stay recognisable', () => {
    document.documentElement.lang = 'pt';
    const d = new Date();
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    expect(dayHeading(key)).toBe('Hoje');
    expect(isRelativeDayHeading('Hoje')).toBe(true);
    expect(isRelativeDayHeading('Bugün')).toBe(true);
    expect(isRelativeDayHeading('segunda-feira, 2 de nov.')).toBe(false);
  });

  it('money and hours keep US formatting in every language', () => {
    for (const lang of ['tr', 'ht', 'pt', 'uk']) {
      document.documentElement.lang = lang;
      expect(numberLocale()).toBe('en-US');
      expect(fmtMoney(1234.5)).toBe('$1,234.50');
      expect(fmtHours(7.5)).toBe('7.5h');
    }
  });
});

describe('“9h ago” in the reader’s language', () => {
  it('keeps English as it was, and says it in tr, ht, pt and uk', async () => {
    const { fmtRelativeDate } = await import('@/lib/format');
    const nineHoursAgo = new Date(Date.now() - 9 * 3_600_000);
    document.documentElement.lang = 'en';
    expect(fmtRelativeDate(nineHoursAgo)).toBe('9h ago');
    expect(fmtRelativeDate(new Date(Date.now() - 26 * 3_600_000), { yesterday: false })).toBe('1d ago');
    document.documentElement.lang = 'tr';
    expect(fmtRelativeDate(nineHoursAgo)).toMatch(/9 sa\.? önce/);
    document.documentElement.lang = 'pt';
    expect(fmtRelativeDate(nineHoursAgo)).toMatch(/há 9 h/);
    document.documentElement.lang = 'uk';
    expect(fmtRelativeDate(nineHoursAgo)).toMatch(/9 год/);
    document.documentElement.lang = 'ht';
    expect(fmtRelativeDate(nineHoursAgo)).toBe('9 è de sa');
  });
});
