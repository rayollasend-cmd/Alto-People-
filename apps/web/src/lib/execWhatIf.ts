/**
 * "What if we lose this client / win this one" — the executive's scenario
 * on the same numbers the hero shows. Pure arithmetic over the executive
 * summary so the card can answer without a round trip, and so it can be
 * tested.
 *
 * The baseline is the last four complete weeks: hours and estimated
 * billing per client from the store league, margin at the summary's
 * standard rates. Losing a client removes its weekly hours; winning one is
 * stores × hours per store-week at a bill and pay rate.
 */

export interface WhatIfRates {
  payRate: number;
  billRate: number;
  burdenPct: number;
  overheadPerHour: number;
}

export interface WhatIfLeagueRow {
  clientId: string;
  clientName: string;
  hours: number;
  otHours: number;
  estBilled: number;
  estMargin: number;
}

export interface WhatIfBaseline {
  /** Per client over the league window (four weeks), summed from the rows. */
  clients: Array<{ clientId: string; clientName: string; weeklyHours: number; weeklyBilled: number; weeklyMargin: number; activeAssociates: number }>;
  weeklyBilled: number;
  weeklyMargin: number;
  weeklyHours: number;
  headcount: number;
}

const LEAGUE_WEEKS = 4;

export function whatIfBaseline(
  league: WhatIfLeagueRow[],
  clients: Array<{ clientId: string; clientName: string; activeAssociates: number }>,
): WhatIfBaseline {
  const byClient = new Map<string, { clientName: string; hours: number; billed: number; margin: number }>();
  for (const r of league) {
    const e = byClient.get(r.clientId) ?? { clientName: r.clientName, hours: 0, billed: 0, margin: 0 };
    e.hours += r.hours;
    e.billed += r.estBilled;
    e.margin += r.estMargin;
    byClient.set(r.clientId, e);
  }
  const heads = new Map(clients.map((c) => [c.clientId, c]));
  const rows = [...byClient.entries()].map(([clientId, e]) => ({
    clientId,
    clientName: e.clientName,
    weeklyHours: e.hours / LEAGUE_WEEKS,
    weeklyBilled: e.billed / LEAGUE_WEEKS,
    weeklyMargin: e.margin / LEAGUE_WEEKS,
    activeAssociates: heads.get(clientId)?.activeAssociates ?? 0,
  }));
  // Clients with people but no worked time yet still exist for the picker.
  for (const c of clients) {
    if (!byClient.has(c.clientId)) rows.push({ clientId: c.clientId, clientName: c.clientName, weeklyHours: 0, weeklyBilled: 0, weeklyMargin: 0, activeAssociates: c.activeAssociates });
  }
  rows.sort((a, b) => b.weeklyBilled - a.weeklyBilled);
  return {
    clients: rows,
    weeklyBilled: rows.reduce((n, r) => n + r.weeklyBilled, 0),
    weeklyMargin: rows.reduce((n, r) => n + r.weeklyMargin, 0),
    weeklyHours: rows.reduce((n, r) => n + r.weeklyHours, 0),
    headcount: rows.reduce((n, r) => n + r.activeAssociates, 0),
  };
}

export interface WhatIfOutcome {
  /** Weekly deltas, and the same annualised. */
  weeklyBilled: number;
  weeklyMargin: number;
  annualMargin: number;
  weeklyHours: number;
  headcount: number;
  /** The largest client's share of billing after the change. */
  topSharePct: number | null;
  topClientName: string | null;
  /** The share before, for the arrow. */
  topShareBeforePct: number | null;
}

function concentration(rows: Array<{ clientName: string; weeklyBilled: number }>): { pct: number | null; name: string | null } {
  const total = rows.reduce((n, r) => n + r.weeklyBilled, 0);
  if (total <= 0) return { pct: null, name: null };
  const top = rows.reduce((best, r) => (r.weeklyBilled > best.weeklyBilled ? r : best), rows[0]!);
  return { pct: Math.round((top.weeklyBilled / total) * 1000) / 10, name: top.clientName };
}

/** Lose this client: its hours, billing, margin and people go. */
export function whatIfLose(base: WhatIfBaseline, clientId: string): WhatIfOutcome {
  const c = base.clients.find((r) => r.clientId === clientId);
  if (!c) return { weeklyBilled: 0, weeklyMargin: 0, annualMargin: 0, weeklyHours: 0, headcount: 0, topSharePct: null, topClientName: null, topShareBeforePct: null };
  const after = base.clients.filter((r) => r.clientId !== clientId);
  const before = concentration(base.clients);
  const next = concentration(after);
  return {
    weeklyBilled: -c.weeklyBilled,
    weeklyMargin: -c.weeklyMargin,
    annualMargin: -c.weeklyMargin * 52,
    weeklyHours: -c.weeklyHours,
    headcount: -c.activeAssociates,
    topSharePct: next.pct,
    topClientName: next.name,
    topShareBeforePct: before.pct,
  };
}

export interface WinInput {
  name: string;
  stores: number;
  hoursPerStoreWeek: number;
  billRate: number;
  payRate: number;
}

/** Win this one: stores × hours at a bill and pay rate, burdened like everything else. */
export function whatIfWin(base: WhatIfBaseline, rates: WhatIfRates, input: WinInput): WhatIfOutcome {
  const hours = Math.max(0, input.stores) * Math.max(0, input.hoursPerStoreWeek);
  const billed = hours * input.billRate;
  const cost = hours * input.payRate * (1 + rates.burdenPct / 100) + hours * rates.overheadPerHour;
  const margin = billed - cost;
  // One person covers about thirty-two hours a week in this workforce.
  const heads = Math.ceil(hours / 32);
  const before = concentration(base.clients);
  const next = concentration([...base.clients, { clientName: input.name || 'New client', weeklyBilled: billed }]);
  return {
    weeklyBilled: billed,
    weeklyMargin: margin,
    annualMargin: margin * 52,
    weeklyHours: hours,
    headcount: heads,
    topSharePct: next.pct,
    topClientName: next.name,
    topShareBeforePct: before.pct,
  };
}

/**
 * The executive rate model: a year's margin at a bill and pay rate on the
 * recent weeks' average volume. Overtime costs what the server's labor-rules
 * engine priced it at — `premiumHours`, the straight-time hours the 1.5× and
 * 2× multipliers add, as the paycheck pays them; an older API without it
 * falls back to half an hour per overtime hour.
 */
export function rateWhatIfAnnualMargin(
  weeks: Array<{ workedHours: number; otHours: number; premiumHours?: number }>,
  bill: number,
  pay: number,
  rates: Pick<WhatIfRates, 'burdenPct' | 'overheadPerHour'>,
): number {
  if (weeks.length === 0) return 0;
  const hours = weeks.reduce((n, w) => n + w.workedHours, 0) / weeks.length;
  const premium = weeks.reduce((n, w) => n + (w.premiumHours ?? w.otHours * 0.5), 0) / weeks.length;
  const billed = (hours + premium) * bill;
  const cost = (hours + premium) * pay * (1 + rates.burdenPct / 100) + hours * rates.overheadPerHour;
  return (billed - cost) * 52;
}
