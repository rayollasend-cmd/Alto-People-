import { DASHBOARD_NAV, type DoorKey, type ModuleKey, type ModuleNav, type NavShape } from './modules';
import { en } from './i18n/english';
import type { MessageKey } from './i18n';

/**
 * The nav in the reader's language (deep audit 2026-10-29, ASSOC-11).
 *
 * lib/modules.ts names every page and door in English. These keys (in the
 * core pack, so the shell has them before any page loads) name the ones an
 * associate and a driver see, in all six app languages: the More menu, the
 * sidebar, the search palette and the top bar's page name.
 *
 * A label is swapped only while modules.ts still says what the key's English
 * says. Rename a page there without its key and the page keeps its new
 * (English) name instead of showing a stale translation of the old one —
 * and __tests__/lib/navI18n.test.ts fails until the key follows.
 */
export const NAV_MODULE_KEYS: Partial<Record<ModuleKey, MessageKey>> = {
  me: 'nav.mod.me',
  messages: 'nav.mod.messages',
  wallet: 'nav.mod.wallet',
  'my-discipline': 'nav.mod.myDiscipline',
  benefits: 'nav.mod.benefits',
  scheduling: 'nav.mod.scheduling',
  marketplace: 'nav.mod.marketplace',
  'time-attendance': 'nav.mod.timeAttendance',
  rides: 'nav.mod.rides',
  'time-off': 'nav.mod.timeOff',
  documents: 'nav.mod.documents',
  communications: 'nav.mod.communications',
  reimbursements: 'nav.mod.reimbursements',
  learning: 'nav.mod.learning',
  'internal-jobs': 'nav.mod.internalJobs',
  agreements: 'nav.mod.agreements',
  'hr-cases': 'nav.mod.hrCases',
  leave: 'nav.mod.leave',
  'help-center': 'nav.mod.helpCenter',
  // The associate's payroll page is "Paystubs" (roleNavLabels, nav.paystubs).
};

export const NAV_DOOR_KEYS: Partial<Record<DoorKey, MessageKey>> = {
  me: 'nav.door.me',
  'my-schedule': 'nav.door.mySchedule',
  'my-pay': 'nav.door.myPay',
  'my-records': 'nav.door.myRecords',
};

type Translate = (key: MessageKey) => string;

function swap(label: string, key: MessageKey | undefined, t: Translate): string {
  return key && en[key] === label ? t(key) : label;
}

/** The modules with their names in the app language (run after applyTerms and roleNavLabels). */
export function localizeModules(modules: ModuleNav[], t: Translate): ModuleNav[] {
  return modules.map((m) => {
    const label = swap(m.label, NAV_MODULE_KEYS[m.key], t);
    return label === m.label ? m : { ...m, label };
  });
}

/** One module's name in the app language — for a page outside the reader's nav. */
export function localizeModule<M extends ModuleNav | null | undefined>(m: M, t: Translate): M {
  if (!m) return m;
  const label = swap(m.label, NAV_MODULE_KEYS[m.key], t);
  return (label === m.label ? m : { ...m, label }) as M;
}

/** The doors of a nav shape with their names in the app language. */
export function localizeShape(shape: NavShape, t: Translate): NavShape {
  const door = <D extends { key: DoorKey; label: string }>(d: D): D => {
    const label = swap(d.label, NAV_DOOR_KEYS[d.key], t);
    return label === d.label ? d : { ...d, label };
  };
  return {
    ...shape,
    doors: shape.doors.map(door),
    ...(shape.folded ? { folded: { ...shape.folded, doors: shape.folded.doors.map(door) } } : {}),
  };
}

/** "Home" in the app language. */
export function homeLabel(t: Translate): string {
  return swap(DASHBOARD_NAV.label, 'nav.home', t);
}
