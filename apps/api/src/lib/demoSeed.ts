/**
 * The demo tenant's pure parts: a seeded random source, the cast, the
 * stores and the day planner. `scripts/seed-demo.ts` turns these into rows;
 * nothing here touches the database, so it is unit-tested on any machine.
 *
 * Determinism: every choice comes from one `Rng` seeded with a constant, so
 * two runs on the same day produce the same people, shifts and ids. The
 * calendar is anchored on "today" (the org's date), so the demo never goes
 * stale: history always ends yesterday and the future always starts now.
 */

// ---------------------------------------------------------------------------
// Random source
// ---------------------------------------------------------------------------

/** mulberry32: a small, fast, well-distributed 32-bit PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  /** [0, 1) */
  float(): number {
    return this.next();
  }
  /** Inclusive integer range. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) throw new Error('pick from an empty list');
    return arr[Math.floor(this.next() * arr.length)]!;
  }
  shuffle<T>(arr: readonly T[]): T[] {
    const out = [...arr];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }
  /** A version-4 shaped UUID drawn from this source, so ids are reproducible. */
  uuid(): string {
    const b = new Uint8Array(16);
    for (let i = 0; i < 16; i++) b[i] = Math.floor(this.next() * 256);
    b[6] = (b[6]! & 0x0f) | 0x40;
    b[8] = (b[8]! & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
}

// ---------------------------------------------------------------------------
// Calendar (YYYY-MM-DD keys; no instants here — the script maps keys to the
// store's clock with the shared timezone helpers)
// ---------------------------------------------------------------------------

/** Calendar-day arithmetic on a key (not +24h) so DST days keep their boundaries. */
export function addDaysToKey(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday, for a day key. */
export function weekdayOfKey(key: string): number {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
}

/** `count` consecutive day keys starting at `fromKey`. */
export function dayKeys(fromKey: string, count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(addDaysToKey(fromKey, i));
  return out;
}

/** Days from a to b (b - a), on keys. */
export function daysBetweenKeys(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by!, bm! - 1, bd!) - Date.UTC(ay!, am! - 1, ad!)) / 86_400_000);
}

// ---------------------------------------------------------------------------
// The cast
// ---------------------------------------------------------------------------

export type DemoLang = 'en' | 'es' | 'tr';
export interface CastMember {
  first: string;
  last: string;
  lang: DemoLang;
}

const EN: ReadonlyArray<[string, string]> = [
  ['Jordan', 'Whitfield'], ['Alicia', 'Brooks'], ['Marcus', 'Hale'], ['Tamika', 'Jefferson'],
  ['Caleb', 'Dawson'], ['Brianna', 'Shaw'], ['Devin', 'Carter'], ['Hannah', 'Pruitt'],
  ['Terrence', 'Oliver'], ['Kayla', 'Monroe'], ['Ethan', 'Rourke'], ['Destiny', 'Franklin'],
  ['Logan', 'Pierce'], ['Sierra', 'Blackwood'], ['Malik', 'Thompson'], ['Chloe', 'Hendricks'],
  ['Isaiah', 'Bennett'], ['Morgan', 'Castillo'], ['Trevor', 'Lind'], ['Jasmine', 'Royal'],
  ['Colby', 'Watts'], ['Naomi', 'Fletcher'], ['Darius', 'Quinn'], ['Paige', 'Sutherland'],
  ['Andre', 'Mitchell'], ['Lauren', 'Gibbs'], ['Wesley', 'Harmon'], ['Brooke', 'Tanner'],
  ['Xavier', 'Doyle'], ['Megan', 'Alcott'], ['Kendrick', 'Boone'], ['Olivia', 'Marsh'],
  ['Tyrell', 'Jackson'], ['Savannah', 'Keene'], ['Grant', 'Pollard'], ['Erica', 'Vance'],
  ['Dominic', 'Rhodes'], ['Allison', 'Perry'], ['Jamal', 'Foster'], ['Heather', 'Nolan'],
];
const ES: ReadonlyArray<[string, string]> = [
  ['Luis', 'Hernández'], ['Valentina', 'Cruz'], ['Diego', 'Ramírez'], ['Camila', 'Ortega'],
  ['Mateo', 'Delgado'], ['Sofía', 'Navarro'], ['Andrés', 'Villalobos'], ['Lucía', 'Paredes'],
  ['Santiago', 'Ibarra'], ['Daniela', 'Fuentes'], ['Javier', 'Montoya'], ['Isabela', 'Reyes'],
  ['Emilio', 'Castañeda'], ['Renata', 'Salazar'], ['Gabriel', 'Ocampo'], ['Ximena', 'Arroyo'],
  ['Rafael', 'Zúñiga'], ['Paola', 'Medina'],
];
const TR: ReadonlyArray<[string, string]> = [
  ['Emre', 'Yılmaz'], ['Elif', 'Kaya'], ['Burak', 'Demir'], ['Zeynep', 'Şahin'],
  ['Mert', 'Çelik'], ['Selin', 'Aydın'], ['Can', 'Öztürk'],
];

/** 65 people: 40 English, 18 Spanish, 7 Turkish speakers, interleaved so every store mixes. */
export const DEMO_CAST: readonly CastMember[] = (() => {
  const en = EN.map(([first, last]) => ({ first, last, lang: 'en' as const }));
  const es = ES.map(([first, last]) => ({ first, last, lang: 'es' as const }));
  const tr = TR.map(([first, last]) => ({ first, last, lang: 'tr' as const }));
  const out: CastMember[] = [];
  let i = 0;
  let j = 0;
  let k = 0;
  while (i < en.length || j < es.length || k < tr.length) {
    if (i < en.length) out.push(en[i++]!);
    if (i < en.length) out.push(en[i++]!);
    if (j < es.length) out.push(es[j++]!);
    if (k < tr.length && (j + i) % 3 === 0) out.push(tr[k++]!);
  }
  return out;
})();

/** ASCII for an email local part: `Sofía Navarro` → `sofia.navarro`. */
export function emailLocal(first: string, last: string): string {
  const fold = (s: string) =>
    s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/ı/g, 'i')
      .replace(/İ/g, 'i')
      .replace(/ş/gi, 's')
      .replace(/ç/gi, 'c')
      .replace(/ğ/gi, 'g')
      .replace(/ö/gi, 'o')
      .replace(/ü/gi, 'u')
      .toLowerCase()
      .replace(/[^a-z]/g, '');
  return `${fold(first)}.${fold(last)}`;
}

export const DEMO_EMAIL_DOMAIN = 'demo.altohr.example';

// ---------------------------------------------------------------------------
// Stores and crews
// ---------------------------------------------------------------------------

export type WindowLabel = 'Morning' | 'Afternoon' | 'Overnight';
export interface WindowSpec {
  label: WindowLabel;
  /** Minutes after the store's local midnight. An end before the start crosses midnight. */
  startMinute: number;
  endMinute: number;
  /** How many the contract asks for on the floor in this window. */
  target: number;
  /** Positions the crew in this window holds (the lead is added separately). */
  positions: readonly string[];
  /** Where in the store the shift card says they work. */
  areas: readonly string[];
}

export interface StoreSpec {
  key: string;
  clientKey: 'coastal' | 'seaside' | 'gulf';
  name: string;
  /** The base seed already created this store; find, never create. */
  existing?: boolean;
  addressLine1: string;
  city: string;
  state: string;
  zip: string;
  timezone: string;
  /** Crew size, the lead included. */
  crew: number;
  windows: readonly WindowSpec[];
}

const MORNING: WindowSpec = {
  label: 'Morning',
  startMinute: 6 * 60,
  endMinute: 14 * 60,
  target: 8,
  positions: ['Stocker', 'Cashier', 'Deli associate', 'Produce associate'],
  areas: ['Receiving', 'Front end', 'Deli', 'Produce', 'GM floor'],
};
const AFTERNOON: WindowSpec = {
  label: 'Afternoon',
  startMinute: 14 * 60,
  endMinute: 22 * 60,
  target: 8,
  positions: ['Cashier', 'GM floor associate', 'Deli associate'],
  areas: ['Front end', 'GM floor', 'Deli', 'Registers'],
};
const OVERNIGHT: WindowSpec = {
  label: 'Overnight',
  startMinute: 22 * 60,
  endMinute: 6 * 60,
  target: 6,
  positions: ['Overnight stocker'],
  areas: ['GM floor', 'Receiving', 'Grocery aisles'],
};
const small = (w: WindowSpec): WindowSpec => ({ ...w, target: 4 });

export const DEMO_CLIENTS = {
  coastal: { name: 'Coastal Resort Holdings', existing: true },
  seaside: { name: 'Seaside Hospitality Group', existing: true },
  gulf: { name: 'Gulf Coast Grocers', existing: false, industry: 'grocery', contactEmail: 'stores@gulfcoastgrocers.example' },
} as const;

export const DEMO_STORES: readonly StoreSpec[] = [
  {
    key: 'front-beach',
    clientKey: 'coastal',
    name: 'Front Beach 218',
    existing: true,
    addressLine1: '15495 Panama City Beach Pkwy',
    city: 'Panama City Beach',
    state: 'FL',
    zip: '32413',
    timezone: 'America/Chicago',
    crew: 28,
    windows: [MORNING, AFTERNOON, OVERNIGHT],
  },
  {
    key: 'thomas-drive',
    clientKey: 'coastal',
    name: 'Thomas Drive 412',
    addressLine1: '7209 Thomas Dr',
    city: 'Panama City Beach',
    state: 'FL',
    zip: '32408',
    timezone: 'America/Chicago',
    crew: 6,
    windows: [small(MORNING)],
  },
  {
    key: 'destin-harbor',
    clientKey: 'coastal',
    name: 'Destin Harbor 507',
    addressLine1: '10 Harbor Blvd',
    city: 'Destin',
    state: 'FL',
    zip: '32541',
    timezone: 'America/Chicago',
    crew: 6,
    windows: [small(MORNING)],
  },
  {
    key: 'okaloosa',
    clientKey: 'coastal',
    name: 'Okaloosa Island 133',
    addressLine1: '1450 Miracle Strip Pkwy SE',
    city: 'Fort Walton Beach',
    state: 'FL',
    zip: '32548',
    timezone: 'America/Chicago',
    crew: 5,
    windows: [small(MORNING)],
  },
  {
    key: 'pensacola',
    clientKey: 'seaside',
    name: 'Seaside Grand · Pensacola Beach',
    addressLine1: '2 Via de Luna Dr',
    city: 'Pensacola Beach',
    state: 'FL',
    zip: '32561',
    timezone: 'America/Chicago',
    crew: 5,
    windows: [small(AFTERNOON)],
  },
  {
    key: 'tallahassee',
    clientKey: 'seaside',
    name: 'Seaside Grand · Tallahassee',
    addressLine1: '101 S Monroe St',
    city: 'Tallahassee',
    state: 'FL',
    zip: '32301',
    timezone: 'America/New_York',
    crew: 5,
    windows: [small(MORNING)],
  },
  {
    key: 'gulf-23rd',
    clientKey: 'gulf',
    name: 'Gulf Coast Grocers · 23rd Street',
    addressLine1: '2300 W 23rd St',
    city: 'Panama City',
    state: 'FL',
    zip: '32405',
    timezone: 'America/Chicago',
    crew: 5,
    windows: [small(MORNING)],
  },
];

export const DEMO_CREW_TOTAL = DEMO_STORES.reduce((a, s) => a + s.crew, 0);

/** The org's standard pay and the SOW bill rates, by position. */
export const LEAD_POSITION = 'Shift Lead';
export const PAY_RATE = { associate: 15, lead: 18 } as const;
export const BILL_RATE = { associate: 21.21, lead: 24.24 } as const;

export interface CrewMember {
  /** Index into DEMO_CAST. */
  castIndex: number;
  storeKey: string;
  window: WindowLabel;
  position: string;
  isLead: boolean;
  /** Two weekdays (0–6) the person never works. */
  offDays: readonly [number, number];
}

/**
 * Deal the cast into crews: store by store, the first member is the lead
 * (who works the store's first window), the rest spread across the store's
 * windows in proportion to their targets. Off-days rotate so every day of the
 * week has roughly the same people available.
 */
export function dealCrews(rng: Rng): CrewMember[] {
  const out: CrewMember[] = [];
  let cursor = 0;
  for (const store of DEMO_STORES) {
    const totalTarget = store.windows.reduce((a, w) => a + w.target, 0);
    // Crew per window, proportional to the window's target; the remainder
    // goes to the first window.
    const perWindow = store.windows.map((w) => Math.floor(((store.crew - 1) * w.target) / totalTarget));
    perWindow[0]! += store.crew - 1 - perWindow.reduce((a, n) => a + n, 0);
    let member = 0;
    for (let wi = 0; wi < store.windows.length; wi++) {
      const w = store.windows[wi]!;
      const count = perWindow[wi]! + (wi === 0 ? 1 : 0);
      for (let n = 0; n < count; n++) {
        const isLead = wi === 0 && n === 0;
        const off1 = (member * 3) % 7;
        const off2 = (off1 + 1 + (member % 2)) % 7;
        out.push({
          castIndex: cursor++,
          storeKey: store.key,
          window: w.label,
          position: isLead ? LEAD_POSITION : w.positions[n % w.positions.length]!,
          isLead,
          offDays: [off1, off2 === off1 ? (off1 + 2) % 7 : off2],
        });
        member++;
      }
    }
  }
  // A light shuffle of positions within a window keeps the pattern from
  // reading as a table, while the window and store stay put.
  void rng;
  return out;
}

/**
 * Who is on the floor in a window on a day: the window's crew minus the ones
 * off that weekday, rotated by the day so the same person is not always the
 * first to be cut, cut to the window's target. Short days (fewer available
 * than the target) are the realism — a store is sometimes one short.
 */
export function planDay(
  crew: readonly CrewMember[],
  window: WindowSpec,
  dayIndex: number,
  weekday: number,
): CrewMember[] {
  const available = crew.filter((m) => m.window === window.label && !m.offDays.includes(weekday));
  if (available.length === 0) return [];
  const start = dayIndex % available.length;
  const rotated = [...available.slice(start), ...available.slice(0, start)];
  return rotated.slice(0, window.target);
}

/**
 * The rhythm of a punched shift: how late the clock-in is, how early the
 * clock-out, and whether the person never came. Percentages are per shift.
 */
export interface Attendance {
  noShow: boolean;
  lateMinutes: number;
  earlyOutMinutes: number;
}
export function drawAttendance(rng: Rng): Attendance {
  if (rng.chance(0.025)) return { noShow: true, lateMinutes: 0, earlyOutMinutes: 0 };
  const late = rng.chance(0.08) ? rng.int(6, 25) : rng.int(-4, 3);
  const early = rng.chance(0.03) ? rng.int(20, 40) : rng.int(-6, 2);
  return { noShow: false, lateMinutes: late, earlyOutMinutes: early };
}
