import type { Prisma, PrismaClient, TaxAgencyKind } from '@prisma/client';
import { generateReturn, type GeneratedReturn, type ReturnKind } from './payrollTaxReturns.js';
import { NO_INCOME_TAX_STATES, STATE_NAMES } from './payrollTaxLedger.js';
import { tenantIdForWrite } from './tenant.js';
import { loadItemBases, type ItemBases } from './wageBases.js';
import { boxesFromBases, getSsWageBaseForYear, type W2Boxes } from './w2Aggregator.js';
import { efw2Unsupported } from './efw2.js';

/**
 * Year-end reconciliation: before the W-2s and the fourth-quarter and annual
 * returns go out, every number that should agree is put side by side —
 *
 *   (a) the paychecks themselves (lib/wageBases),
 *   (b) the four 941s (the filed one where it exists, else generated now),
 *   (c) deposits made to each agency (the liability ledger, PAID),
 *   (d) the W-2s (stored where generated, else computed exactly as the W-2 is),
 *   (e) each state: paychecks vs quarterly returns vs W-2 state boxes vs deposits,
 *   (f) each locality, (g) FUTA: accrued vs the 940 vs deposits,
 *   (h) unemployment and the disability / paid-leave programs,
 *
 * with a variance on every row and, behind each variance, the people whose
 * paychecks and W-2 disagree. A pre-filing checklist names what would get a
 * W-2 rejected or a return questioned (missing SSN or address, negative or
 * over-the-base boxes, Box 12 DD at 250+ W-2s, 2026 tips without an
 * occupation code, quarters with no 941).
 */

type Db = PrismaClient | Prisma.TransactionClient;
const r2 = (n: number) => Math.round(n * 100) / 100;
/** A dollar of rounding is not a variance (per-check rounding of half-taxes). */
const TOLERANCE = 1;

export interface ReconRow {
  key: string;
  label: string;
  /** Named sources, each a figure or null (not applicable / not yet made). */
  values: Record<string, number | null>;
  /** The largest gap between any two non-null sources. */
  variance: number;
  ok: boolean;
  /** Which metric the people drill-down uses for this row, when there is one. */
  drill?: PersonMetric;
  note?: string;
}

export interface ReconSection {
  key: string;
  title: string;
  /** Column order and labels for `values`. */
  sources: Array<{ key: string; label: string }>;
  rows: ReconRow[];
}

export interface ChecklistItem {
  severity: 'BLOCKING' | 'WARNING' | 'INFO';
  code: string;
  message: string;
  count: number;
  people?: Array<{ associateId: string; name: string }>;
}

export type PersonMetric = 'box1' | 'box2' | 'box3' | 'box4' | 'box5' | 'box6' | `state:${string}` | `stateTax:${string}`;

export interface YearEndReconciliation {
  year: number;
  generatedAt: string;
  people: number;
  w2Count: number;
  storedW2s: number;
  sections: ReconSection[];
  checklist: ChecklistItem[];
  /** Quarters whose 941 was generated for this view because none is on file. */
  generatedQuarters: string[];
  summary: { rows: number; variances: number; blocking: number; warnings: number };
}

const QUARTERS = [1, 2, 3, 4] as const;

function row(key: string, label: string, values: Record<string, number | null>, extra: Partial<ReconRow> = {}): ReconRow {
  const present = Object.values(values).filter((v): v is number => v !== null && Number.isFinite(v));
  const variance = present.length > 1 ? r2(Math.max(...present) - Math.min(...present)) : 0;
  const rounded = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v === null ? null : r2(v)]));
  return { key, label, values: rounded, variance, ok: variance <= TOLERANCE, ...extra };
}

/** The latest return of a kind for a period: the filed one where it exists, else generated now. */
async function returnFor(db: Db, kind: ReturnKind, jurisdiction: string, periodLabel: string): Promise<{ totals: Record<string, number>; generated: boolean; status: string | null } | null> {
  const stored = await db.taxReturn.findFirst({
    where: { tenantId: tenantIdForWrite(), kind, jurisdiction, periodLabel, status: { not: 'SUPERSEDED' } },
    orderBy: [{ filedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
  });
  if (stored) return { totals: ((stored.data as { totals?: Record<string, number> }).totals ?? {}) as Record<string, number>, generated: false, status: stored.status };
  try {
    const g: GeneratedReturn = await generateReturn(db, kind, jurisdiction, periodLabel);
    return { totals: g.totals, generated: true, status: null };
  } catch {
    return null;
  }
}

async function ledger(db: Db, year: number, kind: TaxAgencyKind, jurisdiction?: string): Promise<{ posted: number; paid: number }> {
  const rows = await db.taxLiability.findMany({
    where: { tenantId: tenantIdForWrite(), kind, ...(jurisdiction ? { jurisdiction } : {}), periodLabel: { startsWith: String(year) }, status: { not: 'VOID' } },
    select: { amount: true, status: true },
  });
  return { posted: r2(rows.reduce((a, r) => a + Number(r.amount), 0)), paid: r2(rows.filter((r) => r.status === 'PAID').reduce((a, r) => a + Number(r.amount), 0)) };
}

/** Each person's W-2 boxes computed from their paid checks, plus the stored W-2s for the year. */
async function w2sFor(db: Db, year: number, byPerson: Map<string, ItemBases[]>): Promise<{ computed: Map<string, W2Boxes>; stored: Map<string, W2Boxes> }> {
  const ssBase = await getSsWageBaseForYear(db, year).catch(() => 184_500);
  const computed = new Map<string, W2Boxes>();
  for (const [id, items] of byPerson) computed.set(id, boxesFromBases(items, ssBase, year));
  const forms = await db.taxForm.findMany({
    where: { tenantId: tenantIdForWrite(), taxYear: year, kind: { in: ['W2', 'W2C'] }, status: { not: 'VOIDED' }, associateId: { not: null } },
    orderBy: { createdAt: 'asc' },
    select: { associateId: true, kind: true, amounts: true },
  });
  // A W-2c's corrected figures replace the W-2 they correct; several W-2s (one per employer EIN) add up.
  const stored = new Map<string, W2Boxes>();
  const perPerson = new Map<string, W2Boxes[]>();
  for (const f of forms) {
    const boxes = (f.kind === 'W2C' ? (f.amounts as unknown as { corrected?: W2Boxes }).corrected : (f.amounts as unknown as W2Boxes)) ?? null;
    if (!boxes) continue;
    const list = perPerson.get(f.associateId!) ?? [];
    if (f.kind === 'W2C') list.splice(0, list.length, boxes);
    else list.push(boxes);
    perPerson.set(f.associateId!, list);
  }
  for (const [id, list] of perPerson) stored.set(id, sumBoxes(list));
  return { computed, stored };
}

function sumBoxes(list: W2Boxes[]): W2Boxes {
  const out: W2Boxes = { box1Wages: 0, box2FitWithheld: 0, box3SsWages: 0, box4SsTax: 0, box5MedicareWages: 0, box6MedicareTax: 0, box7SsTips: 0, box10DependentCare: 0, box12: [], stateLines: [], localLines: [], sourceItemCount: 0 };
  for (const b of list) {
    out.box1Wages += b.box1Wages;
    out.box2FitWithheld += b.box2FitWithheld;
    out.box3SsWages += b.box3SsWages;
    out.box4SsTax += b.box4SsTax;
    out.box5MedicareWages += b.box5MedicareWages;
    out.box6MedicareTax += b.box6MedicareTax;
    out.box7SsTips = (out.box7SsTips ?? 0) + (b.box7SsTips ?? 0);
    out.box10DependentCare = (out.box10DependentCare ?? 0) + (b.box10DependentCare ?? 0);
    out.box12!.push(...(b.box12 ?? []));
    out.stateLines.push(...b.stateLines);
    out.localLines!.push(...(b.localLines ?? []));
    out.sourceItemCount += b.sourceItemCount;
  }
  return out;
}

const box = (b: W2Boxes | undefined, metric: PersonMetric): number => {
  if (!b) return 0;
  if (metric === 'box1') return b.box1Wages;
  if (metric === 'box2') return b.box2FitWithheld;
  if (metric === 'box3') return b.box3SsWages + (b.box7SsTips ?? 0);
  if (metric === 'box4') return b.box4SsTax;
  if (metric === 'box5') return b.box5MedicareWages;
  if (metric === 'box6') return b.box6MedicareTax;
  const [kind, st] = metric.split(':') as [string, string];
  const lines = b.stateLines.filter((l) => l.state === st);
  return lines.reduce((s, l) => s + (kind === 'state' ? l.stateWages : l.stateIncomeTax), 0);
};

async function loadYear(db: Db, year: number): Promise<ItemBases[]> {
  return loadItemBases(db, {
    tenantId: tenantIdForWrite(),
    status: 'DISBURSED',
    associate: { employmentType: 'W2_EMPLOYEE' },
    payrollRun: { status: { not: 'CANCELLED' }, disbursedAt: { gte: new Date(Date.UTC(year, 0, 1)), lt: new Date(Date.UTC(year + 1, 0, 1)) } },
  });
}

export async function yearEndReconciliation(db: Db, year: number): Promise<YearEndReconciliation> {
  const items = await loadYear(db, year);
  const byPerson = new Map<string, ItemBases[]>();
  for (const i of items) byPerson.set(i.associateId, [...(byPerson.get(i.associateId) ?? []), i]);
  const { computed, stored } = await w2sFor(db, year, byPerson);
  const w2Of = (id: string) => stored.get(id) ?? computed.get(id);
  const w2Ids = new Set([...byPerson.keys(), ...stored.keys()]);
  const w2Total = (f: (b: W2Boxes) => number) => [...w2Ids].reduce((s, id) => s + (w2Of(id) ? f(w2Of(id)!) : 0), 0);
  const sum = (f: (i: ItemBases) => number) => items.reduce((s, i) => s + f(i), 0);

  // 941s, one per quarter.
  const generatedQuarters: string[] = [];
  const q941 = await Promise.all(QUARTERS.map((q) => returnFor(db, 'F941', 'US', `${year}-Q${q}`)));
  q941.forEach((r, i) => {
    if (r?.generated) generatedQuarters.push(`${year}-Q${i + 1}`);
  });
  const t941 = (k: string) => q941.reduce((s, r) => s + (r?.totals[k] ?? 0), 0);
  const fed = await ledger(db, year, 'FEDERAL_WITHHOLDING');

  const federal: ReconSection = {
    key: 'federal',
    title: 'Federal: paychecks, Forms 941 and W-2s',
    sources: [
      { key: 'paychecks', label: 'Paychecks' },
      { key: 'f941', label: 'Four 941s' },
      { key: 'w2', label: 'W-2s (W-3)' },
    ],
    rows: [
      row('wages', 'Wages, tips and other pay (941 line 2 · W-2 box 1)', { paychecks: sum((i) => i.fitWages), f941: t941('line2_wages'), w2: w2Total((b) => b.box1Wages) }, { drill: 'box1' }),
      row('fit', 'Federal income tax withheld (941 line 3 · box 2)', { paychecks: sum((i) => i.fit), f941: t941('line3_federalIncomeTax'), w2: w2Total((b) => b.box2FitWithheld) }, { drill: 'box2' }),
      row('ssWages', 'Social Security wages and tips (941 lines 5a+5b · boxes 3+7)', { paychecks: null, f941: t941('line5a_socialSecurityWages') + t941('line5b_socialSecurityTips'), w2: w2Total((b) => b.box3SsWages + (b.box7SsTips ?? 0)) }, { drill: 'box3', note: 'Paychecks are not capped at the wage base; the 941s and W-2s are.' }),
      row('ssTax', 'Social Security tax, employee share (box 4)', { paychecks: sum((i) => i.ssEmployee), f941: null, w2: w2Total((b) => b.box4SsTax) }, { drill: 'box4' }),
      row('medWages', 'Medicare wages and tips (941 line 5c · box 5)', { paychecks: sum((i) => i.medicareWages), f941: t941('line5c_medicareWages'), w2: w2Total((b) => b.box5MedicareWages) }, { drill: 'box5' }),
      row('medTax', 'Medicare tax, employee share (box 6)', { paychecks: sum((i) => i.medicareEmployee), f941: null, w2: w2Total((b) => b.box6MedicareTax) }, { drill: 'box6' }),
    ],
  };
  const deposits: ReconSection = {
    key: 'deposits',
    title: 'Federal deposits',
    sources: [
      { key: 'paychecks', label: 'Paychecks' },
      { key: 'f941', label: 'Four 941s (line 12)' },
      { key: 'posted', label: 'Posted to the ledger' },
      { key: 'paid', label: 'Deposited' },
    ],
    rows: [
      row('fedTotal', 'Income tax + both halves of Social Security and Medicare', {
        paychecks: sum((i) => i.fit + i.ssEmployee + i.ssEmployer + i.medicareEmployee + i.medicareEmployer),
        f941: t941('line12_totalTax'),
        posted: fed.posted,
        paid: fed.paid,
      }),
    ],
  };

  // FUTA
  const f940 = await returnFor(db, 'F940', 'US', String(year));
  if (f940?.generated) generatedQuarters.push(String(year));
  const futa = await ledger(db, year, 'FEDERAL_UNEMPLOYMENT');
  const futaSection: ReconSection = {
    key: 'futa',
    title: 'Federal unemployment (Form 940)',
    sources: [
      { key: 'paychecks', label: 'Accrued on paychecks' },
      { key: 'f940', label: 'Form 940 (line 12)' },
      { key: 'posted', label: 'Posted' },
      { key: 'paid', label: 'Deposited' },
    ],
    rows: [row('futa', 'FUTA tax', { paychecks: sum((i) => i.futaEmployer), f940: f940?.totals.line12_totalFutaTax ?? f940?.totals.line8_futaTax ?? null, posted: futa.posted, paid: futa.paid })],
  };

  // States: paychecks vs quarterly returns vs W-2 state boxes vs deposits.
  const states = new Set<string>();
  for (const i of items) for (const s of i.states) states.add(s.state);
  const stateRows: ReconRow[] = [];
  for (const st of [...states].sort()) {
    const paid = items.flatMap((i) => i.states.filter((s) => s.state === st));
    const wh = await ledger(db, year, 'STATE_WITHHOLDING', st);
    const quarters = NO_INCOME_TAX_STATES.has(st) ? [] : await Promise.all(QUARTERS.map((q) => returnFor(db, 'STATE_WH_QUARTERLY', st, `${year}-Q${q}`)));
    const qWithheld = quarters.length ? quarters.reduce((s, r) => s + (r?.totals.stateTaxWithheld ?? 0), 0) : null;
    const qWages = quarters.length ? quarters.reduce((s, r) => s + (r?.totals.stateWages ?? 0), 0) : null;
    const name = STATE_NAMES[st] ?? st;
    stateRows.push(row(`state:${st}`, `${name} · state wages`, { paychecks: paid.reduce((s, x) => s + x.wages, 0), returns: qWages, w2: w2Total((b) => box(b, `state:${st}`)), posted: null, paid: null }, { drill: `state:${st}` }));
    stateRows.push(
      row(`stateTax:${st}`, `${name} · income tax withheld`, { paychecks: paid.reduce((s, x) => s + x.withheld, 0), returns: qWithheld, w2: w2Total((b) => box(b, `stateTax:${st}`)), posted: NO_INCOME_TAX_STATES.has(st) ? null : wh.posted, paid: NO_INCOME_TAX_STATES.has(st) ? null : wh.paid }, {
        drill: `stateTax:${st}`,
        ...(NO_INCOME_TAX_STATES.has(st) ? { note: `${name} has no wage income tax.` } : {}),
      }),
    );
  }
  const stateSection: ReconSection = {
    key: 'states',
    title: 'States: paychecks, quarterly returns, W-2 boxes 15–17, deposits',
    sources: [
      { key: 'paychecks', label: 'Paychecks' },
      { key: 'returns', label: 'Quarterly returns' },
      { key: 'w2', label: 'W-2s' },
      { key: 'posted', label: 'Posted' },
      { key: 'paid', label: 'Deposited' },
    ],
    rows: stateRows,
  };

  // Unemployment: the four quarterly wage reports vs what paychecks accrued vs deposits.
  const suiStates = [...new Set(items.map((i) => i.suiState).filter((s): s is string => !!s))].sort();
  const suiRows: ReconRow[] = [];
  for (const st of suiStates) {
    const reports = await Promise.all(QUARTERS.map((q) => returnFor(db, 'SUI_WAGE_REPORT', st, `${year}-Q${q}`)));
    const l = await ledger(db, year, 'STATE_UNEMPLOYMENT', st);
    suiRows.push(row(`sui:${st}`, `${STATE_NAMES[st] ?? st} · unemployment contributions`, { paychecks: items.filter((i) => i.suiState === st).reduce((s, i) => s + i.sutaEmployer, 0), reports: reports.reduce((s, r) => s + (r?.totals.contributionDue ?? 0), 0), posted: l.posted, paid: l.paid }));
  }
  const suiSection: ReconSection = {
    key: 'sui',
    title: 'State unemployment',
    sources: [
      { key: 'paychecks', label: 'Accrued on paychecks' },
      { key: 'reports', label: 'Quarterly wage reports' },
      { key: 'posted', label: 'Posted' },
      { key: 'paid', label: 'Deposited' },
    ],
    rows: suiRows,
  };

  // Localities: paychecks vs W-2 boxes 18–19 vs deposits.
  const locals = new Map<string, { label: string; state: string | null; wages: number; withheld: number }>();
  for (const i of items)
    for (const l of i.locals) {
      if (l.employer) continue;
      const k = `${l.state ?? ''}|${l.code}`;
      const v = locals.get(k) ?? { label: l.label, state: l.state, wages: 0, withheld: 0 };
      v.wages += l.wages;
      v.withheld += l.withheld;
      locals.set(k, v);
    }
  const localRows: ReconRow[] = [];
  for (const [k, v] of [...locals.entries()].sort()) {
    const code = k.split('|')[1]!;
    const w2 = w2Total((b) => (b.localLines ?? []).filter((x) => x.code === code && (x.state ?? '') === (v.state ?? '')).reduce((s, x) => s + x.localIncomeTax, 0));
    const l = await ledger(db, year, 'LOCAL', `${v.state ?? ''}:${v.label}`);
    localRows.push(row(`local:${k}`, `${v.label}${v.state ? ` (${v.state})` : ''} · local tax withheld`, { paychecks: v.withheld, w2, posted: l.posted || null, paid: l.posted ? l.paid : null }));
  }
  const localSection: ReconSection = {
    key: 'locals',
    title: 'Local taxes: paychecks, W-2 boxes 18–20, deposits',
    sources: [
      { key: 'paychecks', label: 'Paychecks' },
      { key: 'w2', label: 'W-2s' },
      { key: 'posted', label: 'Posted' },
      { key: 'paid', label: 'Deposited' },
    ],
    rows: localRows,
  };

  // Disability / paid-leave programs: what employees paid vs W-2 box 14.
  const programs = new Map<string, { label: string; employee: number; employer: number; box14Label: string }>();
  const { box14ProgramLabel } = await import('./wageBases.js');
  for (const i of items)
    for (const p of i.programs) {
      const v = programs.get(p.code) ?? { label: p.label, employee: 0, employer: 0, box14Label: box14ProgramLabel(p.code, p.state, p.label) };
      v.employee += p.employee;
      v.employer += p.employer;
      programs.set(p.code, v);
    }
  const programSection: ReconSection = {
    key: 'programs',
    title: 'State disability and paid leave',
    sources: [
      { key: 'paychecks', label: 'Withheld on paychecks' },
      { key: 'w2', label: 'W-2 box 14' },
      { key: 'employer', label: 'Employer share' },
    ],
    rows: [...programs.entries()].sort().map(([code, v]) =>
      row(`pgm:${code}`, `${v.label} (${v.box14Label})`, { paychecks: v.employee, w2: w2Total((b) => (b.box14Other ?? []).filter((e) => e.label === v.box14Label).reduce((s, e) => s + e.amount, 0)), employer: null }, { note: v.employer ? `Employer share ${r2(v.employer).toFixed(2)}` : undefined }),
    ),
  };

  const sections = [federal, deposits, futaSection, stateSection, suiSection, localSection, programSection].filter((s) => s.rows.length > 0);
  const checklist = await preFilingChecklist(db, year, byPerson, computed, stored, q941);
  const variances = sections.flatMap((s) => s.rows).filter((r) => !r.ok).length;
  return {
    year,
    generatedAt: new Date().toISOString(),
    people: byPerson.size,
    w2Count: w2Ids.size,
    storedW2s: stored.size,
    sections,
    checklist,
    generatedQuarters,
    summary: {
      rows: sections.reduce((s, x) => s + x.rows.length, 0),
      variances,
      blocking: checklist.filter((c) => c.severity === 'BLOCKING').length,
      warnings: checklist.filter((c) => c.severity === 'WARNING').length,
    },
  };
}

async function preFilingChecklist(
  db: Db,
  year: number,
  byPerson: Map<string, ItemBases[]>,
  computed: Map<string, W2Boxes>,
  stored: Map<string, W2Boxes>,
  q941: Array<{ generated: boolean; status: string | null } | null>,
): Promise<ChecklistItem[]> {
  const ids = [...new Set([...byPerson.keys(), ...stored.keys()])];
  const people = ids.length
    ? await db.associate.findMany({
        where: { id: { in: ids } },
        select: { id: true, firstName: true, lastName: true, addressLine1: true, city: true, state: true, zip: true, w4Submission: { select: { ssnEncrypted: true } } },
      })
    : [];
  const nameOf = new Map(people.map((p) => [p.id, `${p.firstName} ${p.lastName}`]));
  const who = (list: string[]) => list.slice(0, 50).map((id) => ({ associateId: id, name: nameOf.get(id) ?? 'Unknown' }));
  const out: ChecklistItem[] = [];
  const add = (severity: ChecklistItem['severity'], code: string, message: string, list: string[]) => {
    if (list.length) out.push({ severity, code, message, count: list.length, people: who(list) });
  };
  add('BLOCKING', 'missing_ssn', 'No Social Security number on file: the W-2 can’t be filed.', people.filter((p) => !p.w4Submission?.ssnEncrypted).map((p) => p.id));
  add('BLOCKING', 'missing_address', 'No complete mailing address: the W-2 can’t be mailed or e-filed.', people.filter((p) => !p.addressLine1 || !p.city || !p.state || !p.zip).map((p) => p.id));

  const ssBase = await getSsWageBaseForYear(db, year).catch(() => 184_500);
  const negative: string[] = [];
  const overBase: string[] = [];
  const ssMismatch: string[] = [];
  const stale: string[] = [];
  const noW2: string[] = [];
  const tipsNoCode: string[] = [];
  const efileGaps: string[] = [];
  for (const id of ids) {
    const b = computed.get(id);
    const s = stored.get(id);
    const use = s ?? b;
    if (!use) continue;
    const boxes = [use.box1Wages, use.box2FitWithheld, use.box3SsWages, use.box4SsTax, use.box5MedicareWages, use.box6MedicareTax, ...use.stateLines.flatMap((l) => [l.stateWages, l.stateIncomeTax])];
    if (boxes.some((n) => n < -0.004)) negative.push(id);
    if (use.box3SsWages + (use.box7SsTips ?? 0) > ssBase + 0.01) overBase.push(id);
    if (Math.abs(use.box4SsTax - r2((use.box3SsWages + (use.box7SsTips ?? 0)) * 0.062)) > TOLERANCE) ssMismatch.push(id);
    if (b && !s) noW2.push(id);
    if (b && s && ['box1', 'box2', 'box3', 'box5'].some((m) => Math.abs(box(b, m as PersonMetric) - box(s, m as PersonMetric)) > TOLERANCE)) stale.push(id);
    if (year >= 2026 && (use.box12 ?? []).some((c) => c.code === 'TP' && c.amount > 0) && !(use.box14bTippedOccupationCodes ?? []).length) tipsNoCode.push(id);
    if (efw2Unsupported({ submitter: {} as never, employer: { taxYear: year } as never, employees: [{ ssn: '000000000', firstName: '', lastName: '', addressLine1: '', city: '', state: '', zip5: '', boxes: use }] }).length) efileGaps.push(id);
  }
  add('BLOCKING', 'negative_box', 'A W-2 box is negative (an amendment took more than was paid): correct the paychecks before filing.', negative);
  add('BLOCKING', 'ss_over_base', `Social Security wages and tips exceed the ${year} wage base of $${ssBase.toLocaleString('en-US')}.`, overBase);
  add('BLOCKING', 'tips_no_occupation', 'Box 12 TP (tips) without a Treasury tipped occupation code in box 14b.', tipsNoCode);
  add('WARNING', 'ss_tax_mismatch', 'Box 4 isn’t 6.2% of boxes 3 + 7 (to the dollar): check refunds of over-withholding or exempt periods.', ssMismatch);
  add('WARNING', 'w2_stale', 'A W-2 on file no longer matches the paychecks: issue a W-2c (or regenerate the draft).', stale);
  add('INFO', 'w2_not_generated', 'Paid this year with no W-2 generated yet.', noW2);
  add('INFO', 'efile_provider', 'These W-2s carry 2026 boxes the SSA file can’t (TP/TT/TA, 14b): file them through the e-file provider.', efileGaps);

  // Box 12 DD: required once the employer files 250 or more W-2s for the year (Notice 2012-9 relief below that).
  const w2Count = ids.length;
  const healthNoDd: string[] = [];
  const healthRows = ids.length
    ? await db.payrollItemDeduction.findMany({
        where: { code: { in: ['MEDICAL', 'DENTAL', 'VISION', 'ER_HEALTH'] }, payrollItem: { associateId: { in: ids }, status: 'DISBURSED', payrollRun: { disbursedAt: { gte: new Date(Date.UTC(year, 0, 1)), lt: new Date(Date.UTC(year + 1, 0, 1)) } } } },
        select: { payrollItem: { select: { associateId: true } } },
        distinct: ['payrollItemId'],
      })
    : [];
  for (const id of new Set(healthRows.map((h) => h.payrollItem.associateId))) {
    const b = stored.get(id) ?? computed.get(id);
    if (!(b?.box12 ?? []).some((c) => c.code === 'DD' && c.amount > 0)) healthNoDd.push(id);
  }
  if (w2Count >= 250) add('WARNING', 'dd_required', `${w2Count} W-2s this year: Box 12 DD (cost of employer-sponsored health coverage) is required, and these people have health deductions but no DD.`, healthNoDd);
  else add('INFO', 'dd_optional', 'Health coverage without Box 12 DD: optional under 250 W-2s, required at 250 or more.', healthNoDd);

  const missingQuarters = q941.map((r, i) => (!r || r.generated ? `Q${i + 1}` : null)).filter(Boolean) as string[];
  if (missingQuarters.length) out.push({ severity: 'WARNING', code: 'no_941', message: `No Form 941 on file for ${missingQuarters.join(', ')} ${year}; the figures shown are generated from paychecks.`, count: missingQuarters.length });
  const unfiled = q941.map((r, i) => (r && !r.generated && r.status !== 'FILED' && r.status !== 'ACCEPTED' ? `Q${i + 1}` : null)).filter(Boolean) as string[];
  if (unfiled.length) out.push({ severity: 'WARNING', code: 'unfiled_941', message: `Form 941 for ${unfiled.join(', ')} ${year} is generated but not marked filed.`, count: unfiled.length });

  const rank = { BLOCKING: 0, WARNING: 1, INFO: 2 } as const;
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

export interface PersonVariance {
  associateId: string;
  name: string;
  paychecks: number;
  w2: number;
  difference: number;
  w2Source: 'stored' | 'computed' | 'none';
  checks: Array<{ itemId: string; paidAt: string; amount: number }>;
}

/**
 * The people behind a variance: each person's paychecks figure for the
 * metric next to their W-2's, largest difference first, with the checks.
 */
export async function personVariances(db: Db, year: number, metric: PersonMetric): Promise<PersonVariance[]> {
  const items = await loadYear(db, year);
  const byPerson = new Map<string, ItemBases[]>();
  for (const i of items) byPerson.set(i.associateId, [...(byPerson.get(i.associateId) ?? []), i]);
  const { computed, stored } = await w2sFor(db, year, byPerson);
  const ids = [...new Set([...byPerson.keys(), ...stored.keys()])];
  const names = new Map((await db.associate.findMany({ where: { id: { in: ids } }, select: { id: true, firstName: true, lastName: true } })).map((a) => [a.id, `${a.firstName} ${a.lastName}`]));
  const perCheck = (i: ItemBases): number => {
    if (metric === 'box1') return i.fitWages;
    if (metric === 'box2') return i.fit;
    if (metric === 'box3') return i.ssWages;
    if (metric === 'box4') return i.ssEmployee;
    if (metric === 'box5') return i.medicareWages;
    if (metric === 'box6') return i.medicareEmployee;
    const [kind, st] = metric.split(':') as [string, string];
    return i.states.filter((s) => s.state === st).reduce((a, s) => a + (kind === 'state' ? s.wages : s.withheld), 0);
  };
  const out: PersonVariance[] = [];
  for (const id of ids) {
    const checks = (byPerson.get(id) ?? []).map((i) => ({ itemId: i.itemId, paidAt: i.paidAt.toISOString(), amount: r2(perCheck(i)) })).filter((c) => c.amount !== 0);
    const paychecks = r2(checks.reduce((s, c) => s + c.amount, 0));
    const s = stored.get(id);
    const w2 = r2(box(s ?? computed.get(id), metric));
    // Social Security wages on the W-2 stop at the wage base; compare like with like.
    const paidCompare = metric === 'box3' ? Math.min(paychecks, await getSsWageBaseForYear(db, year).catch(() => 184_500)) : paychecks;
    out.push({ associateId: id, name: names.get(id) ?? 'Unknown', paychecks, w2, difference: r2(w2 - paidCompare), w2Source: s ? 'stored' : computed.has(id) ? 'computed' : 'none', checks });
  }
  return out.filter((p) => p.paychecks !== 0 || p.w2 !== 0).sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference) || a.name.localeCompare(b.name));
}
