/**
 * Demo data for the analytics figures — Recruiting → Analytics ("How
 * candidates move"), Labor costs ("Where the money goes") and the call-outs
 * desk ("The year in call-outs", also on the Workforce home). The base seed
 * leaves all three nearly empty: no candidates, two call-outs a year, a
 * handful of shifts in two positions.
 *
 *   npm -w apps/api run db:seed:analytics                after db:seed and scripts/seed-demo-shifts.ts
 *   npm -w apps/api run db:seed:analytics -- --replace   drop this script's rows, then seed again from now
 *
 * Everything is in the default tenant (tenantId on every row) and relative to
 * now, so each page's default range shows it:
 *
 * - A crew at the demo stores (the client stores the base seed and
 *   seed-demo-shifts made): veterans hired over a year ago, plus everyone
 *   recruiting hired. Each is a PERSON worker with an assignment to a store.
 * - A year of the crew's shifts that have ENDED, left as the app leaves them:
 *   worked shifts COMPLETED with the punch (and its meal break) at the
 *   shift's pay rate, approved after two days; late arrivals with their LATE
 *   event; no-call no-shows still ASSIGNED, stamped by the sweep, with their
 *   event; confirmed call-outs — the shift released to Open (lib/coverShift),
 *   then covered by a teammate or left open — with their CALL_OUT event and
 *   cover steps. Summer weekends and holidays run busier and call out more.
 * - About ten months of recruiting: postings at those stores, candidates
 *   whose journeys are written the way the recruiting routes write them
 *   (Candidate.stage, plus CREATED / STAGE_CHANGED / OFFER_* / HIRED events
 *   with fromStage, toStage and their times), offers, the quiet-candidate
 *   sweep's automatic withdrawals, and monthly spend per source. The hires
 *   are the crew's newer members.
 *
 * Never a shift that hasn't ended — nothing in progress, nothing ahead — so
 * no sweep (no-show, auto clock-out, reminders, cover) acts on these rows and
 * the schedule from now on is untouched. On the first day of a pay period
 * the period-to-date therefore holds only what has already ended today.
 *
 * Deterministic: one seeded random source for the content and another for
 * the ids, so a fresh database seeded at the same moment gets the same rows.
 *
 * Idempotent: every id this script writes starts with ID_PREFIX. A re-run
 * finds them and does nothing. --replace deletes exactly those rows (one
 * transaction: if something the app made since depends on them — a payroll
 * run that paid the crew, say — the delete is refused and nothing changes),
 * then seeds again. What the app derived from the crew in the meantime (a
 * retirement election, say) goes with them, as when a person is deleted; no
 * other row is changed or deleted.
 */

import { Prisma, PrismaClient, type CallOutChannel, type CallOutReason, type CandidateStage, type OfferStatus } from '@prisma/client';
import { Rng, addDaysToKey, weekdayOfKey } from '../src/lib/demoSeed.js';

const prisma = new PrismaClient();

/** Alto HR, the default tenant (lib/tenant.ts). */
const TENANT = '00000000-0000-4000-8000-000000000001';
/** Every id this script writes: "da7a5eed-a11a-4…". Nothing else in the database starts this way. */
const ID_PREFIX = 'da7a5eed-a11a-4';
/** Picked (from a sweep of seeds) so the default 90 days show every kind of exit and someone still open at every step. */
const SEED = 20261059;
/** The cast's addresses read like the rest of the demo's people (first.last@example.com). */
const EMAIL_DOMAIN = 'example.com';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const HISTORY_DAYS = 365;
const CHUNK = 1_000;

/** Mirrors of app constants (kept here so the script loads no app module that opens the database). */
const POINTS = { LATE: 0.5, CALL_OUT: 1.0, NO_CALL_NO_SHOW: 2.0 } as const; // lib/attendance ATTENDANCE_POINTS
const LATE_GRACE_MIN = 7; // lib/attendance LATE_GRACE_MS
const LATE_CALL_OUT_MINUTES = 120; // lib/callOuts
const QUIET_AFTER_DAYS = 30; // lib/recruitingCleanup
const AUTO_CLOSE_REASON = `No response for ${QUIET_AFTER_DAYS} days — closed automatically`; // lib/recruitingCleanup

const args = new Set(process.argv.slice(2));
const REPLACE = args.has('--replace');

if (process.env.NODE_ENV === 'production') {
  console.error('[seed-demo-analytics] refusing to run with NODE_ENV=production: this is demo data for a dev, CI or demo database.');
  process.exit(2);
}

const content = new Rng(SEED);
const ids = new Rng(SEED + 1);

/** A version-4 shaped id carrying the script's prefix. */
function rid(): string {
  const hex = ids.uuid().replace(/-/g, '');
  // 32 hex: keep the variant nibble (index 16) the Rng set; the prefix takes the first 13.
  const tail = hex.slice(13);
  const h = (ID_PREFIX.replace(/-/g, '') + tail).slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ---------------------------------------------------------------------------
// Time: store-local wall clock ⇄ instants
// ---------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, '0');
const formats = new Map<string, Intl.DateTimeFormat>();
function wallParts(d: Date, tz: string) {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    formats.set(tz, f);
  }
  const o: Record<string, number> = {};
  for (const p of f.formatToParts(d)) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return o as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}
/** YYYY-MM-DD of an instant on a zone's calendar. */
function keyIn(d: Date, tz: string): string {
  const p = wallParts(d, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}
function offsetMs(d: Date, tz: string): number {
  const p = wallParts(d, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(d.getTime() / 1000) * 1000;
}
/** The instant a zone's wall clock reads `minute` minutes after midnight on `key` (DST-correct). */
function wallToUtc(key: string, minute: number, tz: string): Date {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d, 0, minute);
  let t = guess - offsetMs(new Date(guess), tz);
  t = guess - offsetMs(new Date(t), tz);
  return new Date(t);
}
/** A @db.Date value for a YYYY-MM-DD. */
const dateOf = (key: string) => new Date(`${key}T00:00:00.000Z`);
/** What a @db.Date column keeps of an instant: its UTC date (as the app's occurredOn = shift.startsAt). */
const utcDateOf = (d: Date) => dateOf(d.toISOString().slice(0, 10));
const plus = (d: Date, minutes: number) => new Date(d.getTime() + minutes * MIN);
const earliest = (...ds: Date[]) => new Date(Math.min(...ds.map((d) => d.getTime())));

// ---------------------------------------------------------------------------
// The calendar: summer, spring break, holidays
// ---------------------------------------------------------------------------

/** The n-th (1-based; -1 = last) given weekday of a month, as YYYY-MM-DD. */
function nthWeekday(year: number, month: number, weekday: number, n: number): string {
  if (n > 0) {
    const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    const day = 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
    return `${year}-${pad(month)}-${pad(day)}`;
  }
  const lastDay = new Date(Date.UTC(year, month, 0));
  const back = (lastDay.getUTCDay() - weekday + 7) % 7;
  return `${year}-${pad(month)}-${pad(lastDay.getUTCDate() - back)}`;
}
/** Easter Sunday (anonymous Gregorian algorithm). */
function easter(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${pad(month)}-${pad(day)}`;
}

interface DayInfo {
  /** Call-out pull of the day: 0 on an ordinary day. */
  holiday: number;
  /** A holiday the beach fills up for: the store runs one more per window. */
  busyHoliday: boolean;
  /** A holiday the store runs lighter on. */
  quietHoliday: boolean;
  summer: boolean;
  springBreak: boolean;
}

const holidayCache = new Map<number, Map<string, { pull: number; busy?: boolean; quiet?: boolean }>>();
function holidaysOf(year: number) {
  let m = holidayCache.get(year);
  if (m) return m;
  m = new Map();
  const memorial = nthWeekday(year, 5, 1, -1);
  const labor = nthWeekday(year, 9, 1, 1);
  const thanksgiving = nthWeekday(year, 11, 4, 4);
  const superBowl = nthWeekday(year, 2, 0, 2);
  const set = (key: string, pull: number, flags: { busy?: boolean; quiet?: boolean } = {}) => m!.set(key, { pull, ...flags });
  set(`${year}-01-01`, 0.28, { quiet: true });
  set(nthWeekday(year, 1, 1, 3), 0.05); // MLK Day
  set(addDaysToKey(superBowl, 1), 0.1); // the Monday after the Super Bowl
  set(easter(year), 0.1, { quiet: true });
  set(addDaysToKey(memorial, -2), 0.1, { busy: true });
  set(addDaysToKey(memorial, -1), 0.1, { busy: true });
  set(memorial, 0.25, { busy: true });
  set(`${year}-07-03`, 0.1, { busy: true });
  set(`${year}-07-04`, 0.42, { busy: true });
  set(`${year}-07-05`, 0.14, { busy: true });
  set(addDaysToKey(labor, -2), 0.09, { busy: true });
  set(addDaysToKey(labor, -1), 0.09, { busy: true });
  set(labor, 0.22, { busy: true });
  set(`${year}-10-31`, 0.06);
  set(thanksgiving, 0.25, { quiet: true });
  set(addDaysToKey(thanksgiving, 1), 0.14, { busy: true });
  set(`${year}-12-24`, 0.22);
  set(`${year}-12-25`, 0.32, { quiet: true });
  set(`${year}-12-26`, 0.08);
  set(`${year}-12-31`, 0.2);
  holidayCache.set(year, m);
  return m;
}

function dayInfo(key: string): DayInfo {
  const year = Number(key.slice(0, 4));
  const h = holidaysOf(year).get(key);
  // Summer on the Gulf: Memorial Day weekend through Labor Day.
  const summer = key >= addDaysToKey(nthWeekday(year, 5, 1, -1), -2) && key <= nthWeekday(year, 9, 1, 1);
  const md = key.slice(5);
  const springBreak = md >= '03-07' && md <= '04-05';
  return { holiday: h?.pull ?? 0, busyHoliday: !!h?.busy, quietHoliday: !!h?.quiet, summer, springBreak };
}

// ---------------------------------------------------------------------------
// Stores, windows, positions
// ---------------------------------------------------------------------------

type WindowLabel = 'Morning' | 'Afternoon' | 'Overnight';
const WINDOW_START: Record<WindowLabel, number> = { Morning: 6 * 60, Afternoon: 14 * 60, Overnight: 22 * 60 };
const SHIFT_MINUTES = 8 * 60;

/** Pay and bill per hour by position; every rate at or above Florida's minimum wage. */
const RATES: Record<string, { pay: number; bill: number; area: string[] }> = {
  'Shift Lead': { pay: 18, bill: 24.24, area: ['Front end', 'GM floor'] },
  'Overnight stocker': { pay: 17, bill: 23.8, area: ['Grocery aisles', 'Receiving'] },
  'Deli associate': { pay: 16, bill: 22.4, area: ['Deli'] },
  Stocker: { pay: 15.5, bill: 21.7, area: ['Receiving', 'Grocery aisles'] },
  'Produce associate': { pay: 15.5, bill: 21.7, area: ['Produce'] },
  Cashier: { pay: 15, bill: 21.21, area: ['Front end', 'Registers'] },
  'GM floor associate': { pay: 15, bill: 21.21, area: ['GM floor'] },
};
const LEAD = 'Shift Lead';

interface WindowPlan {
  label: WindowLabel;
  /** People on the floor on an ordinary day (the lead included). */
  base: number;
}
interface StoreShape {
  windows: WindowPlan[];
  /** The veterans: [first, last, window, position]. The first Morning one is the store's lead. */
  veterans: Array<[string, string, WindowLabel, string]>;
}

/** The main store (the portal client's), then the second, then a third if the database has one. */
const SHAPES: StoreShape[] = [
  {
    windows: [
      { label: 'Morning', base: 4 },
      { label: 'Afternoon', base: 3 },
      { label: 'Overnight', base: 2 },
    ],
    veterans: [
      ['Denise', 'Whitaker', 'Morning', LEAD],
      ['Carlos', 'Mendoza', 'Morning', 'Stocker'],
      ['Tamika', 'Freeman', 'Morning', 'Cashier'],
      ['Jean-Baptiste', 'Pierre', 'Morning', 'Produce associate'],
      ['Hannah', 'Kowalski', 'Morning', 'Deli associate'],
      ['Luis', 'Ortega', 'Afternoon', 'Cashier'],
      ['Brianna', 'Hayes', 'Afternoon', 'GM floor associate'],
      ['Mehmet', 'Yılmaz', 'Afternoon', 'Deli associate'],
      ['Kayla', 'Robinson', 'Afternoon', 'Cashier'],
      ['Marcus', 'Bell', 'Overnight', 'Overnight stocker'],
      ['Oleksandr', 'Bondar', 'Overnight', 'Overnight stocker'],
    ],
  },
  {
    windows: [
      { label: 'Morning', base: 3 },
      { label: 'Afternoon', base: 2 },
    ],
    veterans: [
      ['Yolanda', 'Castillo', 'Morning', LEAD],
      ['Andre', 'Baptiste', 'Morning', 'Stocker'],
      ['Sofia', 'Ramírez', 'Morning', 'Cashier'],
      ['Darnell', 'Price', 'Afternoon', 'GM floor associate'],
      ['Valentina', 'Cruz', 'Afternoon', 'Cashier'],
      ['Kevin', 'Tran', 'Afternoon', 'GM floor associate'],
    ],
  },
  {
    windows: [{ label: 'Morning', base: 2 }],
    veterans: [
      ['Gloria', 'Pratt', 'Morning', LEAD],
      ['Ibrahim', 'Sesay', 'Morning', 'Cashier'],
      ['Lena', 'Hoffman', 'Morning', 'Stocker'],
    ],
  },
];

/** Which window a hire for a posting's position works. */
const HIRE_WINDOW: Record<string, WindowLabel[]> = {
  Cashier: ['Morning', 'Afternoon'],
  Stocker: ['Morning'],
  'Deli associate': ['Morning', 'Afternoon'],
  'Produce associate': ['Morning'],
  'GM floor associate': ['Afternoon'],
  'Overnight stocker': ['Overnight'],
};

interface Store {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
  clientId: string;
  clientName: string;
  tz: string;
  shape: StoreShape;
  index: number;
}

interface Member {
  id: string;
  workerId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  store: Store;
  window: WindowLabel;
  position: string;
  isLead: boolean;
  offDays: [number, number];
  /** First day on the floor (store calendar). */
  startKey: string;
  /** Last day on the floor, or null. */
  endKey: string | null;
  separatedAt: Date | null;
  hiredByRecruiting: boolean;
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

const FIRST = ['Aaliyah', 'Adrian', 'Aisha', 'Alejandro', 'Amara', 'Andrea', 'Ayşe', 'Bianca', 'Brandon', 'Camila', 'Caleb', 'Chloe', 'Daniel', 'Destiny', 'Diego', 'Elif', 'Emmanuel', 'Esther', 'Fabiola', 'Gabriel', 'Grace', 'Héctor', 'Imani', 'Isaiah', 'Jasmine', 'Javier', 'Jordan', 'Josué', 'Kendra', 'Kofi', 'Leah', 'Lucía', 'Malik', 'Mariana', 'Mateo', 'Mia', 'Nadia', 'Naomi', 'Nikolai', 'Olivia', 'Omar', 'Paola', 'Quentin', 'Rafael', 'Renee', 'Rosa', 'Samuel', 'Sasha', 'Selin', 'Tyler', 'Valeria', 'Wesley', 'Ximena', 'Yusuf', 'Zoe'];
const LAST = ['Acosta', 'Adeyemi', 'Alvarez', 'Bennett', 'Boyd', 'Castro', 'Charles', 'Coleman', 'Delgado', 'Demir', 'Dixon', 'Estrada', 'Fields', 'Flores', 'Fontaine', 'Garrett', 'Gómez', 'Greene', 'Hamilton', 'Herrera', 'Jean', 'Jenkins', 'Kaya', 'Kovalenko', 'Lambert', 'Lewis', 'Lozano', 'Marshall', 'Medina', 'Molina', 'Morales', 'Nguyen', 'Okafor', 'Owens', 'Palmer', 'Petrenko', 'Quinn', 'Reyes', 'Rivers', 'Salazar', 'Santos', 'Simmons', 'Soto', 'Stewart', 'Thompson', 'Toussaint', 'Vargas', 'Walker', 'Washington', 'Young'];

const usedEmails = new Set<string>();
function emailFor(first: string, last: string): string {
  const clean = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ı/g, 'i').toLowerCase().replace(/[^a-z]/g, '');
  const base = `${clean(first)}.${clean(last)}`;
  let email = `${base}@${EMAIL_DOMAIN}`;
  for (let n = 2; usedEmails.has(email); n++) email = `${base}${n}@${EMAIL_DOMAIN}`;
  usedEmails.add(email);
  return email;
}
let phoneSeq = 0;
/** Fictional 555 numbers, none shared with the base seed's people. */
const nextPhone = () => `+1-850-555-${String(3100 + phoneSeq++).padStart(4, '0')}`;

// ---------------------------------------------------------------------------
// Recruiting
// ---------------------------------------------------------------------------

interface PostingSpec {
  key: string;
  storeIndex: number;
  title: string;
  schedule: 'FULL_TIME' | 'PART_TIME' | 'SEASONAL';
  /** Days before now it opened. */
  openedDaysAgo: number;
  /** Days it takes applications for; null = still open today. */
  windowDays: number | null;
  openings: number;
  applicants: number;
}

const POSTINGS: PostingSpec[] = [
  { key: 'cashier-a', storeIndex: 0, title: 'Cashier', schedule: 'FULL_TIME', openedDaysAgo: 292, windowDays: 80, openings: 2, applicants: 10 },
  { key: 'stocker-a', storeIndex: 0, title: 'Stocker', schedule: 'SEASONAL', openedDaysAgo: 236, windowDays: 70, openings: 3, applicants: 13 },
  { key: 'cashier-b', storeIndex: 1, title: 'Cashier', schedule: 'PART_TIME', openedDaysAgo: 214, windowDays: 65, openings: 2, applicants: 11 },
  { key: 'deli-a', storeIndex: 0, title: 'Deli associate', schedule: 'FULL_TIME', openedDaysAgo: 176, windowDays: 60, openings: 2, applicants: 12 },
  { key: 'overnight-a', storeIndex: 0, title: 'Overnight stocker', schedule: 'FULL_TIME', openedDaysAgo: 112, windowDays: 82, openings: 1, applicants: 13 },
  { key: 'gm-b', storeIndex: 1, title: 'GM floor associate', schedule: 'PART_TIME', openedDaysAgo: 68, windowDays: null, openings: 4, applicants: 18 },
  { key: 'cashier-holiday', storeIndex: 0, title: 'Cashier', schedule: 'SEASONAL', openedDaysAgo: 33, windowDays: null, openings: 5, applicants: 22 },
];

const SOURCES: Array<[string, number]> = [
  ['Indeed', 0.34],
  ['careers-page', 0.2],
  ['Referral', 0.15],
  ['ZipRecruiter', 0.11],
  ['Walk-in', 0.1],
  ['Facebook', 0.1],
];

const REJECT_REASON: Record<string, string[]> = {
  APPLIED: ['Not available for the hours we need', 'Lives outside our commuting range', 'Applied twice — kept the newer application', 'No work authorization on file'],
  SCREENING: ['Availability does not match the schedule', 'Pay expectations above the range', 'Could not start within the month', 'Needs weekends off'],
  INTERVIEW: ['Another candidate was a closer fit', 'Not ready for a fast-paced floor', 'References did not check out'],
};
const WITHDRAW_REASON: Record<string, string[]> = {
  APPLIED: ['Took another job', 'Moving out of the area', 'Schedule no longer works'],
  SCREENING: ['Took another job', 'Going back to school', 'Schedule no longer works'],
  INTERVIEW: ['Did not come to the interview', 'Accepted another offer', 'Going back to school'],
};
const DECLINE_REASON = ['Accepted another offer', 'Pay lower than hoped', 'The hours did not work out'];
const FILLED_REASON = 'Position filled — application kept on file';

type JStage = 'APPLIED' | 'SCREENING' | 'INTERVIEW' | 'OFFER';
const NEXT: Record<JStage, CandidateStage> = { APPLIED: 'SCREENING', SCREENING: 'INTERVIEW', INTERVIEW: 'OFFER', OFFER: 'HIRED' };

interface Move {
  at: Date;
  from: CandidateStage;
  to: CandidateStage;
  body: string | null;
  automatic?: { lastActivity: Date };
  actor: 'recruiter' | 'admin' | null;
}
interface OfferPlan {
  createdAt: Date;
  sentAt: Date;
  expiresAt: Date;
  status: OfferStatus;
  decidedAt: Date | null;
  declineReason: string | null;
  startKey: string;
}
interface Journey {
  createdAt: Date;
  moves: Move[];
  offer: OfferPlan | null;
  stage: CandidateStage;
  hiredAt: Date | null;
}

/**
 * One candidate's journey, step by step, as recruiters and the quiet-
 * candidate sweep would have moved them. A step whose time is still ahead
 * leaves them open where they are — unless they have been quiet for
 * QUIET_AFTER_DAYS, in which case the sweep has already closed them.
 */
function journeyFrom(createdAt: Date, now: Date, storeTz: string): Journey {
  const moves: Move[] = [];
  let stage: JStage = 'APPLIED';
  let since = createdAt;
  let offer: OfferPlan | null = null;
  const actor = (): 'recruiter' | 'admin' => (content.chance(0.8) ? 'recruiter' : 'admin');
  // Office hours on the store's clock: 9:00–17:00, the day `d` falls on.
  const atOffice = (d: Date): Date => wallToUtc(keyIn(d, storeTz), 9 * 60 + content.int(0, 8 * 60), storeTz);
  const after = (from: Date, minDays: number, maxDays: number) => atOffice(new Date(from.getTime() + content.int(minDays, maxDays) * DAY));

  const close = (at: Date, to: 'REJECTED' | 'WITHDRAWN', body: string, auto = false): Journey => {
    moves.push({ at, from: stage, to, body, actor: auto ? null : actor(), ...(auto ? { automatic: { lastActivity: since } } : {}) });
    return { createdAt, moves, offer, stage: to, hiredAt: null };
  };
  const stay = (): Journey => {
    // Ahead of now: open where they are — or closed by the sweep if quiet that long.
    const due = new Date(since.getTime() + QUIET_AFTER_DAYS * DAY);
    if (due <= now && !(stage === 'OFFER' && offer && offer.expiresAt > now)) {
      return close(plus(due, content.int(5, 55)), 'WITHDRAWN', AUTO_CLOSE_REASON, true);
    }
    return { createdAt, moves, offer, stage, hiredAt: null };
  };

  for (;;) {
    const r = content.float();
    if (stage === 'OFFER') {
      // The offer went out with the move to Offer.
      const o = offer!;
      if (r < 0.16) {
        const at = after(o.sentAt, 1, 5);
        if (at > now) return stay();
        o.status = 'DECLINED';
        o.decidedAt = at;
        o.declineReason = content.pick(DECLINE_REASON);
        return close(plus(at, content.int(10, 240)), 'WITHDRAWN', o.declineReason);
      }
      if (r < 0.22) {
        if (o.expiresAt > now) return stay();
        o.status = 'EXPIRED';
        o.decidedAt = o.expiresAt;
        const at = after(o.expiresAt, 1, 3);
        if (at > now) return { createdAt, moves, offer, stage, hiredAt: null };
        return close(at, 'WITHDRAWN', 'Offer expired');
      }
      const accepted = plus(o.sentAt, content.int(6 * 60, 4 * 24 * 60));
      const hiredAt = new Date(Math.max(after(accepted, 0, 2).getTime(), plus(accepted, content.int(30, 180)).getTime()));
      if (hiredAt > now || accepted > now) return stay();
      o.status = 'ACCEPTED';
      o.decidedAt = accepted;
      // They start a few days after the hire.
      o.startKey = keyIn(new Date(hiredAt.getTime() + content.int(3, 7) * DAY), storeTz);
      moves.push({ at: hiredAt, from: 'OFFER', to: 'HIRED', body: 'Invited to onboarding', actor: actor() });
      return { createdAt, moves, offer, stage: 'HIRED', hiredAt };
    }

    const odds = { APPLIED: [0.3, 0.1, 0.05], SCREENING: [0.28, 0.08, 0.06], INTERVIEW: [0.3, 0, 0.1] }[stage];
    const [reject, quiet, withdraw] = odds as [number, number, number];
    if (r < reject) {
      const at = after(since, 2, stage === 'APPLIED' ? 9 : 8);
      if (at > now) return stay();
      return close(at, 'REJECTED', content.pick(REJECT_REASON[stage]!));
    }
    if (r < reject + quiet) {
      const due = new Date(since.getTime() + QUIET_AFTER_DAYS * DAY);
      if (due > now) return { createdAt, moves, offer, stage, hiredAt: null };
      return close(plus(due, content.int(5, 55)), 'WITHDRAWN', AUTO_CLOSE_REASON, true);
    }
    if (r < reject + quiet + withdraw) {
      const at = after(since, 3, 12);
      if (at > now) return stay();
      return close(at, 'WITHDRAWN', content.pick(WITHDRAW_REASON[stage]!));
    }
    // Days in a stage before the next step: screening is the slow one.
    const at = after(since, stage === 'INTERVIEW' ? 2 : stage === 'APPLIED' ? 2 : 3, stage === 'APPLIED' ? 8 : stage === 'SCREENING' ? 9 : 6);
    if (at > now) return stay();
    const to = NEXT[stage];
    moves.push({ at, from: stage, to, body: null, actor: actor() });
    stage = to as JStage;
    since = at;
    if (stage === 'OFFER') {
      const sentAt = earliest(plus(at, content.int(20, 180)), now);
      offer = {
        createdAt: earliest(plus(at, content.int(5, 15)), sentAt),
        sentAt,
        // DEFAULT_OFFER_DAYS-style expiry: a week to sign.
        expiresAt: new Date(sentAt.getTime() + 7 * DAY),
        status: 'SENT',
        decidedAt: null,
        declineReason: null,
        startKey: keyIn(new Date(sentAt.getTime() + content.int(5, 9) * DAY), storeTz),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const counts: Record<string, number> = {};
const count = (k: string, n = 1) => (counts[k] = (counts[k] ?? 0) + n);

async function existingRows(): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM "Associate" WHERE id::text LIKE ${ID_PREFIX + '%'}`;
  return Number(rows[0]?.n ?? 0);
}

/** Every table this script writes, children first: what --replace deletes (by id prefix only). */
const OWN_TABLES = ['BreakEntry', 'AttendanceEvent', 'CallOut', 'TimeEntry', 'Shift', 'CandidateEvent', 'Offer', 'Candidate', 'JobPosting', 'RecruitingSourceSpend', 'AssociateAssignment', 'Worker', 'Associate'] as const;

async function deleteOwnRows(): Promise<Record<string, number>> {
  const like = `${ID_PREFIX}%`;
  const deleted: Record<string, number> = {};
  try {
    await prisma.$transaction(
      async (tx) => {
        for (const table of OWN_TABLES) {
          deleted[table] = await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE id::text LIKE $1`, like);
        }
      },
      { timeout: 120_000, maxWait: 20_000 },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[seed-demo-analytics] --replace refused: something the app made since depends on this script's rows (${msg.split('\n').slice(-1)[0]}). Nothing was deleted; restore a backup or reset the database to start over.`,
    );
  }
  return deleted;
}

async function main() {
  const already = await existingRows();
  if (already > 0 && !REPLACE) {
    console.log(`[seed-demo-analytics] already seeded (${already} demo crew); nothing to do. Pass --replace to seed again from now.`);
    return;
  }
  if (already > 0) {
    const deleted = await deleteOwnRows();
    console.log(`[seed-demo-analytics] --replace: deleted ${Object.entries(deleted).filter(([, n]) => n > 0).map(([t, n]) => `${n} ${t}`).join(', ')}`);
  }

  const now = new Date();
  // Addresses already taken (the base seed's people share the domain): a namesake gets a numbered one.
  for (const r of await prisma.associate.findMany({ where: { tenantId: TENANT }, select: { email: true } })) usedEmails.add(r.email.toLowerCase());
  for (const r of await prisma.candidate.findMany({ where: { tenantId: TENANT }, select: { email: true } })) usedEmails.add(r.email.toLowerCase());

  // ---- The people and places the base seed made ----------------------------
  const admin = await prisma.user.findUnique({ where: { email: 'admin@altohr.com' }, select: { id: true } });
  if (!admin) throw new Error('[seed-demo-analytics] run the dev seed first (npm -w apps/api run db:seed): admin@altohr.com is missing.');
  const userId = async (email: string) => (await prisma.user.findUnique({ where: { email }, select: { id: true } }))?.id ?? admin.id;
  const recruiter = await userId('recruiter@altohr.com');
  const workforce = await userId('workforce@altohr.com');
  const supervisor = await prisma.user.findUnique({ where: { email: 'dana.reyes@altohr.com' }, select: { id: true, clientId: true } });

  const sites = await prisma.site.findMany({
    where: { tenantId: TENANT, deletedAt: null, clientId: { not: null }, client: { deletedAt: null, status: 'ACTIVE' } },
    select: { id: true, name: true, city: true, state: true, timezone: true, clientId: true, client: { select: { name: true } } },
  });
  // The portal client's store first (the base seed's Front Beach 218), then by name.
  const ranked = sites
    .filter((s) => s.client && !/internal hires/i.test(s.client.name))
    .sort((a, b) => Number(b.name === 'Front Beach 218') - Number(a.name === 'Front Beach 218') || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  if (ranked.length === 0) throw new Error('[seed-demo-analytics] no client store to staff: run db:seed and scripts/seed-demo-shifts.ts first.');
  const stores: Store[] = ranked.slice(0, SHAPES.length).map((s, index) => ({
    id: s.id,
    name: s.name,
    city: s.city,
    state: s.state,
    clientId: s.clientId!,
    clientName: s.client!.name,
    tz: s.timezone || 'America/New_York',
    shape: SHAPES[index]!,
    index,
  }));
  const storeAt = (i: number) => stores[Math.min(i, stores.length - 1)]!;

  // ---- Recruiting: postings, candidates, journeys ---------------------------
  const nameQueue: Array<[string, string]> = [];
  {
    const veteranNames = new Set(SHAPES.flatMap((s) => s.veterans.map(([f, l]) => `${f} ${l}`)));
    const seen = new Set<string>();
    while (nameQueue.length < 140) {
      const f = content.pick(FIRST);
      const l = content.pick(LAST);
      const full = `${f} ${l}`;
      if (seen.has(full) || veteranNames.has(full)) continue;
      seen.add(full);
      nameQueue.push([f, l]);
    }
  }
  const pickSource = () => {
    let r = content.float();
    for (const [s, w] of SOURCES) {
      if ((r -= w) < 0) return s;
    }
    return SOURCES[0]![0];
  };

  interface PostingRow {
    spec: PostingSpec;
    id: string;
    store: Store;
    openedAt: Date;
    windowEnd: Date | null;
    closedAt: Date | null;
    status: 'OPEN' | 'CLOSED';
  }
  interface CandidateRow {
    id: string;
    first: string;
    last: string;
    email: string;
    phone: string;
    source: string;
    posting: PostingRow;
    journey: Journey;
    hire: Member | null;
  }

  const postings: PostingRow[] = POSTINGS.map((spec) => {
    const store = storeAt(spec.storeIndex);
    const openedAt = wallToUtc(keyIn(new Date(now.getTime() - spec.openedDaysAgo * DAY), store.tz), 9 * 60 + content.int(0, 120), store.tz);
    return { spec, id: rid(), store, openedAt, windowEnd: spec.windowDays === null ? null : new Date(openedAt.getTime() + spec.windowDays * DAY), closedAt: null, status: 'OPEN' };
  });

  const candidates: CandidateRow[] = [];
  for (const p of postings) {
    const span = ((p.windowEnd ?? now).getTime() - p.openedAt.getTime()) / DAY;
    const drafts: Array<{ createdAt: Date; source: string }> = [];
    for (let i = 0; i < p.spec.applicants; i++) {
      // Most apply in a closed posting's first weeks; an open one draws a steady stream.
      const dayOffset = Math.floor(span * Math.pow(content.float(), p.windowEnd ? 1.35 : 1));
      const key = keyIn(new Date(p.openedAt.getTime() + dayOffset * DAY), p.store.tz);
      const createdAt = wallToUtc(key, 7 * 60 + content.int(0, 15 * 60), p.store.tz);
      if (createdAt >= now || createdAt < p.openedAt) continue;
      drafts.push({ createdAt, source: pickSource() });
    }
    drafts.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    for (const d of drafts) {
      const [first, last] = nameQueue.shift()!;
      candidates.push({ id: rid(), first, last, email: emailFor(first, last), phone: nextPhone(), source: d.source, posting: p, journey: journeyFrom(d.createdAt, now, p.store.tz), hire: null });
    }
  }

  // A posting fills with its openings-th hire: whoever is still in its pipeline
  // then is let go ("Position filled"), and nobody applies to it after. One
  // whose window runs out unfilled stops taking applications; the people
  // already in its pipeline carry on.
  const dropped = new Set<string>();
  for (const p of postings) {
    const mine = candidates.filter((c) => c.posting === p);
    const hires = mine.filter((c) => c.journey.stage === 'HIRED').sort((a, b) => a.journey.hiredAt!.getTime() - b.journey.hiredAt!.getTime());
    const fillAt = hires.length >= p.spec.openings ? hires[p.spec.openings - 1]!.journey.hiredAt! : null;
    if (!fillAt) {
      if (p.windowEnd && p.windowEnd <= now) {
        p.closedAt = p.windowEnd;
        p.status = 'CLOSED';
      }
      continue;
    }
    p.closedAt = fillAt;
    p.status = 'CLOSED';
    const kept = new Set(hires.slice(0, p.spec.openings).map((c) => c.id));
    for (const c of mine) {
      if (kept.has(c.id)) continue;
      const j = c.journey;
      if (j.createdAt >= fillAt) {
        dropped.add(c.id);
        continue;
      }
      // What happened before the fill stands; the rest never did.
      const before = j.moves.filter((m) => m.at < fillAt);
      const last = before[before.length - 1];
      const stageAtFill: CandidateStage = last ? last.to : 'APPLIED';
      if (stageAtFill === 'REJECTED' || stageAtFill === 'WITHDRAWN') {
        j.moves = before;
        j.stage = stageAtFill;
        j.hiredAt = null;
        if (j.offer && j.offer.createdAt >= fillAt) j.offer = null;
        continue;
      }
      if (j.offer) {
        if (stageAtFill !== 'OFFER' || j.offer.createdAt >= fillAt) j.offer = null;
        else if (j.offer.decidedAt && j.offer.decidedAt >= fillAt) {
          j.offer.status = j.offer.expiresAt <= fillAt ? 'EXPIRED' : 'SENT';
          j.offer.decidedAt = j.offer.status === 'EXPIRED' ? j.offer.expiresAt : null;
          j.offer.declineReason = null;
        }
      }
      const at = plus(fillAt, content.int(60, 2 * 24 * 60));
      j.hiredAt = null;
      if (at > now) {
        // Not told yet: still open where they were.
        j.moves = before;
        j.stage = stageAtFill;
        continue;
      }
      j.moves = [...before, { at, from: stageAtFill, to: 'REJECTED', body: FILLED_REASON, actor: 'recruiter' }];
      j.stage = 'REJECTED';
      if (j.offer && j.offer.status === 'SENT') {
        j.offer.status = 'WITHDRAWN';
        j.offer.decidedAt = at;
      }
    }
  }
  const live = candidates.filter((c) => !dropped.has(c.id));

  // ---- The crew --------------------------------------------------------------
  const todayKey = keyIn(now, stores[0]!.tz);
  const members: Member[] = [];
  let memberSeq = 0;
  const offDaysFor = (): [number, number] => {
    const a = (memberSeq * 3 + content.int(0, 1)) % 7;
    const b = (a + 1 + (memberSeq % 3 === 0 ? 2 : 1)) % 7;
    memberSeq += 1;
    return [a, b];
  };
  for (const store of stores) {
    store.shape.veterans.forEach(([first, last, window, position], i) => {
      const hireKey = addDaysToKey(todayKey, -content.int(HISTORY_DAYS + 30, 1100));
      members.push({
        id: rid(),
        workerId: rid(),
        firstName: first,
        lastName: last,
        email: emailFor(first, last),
        phone: nextPhone(),
        store,
        window,
        position,
        isLead: i === 0 && position === LEAD,
        offDays: offDaysFor(),
        startKey: hireKey,
        endKey: null,
        separatedAt: null,
        hiredByRecruiting: false,
      });
    });
  }
  for (const c of live) {
    if (c.journey.stage !== 'HIRED') continue;
    const store = c.posting.store;
    const windows = HIRE_WINDOW[c.posting.spec.title] ?? ['Morning'];
    const window = windows.find((w) => store.shape.windows.some((sw) => sw.label === w)) ?? store.shape.windows[0]!.label;
    const startKey = c.journey.offer!.startKey;
    const member: Member = {
      id: rid(),
      workerId: rid(),
      firstName: c.first,
      lastName: c.last,
      email: c.email,
      phone: c.phone,
      store,
      window,
      position: c.posting.spec.title,
      isLead: false,
      offDays: offDaysFor(),
      startKey,
      endKey: null,
      separatedAt: null,
      hiredByRecruiting: true,
    };
    c.hire = member;
    members.push(member);
  }
  // Two of the recruiting hires have left: one inside their first 90 days
  // (what the retention card counts against), one months in.
  {
    const tenure = (m: Member) => Math.round((now.getTime() - dateOf(m.startKey).getTime()) / DAY);
    const hires = members.filter((m) => m.hiredByRecruiting).sort((a, b) => a.startKey.localeCompare(b.startKey));
    const leave = (m: Member | undefined, afterDays: number) => {
      if (!m) return;
      m.endKey = addDaysToKey(m.startKey, afterDays);
      m.separatedAt = wallToUtc(addDaysToKey(m.endKey, 1), 17 * 60, m.store.tz);
    };
    const settled = hires.filter((m) => tenure(m) >= 200);
    leave(settled[0], content.int(120, Math.max(121, tenure(settled[0] ?? hires[0]!) - 30)));
    leave(hires.filter((m) => tenure(m) >= 100 && m !== settled[0])[1], content.int(30, 75));
  }

  // ---- A year of shifts ------------------------------------------------------
  const shiftRows: Prisma.ShiftCreateManyInput[] = [];
  const entryRows: Prisma.TimeEntryCreateManyInput[] = [];
  const breakRows: Prisma.BreakEntryCreateManyInput[] = [];
  const eventRows: Prisma.AttendanceEventCreateManyInput[] = [];
  const callOutRows: Prisma.CallOutCreateManyInput[] = [];
  const approveBefore = new Date(now.getTime() - 2 * DAY);
  const approverFor = (store: Store) => (supervisor && supervisor.clientId === store.clientId && content.chance(0.65) ? supervisor.id : content.chance(0.5) ? workforce : admin.id);

  const onFloor = (m: Member, key: string) => key >= m.startKey && (m.endKey === null || key <= m.endKey);

  /** The punch for a shift someone worked (and its LATE event when it was late). */
  function work(shift: { id: string; startsAt: Date; endsAt: Date; payRate: number; store: Store }, m: Member, lateMinutes: number) {
    const clockInAt = plus(shift.startsAt, lateMinutes);
    const clockOutAt = plus(shift.endsAt, content.int(-5, 6));
    const approved = clockOutAt < approveBefore;
    const entryId = rid();
    entryRows.push({
      id: entryId,
      tenantId: TENANT,
      associateId: m.id,
      clientId: shift.store.clientId,
      locationId: shift.store.id,
      shiftId: shift.id,
      clockInAt,
      clockOutAt,
      payRate: shift.payRate,
      status: approved ? 'APPROVED' : 'COMPLETED',
      ...(approved ? { approvedById: approverFor(shift.store), approvedAt: earliest(plus(clockOutAt, content.int(10 * 60, 40 * 60)), approveBefore) } : {}),
      createdAt: clockInAt,
      updatedAt: approved ? earliest(plus(clockOutAt, 40 * 60), approveBefore) : clockOutAt,
    });
    const mealAt = plus(clockInAt, content.int(210, 270));
    breakRows.push({ id: rid(), tenantId: TENANT, timeEntryId: entryId, type: 'MEAL', startedAt: mealAt, endedAt: plus(mealAt, 30) });
    if (lateMinutes > LATE_GRACE_MIN) {
      eventRows.push({ id: rid(), tenantId: TENANT, associateId: m.id, shiftId: shift.id, clientId: shift.store.clientId, kind: 'LATE', points: POINTS.LATE, occurredOn: utcDateOf(shift.startsAt), source: 'AUTO', note: `${lateMinutes} min after shift start`, createdAt: clockOutAt, updatedAt: clockOutAt });
      count('lateArrivals');
    }
  }

  const REASONS: Array<[CallOutReason, number]> = [
    ['SICK', 0.45],
    ['FAMILY', 0.19],
    ['TRANSPORT', 0.15],
    ['EMERGENCY', 0.08],
    ['OTHER', 0.08],
    ['BEREAVEMENT', 0.03],
    ['JURY_DUTY', 0.02],
  ];
  const CHANNELS: Array<[CallOutChannel, number]> = [
    ['WHATSAPP', 0.4],
    ['APP', 0.25],
    ['SMS', 0.18],
    ['VOICE', 0.1],
    ['STAFF', 0.07],
  ];
  const weighted = <T,>(list: Array<[T, number]>): T => {
    let r = content.float();
    for (const [v, w] of list) if ((r -= w) < 0) return v;
    return list[0]![0];
  };
  const NOTES: Partial<Record<CallOutReason, string[]>> = {
    SICK: ['Fever since last night', 'Stomach bug', 'Migraine, can barely see', 'Doctor said stay home today'],
    FAMILY: ['Kid is sick and no sitter', "My mom's in the hospital", 'Daycare closed today'],
    TRANSPORT: ["Car won't start", 'Flat tire on Back Beach Rd', 'Missed the van', 'Ride fell through'],
    EMERGENCY: ['Water heater burst at my place', 'Family emergency in Mobile'],
    BEREAVEMENT: ["Grandmother's funeral in Dothan"],
    JURY_DUTY: ['Jury summons — Bay County courthouse'],
  };

  /** Minutes of notice a call-out gives, by why. */
  function noticeFor(reason: CallOutReason): number {
    switch (reason) {
      case 'BEREAVEMENT':
        return content.int(24 * 60, 72 * 60);
      case 'JURY_DUTY':
        return content.int(48 * 60, 7 * 24 * 60);
      case 'TRANSPORT':
        return content.chance(0.7) ? content.int(15, 95) : content.int(120, 600);
      case 'EMERGENCY':
        return content.chance(0.8) ? content.int(10, 100) : content.int(120, 480);
      case 'SICK':
        return content.chance(0.55) ? content.int(20, 115) : content.int(120, 720);
      case 'FAMILY':
        return content.chance(0.35) ? content.int(25, 115) : content.int(120, 48 * 60);
      default:
        return content.chance(0.4) ? content.int(30, 115) : content.int(120, 24 * 60);
    }
  }

  const keys: string[] = [];
  for (let i = HISTORY_DAYS - 1; i >= 0; i--) keys.push(addDaysToKey(todayKey, -i));
  let firstShiftAt: Date | null = null;
  let lastShiftAt: Date | null = null;

  for (const store of stores) {
    const crew = members.filter((m) => m.store === store);
    const lead = crew.find((m) => m.isLead) ?? null;
    // Who worked last night's overnight (planned or covering): not on the floor again at 6.
    let overnightYesterday = new Set<string>();
    // The days each person worked, to cap a cover at six shifts in seven days.
    const workedDays = new Map<string, number[]>();
    const worked = (m: Member, dayIndex: number) => workedDays.set(m.id, [...(workedDays.get(m.id) ?? []), dayIndex]);
    const shiftsInLastSix = (m: Member, dayIndex: number) => (workedDays.get(m.id) ?? []).filter((d) => d >= dayIndex - 6).length;
    keys.forEach((key, dayIndex) => {
      const overnightTonight = new Set<string>();
      const weekday = weekdayOfKey(key);
      const info = dayInfo(key);
      const weekend = weekday === 0 || weekday === 5 || weekday === 6;
      const busy = new Set<string>();
      const planned: Array<{ member: Member; window: WindowLabel; position: string }> = [];
      for (const w of store.shape.windows) {
        let target = w.base;
        if (info.summer) target += 1;
        if (info.summer && weekend) target += 1;
        if (info.springBreak && weekend) target += 1;
        if (info.busyHoliday) target += 1;
        if (info.quietHoliday) target -= 1;
        if (w.label === 'Overnight') target = Math.min(target, w.base + 1);
        target = Math.max(1, target);
        const available = crew.filter(
          (m) => m.window === w.label && onFloor(m, key) && !m.offDays.includes(weekday) && !(m.isLead && m === lead) && !(w.label === 'Morning' && overnightYesterday.has(m.id)),
        );
        const rotated = available.length ? [...available.slice(dayIndex % available.length), ...available.slice(0, dayIndex % available.length)] : [];
        const picks: Member[] = [];
        if (w.label === 'Morning' && lead && onFloor(lead, key) && !lead.offDays.includes(weekday) && !overnightYesterday.has(lead.id)) picks.push(lead);
        for (const m of rotated) {
          if (picks.length >= target) break;
          picks.push(m);
        }
        for (const m of picks) {
          busy.add(m.id);
          planned.push({ member: m, window: w.label, position: m.position });
        }
      }

      for (const plan of planned) {
        const m = plan.member;
        const startsAt = wallToUtc(key, WINDOW_START[plan.window], store.tz);
        const endsAt = plus(startsAt, SHIFT_MINUTES);
        if (endsAt > now) continue; // only shifts that have ended
        const rate = RATES[plan.position]!;
        const id = rid();
        const publishedAt = plus(startsAt, -content.int(6 * 24 * 60, 10 * 24 * 60));
        const base: Prisma.ShiftCreateManyInput = {
          id,
          tenantId: TENANT,
          clientId: store.clientId,
          locationId: store.id,
          position: plan.position,
          startsAt,
          endsAt,
          location: content.pick(rate.area),
          hourlyRate: rate.bill,
          payRate: rate.pay,
          assignedAssociateId: m.id,
          workerId: m.workerId,
          assignedAt: publishedAt,
          publishedAt,
          createdById: content.chance(0.8) ? workforce : admin.id,
          createdAt: plus(publishedAt, -content.int(60, 2 * 24 * 60)),
          updatedAt: endsAt,
        };
        if (!firstShiftAt || startsAt < firstShiftAt) firstShiftAt = startsAt;
        if (!lastShiftAt || startsAt > lastShiftAt) lastShiftAt = startsAt;
        const shift = { id, startsAt, endsAt, payRate: rate.pay, store };

        // What happened: a call-out, a no-show, a late punch, or an ordinary day.
        let pCall = 0.031 + (weekend ? 0.012 : 0);
        if (info.summer) pCall = pCall * 1.5 + (weekend ? 0.025 : 0);
        if (info.springBreak && weekend) pCall += 0.01;
        pCall = Math.max(pCall, info.holiday);
        let pNoShow = 0.008 + (info.summer && weekend ? 0.008 : 0);
        if (info.holiday > 0) pNoShow = Math.max(pNoShow, 0.03);
        const pLate = 0.035 + (weekday === 1 ? 0.015 : 0) + (info.summer ? 0.01 : 0) + (info.holiday > 0 ? 0.02 : 0);
        const r = content.float();

        if (r < pCall) {
          // A confirmed call-out (lib/callOuts): recorded, the shift released to Open, cover started.
          const reason = weighted(REASONS);
          const channel = weighted(CHANNELS);
          const minutesBeforeStart = noticeFor(reason);
          const createdAt = plus(startsAt, -minutesBeforeStart);
          const confirmedAt = channel === 'WHATSAPP' || channel === 'SMS' ? plus(createdAt, content.int(1, 6)) : createdAt;
          const late = minutesBeforeStart < LATE_CALL_OUT_MINUTES;
          const note = content.chance(0.45) && NOTES[reason] ? content.pick(NOTES[reason]!) : null;
          const excusedWhy =
            reason === 'BEREAVEMENT' ? 'Bereavement — excused by policy' : reason === 'JURY_DUTY' ? 'Jury duty — excused by policy' : reason === 'SICK' && content.chance(0.35) ? 'Sick — covered by accrued sick time' : null;
          // Cover: a teammate off that day picks it up — likelier with notice.
          const pool = crew.filter(
            (c) => c.id !== m.id && onFloor(c, key) && !busy.has(c.id) && !(plan.window === 'Morning' && overnightYesterday.has(c.id)) && shiftsInLastSix(c, dayIndex) <= 5,
          );
          const sameWindow = pool.filter((c) => c.window === plan.window && !c.isLead);
          const coverOdds = minutesBeforeStart >= LATE_CALL_OUT_MINUTES ? 0.85 : 0.55;
          const benchInvited = Math.min(pool.length, content.int(1, 4));
          let coverBy: Member | null = null;
          let coverAt: Date | null = null;
          if (pool.length && content.chance(coverOdds)) {
            const wait = late ? content.int(8, Math.max(9, minutesBeforeStart - 5)) : content.int(15, Math.min(300, minutesBeforeStart - 10));
            const at = plus(confirmedAt, wait);
            if (at < startsAt) {
              coverBy = content.pick(sameWindow.length ? sameWindow : pool);
              coverAt = at;
              busy.add(coverBy.id);
            }
          }
          const steps = [
            { key: 'post', status: 'done', detail: 'Released and posted to Open shifts.' },
            { key: 'bench', status: 'done', detail: benchInvited > 0 ? `${benchInvited} on the bench invited.` : 'The bench was already asked, or nobody is free.' },
            late
              ? { key: 'agent', status: 'done', detail: coverBy ? '1 proposal in your Approvals.' : 'Nothing to propose yet.' }
              : { key: 'agent', status: 'waiting', detail: 'The agent proposes a fill if the bench has not taken it in two hours.' },
          ];
          const releasedNote = `Released ${confirmedAt.toISOString().slice(0, 10)}: call-out (${reason.toLowerCase().replace(/_/g, ' ')})`;
          if (coverBy && coverAt) {
            shiftRows.push({ ...base, status: 'COMPLETED', assignedAssociateId: coverBy.id, workerId: coverBy.workerId, assignedAt: coverAt, acknowledgedAt: plus(coverAt, content.int(1, 20)), notes: releasedNote });
            work(shift, coverBy, content.int(-6, 5));
            worked(coverBy, dayIndex);
            if (plan.window === 'Overnight') overnightTonight.add(coverBy.id);
            count('callOutsCovered');
          } else {
            shiftRows.push({ ...base, status: 'OPEN', assignedAssociateId: null, workerId: null, acknowledgedAt: null, notes: releasedNote });
            count('callOutsLeftOpen');
          }
          callOutRows.push({
            id: rid(),
            tenantId: TENANT,
            shiftId: id,
            associateId: m.id,
            clientId: store.clientId,
            locationId: store.id,
            channel,
            reason,
            note,
            status: 'CONFIRMED',
            minutesBeforeStart,
            late,
            excused: !!excusedWhy,
            excusedWhy,
            coverSteps: steps,
            confirmedAt,
            createdById: channel === 'STAFF' ? (supervisor && supervisor.clientId === store.clientId ? supervisor.id : workforce) : null,
            createdAt,
            updatedAt: confirmedAt,
          });
          const words = reason.toLowerCase().replace(/_/g, ' ');
          const eventNote = `${late ? 'Late call-out' : 'Call-out'} by ${channel.toLowerCase()} (${words})${note ? `: ${note}` : ''}`;
          eventRows.push({
            id: rid(),
            tenantId: TENANT,
            associateId: m.id,
            shiftId: id,
            clientId: store.clientId,
            kind: 'CALL_OUT',
            points: POINTS.CALL_OUT,
            occurredOn: utcDateOf(startsAt),
            source: 'AUTO',
            note: (excusedWhy ? [eventNote, excusedWhy].join(' — ') : eventNote).slice(0, 1000),
            ...(excusedWhy ? { excusedAt: confirmedAt } : {}),
            createdAt: confirmedAt,
            updatedAt: confirmedAt,
          });
        } else if (r < pCall + pNoShow) {
          // Never came, never called: the sweep stamped it once the shift ended (lib/shiftReminder).
          const recordedAt = plus(endsAt, content.int(1, 5));
          shiftRows.push({ ...base, status: 'ASSIGNED', acknowledgedAt: content.chance(0.6) ? plus(startsAt, -content.int(20 * 60, 60 * 60)) : null, noShowNotifiedAt: plus(startsAt, content.int(15, 20)), noShowRecordedAt: recordedAt });
          eventRows.push({ id: rid(), tenantId: TENANT, associateId: m.id, shiftId: id, clientId: store.clientId, kind: 'NO_CALL_NO_SHOW', points: POINTS.NO_CALL_NO_SHOW, occurredOn: utcDateOf(startsAt), source: 'AUTO', createdAt: recordedAt, updatedAt: recordedAt });
          count('noShows');
        } else {
          const lateMinutes = r < pCall + pNoShow + pLate ? content.int(LATE_GRACE_MIN + 1, 38) : content.int(-6, 5);
          shiftRows.push({ ...base, status: 'COMPLETED', acknowledgedAt: content.chance(0.9) ? plus(startsAt, -content.int(8 * 60, 60 * 60)) : null });
          work(shift, m, lateMinutes);
          worked(m, dayIndex);
          if (plan.window === 'Overnight') overnightTonight.add(m.id);
        }
      }
      overnightYesterday = overnightTonight;
    });
  }

  // ---- Rows: people ----------------------------------------------------------
  const associateRows: Prisma.AssociateCreateManyInput[] = members.map((m) => ({
    id: m.id,
    tenantId: TENANT,
    firstName: m.firstName,
    lastName: m.lastName,
    email: m.email,
    phone: m.phone,
    city: m.store.city,
    state: m.store.state ?? 'FL',
    hireDate: dateOf(m.startKey),
    separatedAt: m.separatedAt,
    createdAt: wallToUtc(addDaysToKey(m.startKey, -content.int(3, 10)), 10 * 60, m.store.tz),
    updatedAt: m.separatedAt ?? now,
  }));
  const workerRows: Prisma.WorkerCreateManyInput[] = members.map((m) => ({
    id: m.workerId,
    tenantId: TENANT,
    type: 'PERSON',
    associateId: m.id,
    name: `${m.firstName} ${m.lastName}`,
    ownerUserId: admin.id,
    status: m.separatedAt ? 'OFFBOARDED' : 'ACTIVE',
    offboardedAt: m.separatedAt,
  }));
  const assignmentRows: Prisma.AssociateAssignmentCreateManyInput[] = members.map((m) => ({
    id: rid(),
    tenantId: TENANT,
    associateId: m.id,
    locationId: m.store.id,
    startedAt: dateOf(m.startKey),
    endedAt: m.endKey ? dateOf(m.endKey) : null,
    reason: m.hiredByRecruiting ? 'Hired' : 'Placed',
    notedById: m.hiredByRecruiting ? recruiter : workforce,
    notes: `${m.position}, ${m.window.toLowerCase()} crew`,
  }));

  // ---- Rows: recruiting ------------------------------------------------------
  const postingRows: Prisma.JobPostingCreateManyInput[] = postings.map((p) => {
    const rate = RATES[p.spec.title]!;
    const place = [p.store.city, p.store.state].filter(Boolean).join(', ') || p.store.name;
    return {
      id: p.id,
      tenantId: TENANT,
      clientId: p.store.clientId,
      title: p.spec.title,
      description: `${p.spec.title} at ${p.store.name}, ${place}. ${p.spec.schedule === 'PART_TIME' ? 'Part-time' : p.spec.schedule === 'SEASONAL' ? 'Seasonal, full-time hours' : 'Full-time'}, weekends in rotation, paid every other Friday. Alto People hires you, trains you on the floor and gets you to the store.`,
      location: place,
      minSalary: rate.pay,
      maxSalary: rate.pay + 1.5,
      payUnit: 'HOUR',
      schedule: p.spec.schedule,
      slug: `${p.spec.key}-${p.store.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      status: p.status,
      openings: p.spec.openings,
      openedAt: p.openedAt,
      closedAt: p.closedAt,
      createdById: recruiter,
      createdAt: plus(p.openedAt, -content.int(60, 24 * 60)),
      updatedAt: p.closedAt ?? p.openedAt,
    };
  });

  const userFor = (a: Move['actor']) => (a === 'recruiter' ? recruiter : a === 'admin' ? admin.id : null);
  const candidateRows: Prisma.CandidateCreateManyInput[] = [];
  const candidateEventRows: Prisma.CandidateEventCreateManyInput[] = [];
  const offerRows: Prisma.OfferCreateManyInput[] = [];
  for (const c of live) {
    const j = c.journey;
    const last = j.moves[j.moves.length - 1];
    const closing = last && (last.to === 'REJECTED' || last.to === 'WITHDRAWN') ? last : null;
    candidateRows.push({
      id: c.id,
      tenantId: TENANT,
      firstName: c.first,
      lastName: c.last,
      email: c.email,
      phone: c.phone,
      position: c.posting.spec.title,
      source: c.source,
      stage: j.stage,
      jobPostingId: c.posting.id,
      stageChangedAt: last ? last.at : j.createdAt,
      rejectedReason: closing?.to === 'REJECTED' ? closing.body : null,
      withdrawnReason: closing?.to === 'WITHDRAWN' ? closing.body : null,
      ...(j.stage === 'HIRED' && c.hire ? { hiredAssociateId: c.hire.id, hiredClientId: c.posting.store.clientId, hiredAt: j.hiredAt } : {}),
      createdAt: j.createdAt,
      updatedAt: last ? last.at : j.createdAt,
    });
    // CREATED — the careers page (no one's name) or a recruiter typing them in.
    const careers = c.source === 'careers-page';
    candidateEventRows.push({
      id: rid(),
      tenantId: TENANT,
      candidateId: c.id,
      kind: 'CREATED',
      toStage: 'APPLIED',
      actorUserId: careers ? null : recruiter,
      body: careers ? `Applied on the careers page: ${c.posting.spec.title}` : c.source,
      ...(careers ? { metadata: { postingSlug: postingRows.find((p) => p.id === c.posting.id)!.slug } } : {}),
      createdAt: j.createdAt,
    });
    let offerId: string | null = null;
    if (j.offer) {
      const o = j.offer;
      offerId = rid();
      offerRows.push({
        id: offerId,
        tenantId: TENANT,
        candidateId: c.id,
        clientId: c.posting.store.clientId,
        jobTitle: c.posting.spec.title,
        startDate: dateOf(o.startKey),
        hourlyRate: RATES[c.posting.spec.title]!.pay,
        status: o.status,
        sentAt: o.sentAt,
        decidedAt: o.decidedAt,
        expiresAt: o.expiresAt,
        declineReason: o.declineReason,
        ...(o.status === 'ACCEPTED' ? { signedName: `${c.first} ${c.last}`, signedAt: o.decidedAt } : {}),
        createdById: recruiter,
        createdAt: o.createdAt,
        updatedAt: o.decidedAt ?? o.sentAt,
      });
      const summary = `${c.posting.spec.title} · ${c.posting.store.clientName}`;
      candidateEventRows.push({ id: rid(), tenantId: TENANT, candidateId: c.id, kind: 'OFFER_CREATED', actorUserId: recruiter, body: summary, metadata: { offerId }, createdAt: o.createdAt });
      candidateEventRows.push({ id: rid(), tenantId: TENANT, candidateId: c.id, kind: 'OFFER_SENT', actorUserId: recruiter, body: c.posting.spec.title, metadata: { offerId }, createdAt: o.sentAt });
      if (o.decidedAt && o.status !== 'SENT') {
        const word = o.status.charAt(0) + o.status.slice(1).toLowerCase();
        candidateEventRows.push({
          id: rid(),
          tenantId: TENANT,
          candidateId: c.id,
          kind: 'OFFER_DECIDED',
          actorUserId: o.status === 'EXPIRED' ? null : recruiter,
          body: `${word}: ${c.posting.spec.title}`,
          metadata: { offerId, decision: o.status },
          createdAt: o.decidedAt,
        });
      }
    }
    for (const mv of j.moves) {
      if (mv.to === 'HIRED') {
        candidateEventRows.push({
          id: rid(),
          tenantId: TENANT,
          candidateId: c.id,
          kind: 'HIRED',
          fromStage: mv.from,
          toStage: 'HIRED',
          actorUserId: userFor(mv.actor),
          body: mv.body,
          metadata: { applicationId: null, clientId: c.posting.store.clientId, offerId, payRecorded: true },
          createdAt: mv.at,
        });
        continue;
      }
      candidateEventRows.push({
        id: rid(),
        tenantId: TENANT,
        candidateId: c.id,
        kind: 'STAGE_CHANGED',
        fromStage: mv.from,
        toStage: mv.to,
        actorUserId: userFor(mv.actor),
        body: mv.body,
        ...(mv.automatic ? { metadata: { automatic: true, lastActivity: mv.automatic.lastActivity.toISOString() } } : {}),
        createdAt: mv.at,
      });
    }
  }

  // What each source cost, month by month, for every month the candidates span.
  const spendRows: Prisma.RecruitingSourceSpendCreateManyInput[] = [];
  {
    const firstMonth = live.reduce((min, c) => (c.journey.createdAt < min ? c.journey.createdAt : min), now);
    const referralHiresByMonth = new Map<string, number>();
    for (const c of live) if (c.journey.hiredAt && c.source === 'Referral') referralHiresByMonth.set(c.journey.hiredAt.toISOString().slice(0, 7), (referralHiresByMonth.get(c.journey.hiredAt.toISOString().slice(0, 7)) ?? 0) + 1);
    for (let d = new Date(Date.UTC(firstMonth.getUTCFullYear(), firstMonth.getUTCMonth(), 1)); d <= now; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
      const month = d.toISOString().slice(0, 7);
      const busySeason = [2, 3, 4, 8, 9].includes(d.getUTCMonth());
      const add = (source: string, amount: number, note: string) =>
        spendRows.push({ id: rid(), tenantId: TENANT, source, month: d, amount, note, updatedById: recruiter, createdAt: earliest(plus(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)), -2 * 24 * 60), now) });
      add('indeed', busySeason ? content.int(48, 62) * 10 : content.int(28, 40) * 10, 'Sponsored jobs');
      add('ziprecruiter', 249, 'Standard plan');
      if (busySeason) add('facebook', content.int(8, 16) * 10, 'Boosted job posts');
      const referrals = referralHiresByMonth.get(month) ?? 0;
      if (referrals > 0) add('referral', referrals * 150, `Referral bonus${referrals === 1 ? '' : 'es'} (${referrals})`);
    }
  }

  // ---- Write, in one transaction ---------------------------------------------
  const write = async <T,>(label: string, rows: T[], fn: (chunk: T[]) => Promise<unknown>) => {
    for (let i = 0; i < rows.length; i += CHUNK) await fn(rows.slice(i, i + CHUNK));
    count(label, rows.length);
  };
  await prisma.$transaction(
    async (tx) => {
      await write('associates', associateRows, (c) => tx.associate.createMany({ data: c }));
      await write('workers', workerRows, (c) => tx.worker.createMany({ data: c }));
      await write('assignments', assignmentRows, (c) => tx.associateAssignment.createMany({ data: c }));
      await write('shifts', shiftRows, (c) => tx.shift.createMany({ data: c }));
      await write('timeEntries', entryRows, (c) => tx.timeEntry.createMany({ data: c }));
      await write('breaks', breakRows, (c) => tx.breakEntry.createMany({ data: c }));
      await write('callOuts', callOutRows, (c) => tx.callOut.createMany({ data: c }));
      await write('attendanceEvents', eventRows, (c) => tx.attendanceEvent.createMany({ data: c }));
      await write('jobPostings', postingRows, (c) => tx.jobPosting.createMany({ data: c }));
      await write('candidates', candidateRows, (c) => tx.candidate.createMany({ data: c }));
      await write('offers', offerRows, (c) => tx.offer.createMany({ data: c }));
      await write('candidateEvents', candidateEventRows, (c) => tx.candidateEvent.createMany({ data: c }));
      // A month someone already recorded by hand keeps its figure.
      await write('sourceSpendMonths', spendRows, (c) => tx.recruitingSourceSpend.createMany({ data: c, skipDuplicates: true }));
    },
    { timeout: 300_000, maxWait: 20_000 },
  );

  // ---- The receipt -------------------------------------------------------------
  const stageTally = new Map<string, number>();
  for (const c of live) stageTally.set(c.journey.stage, (stageTally.get(c.journey.stage) ?? 0) + 1);
  const recent = live.filter((c) => c.journey.createdAt.getTime() >= now.getTime() - 90 * DAY).length;
  const span = (a: Date | null, b: Date | null) => (a && b ? `${a.toISOString().slice(0, 10)} → ${b.toISOString().slice(0, 10)}` : '—');
  const firstApplied = live.reduce<Date | null>((min, c) => (!min || c.journey.createdAt < min ? c.journey.createdAt : min), null);
  console.log(`[seed-demo-analytics] done — anchored on ${now.toISOString()} (store day ${todayKey})`);
  console.log(`[seed-demo-analytics]   stores: ${stores.map((s) => `${s.name} (${s.clientName})`).join('; ')}`);
  console.log(`[seed-demo-analytics]   crew: ${members.length} (${members.filter((m) => m.hiredByRecruiting).length} hired through recruiting, ${members.filter((m) => m.separatedAt).length} since separated)`);
  console.log(`[seed-demo-analytics]   shifts ${span(firstShiftAt, lastShiftAt)}; candidates applied ${span(firstApplied, now)}, ${recent} in the last 90 days`);
  console.log(`[seed-demo-analytics]   candidate stages: ${[...stageTally].map(([s, n]) => `${s} ${n}`).join(', ')}`);
  for (const [k, v] of Object.entries(counts)) console.log(`[seed-demo-analytics]   ${k}: ${v}`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
