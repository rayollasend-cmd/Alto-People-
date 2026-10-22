import { z } from 'zod';

/**
 * The new-business pipeline (Clients → Pipeline).
 *
 * A prospect walks LEAD → CONTACTED → PROPOSAL → VERBAL and ends WON (it
 * became a client) or LOST (with a reason). Its value is what it would bill
 * in a year — estimated weekly hours × estimated bill rate × 52 — and the
 * pipeline's headline is that value weighted by how likely each stage is to
 * close. The API and the page read the weights from here so the number on
 * the page and the number in its tooltip can never disagree.
 */

export const PROSPECT_STAGES = ['LEAD', 'CONTACTED', 'PROPOSAL', 'VERBAL', 'WON', 'LOST'] as const;
export type ProspectStageKey = (typeof PROSPECT_STAGES)[number];

/** The working stages, left to right on the board. */
export const OPEN_PROSPECT_STAGES = ['LEAD', 'CONTACTED', 'PROPOSAL', 'VERBAL'] as const;
export type OpenProspectStage = (typeof OPEN_PROSPECT_STAGES)[number];

/** The chance each working stage closes, as a fraction. */
export const PROSPECT_STAGE_WEIGHTS: Record<OpenProspectStage, number> = {
  LEAD: 0.1,
  CONTACTED: 0.25,
  PROPOSAL: 0.5,
  VERBAL: 0.8,
};

export const PROSPECT_STAGE_LABELS: Record<ProspectStageKey, string> = {
  LEAD: 'Lead',
  CONTACTED: 'Contacted',
  PROPOSAL: 'Proposal',
  VERBAL: 'Verbal yes',
  WON: 'Won',
  LOST: 'Lost',
};

export const WEEKS_PER_YEAR = 52;

export function isOpenProspectStage(stage: string): stage is OpenProspectStage {
  return (OPEN_PROSPECT_STAGES as readonly string[]).includes(stage);
}

/** What the prospect would bill in a year; null when hours or rate is unknown. */
export function prospectAnnualValue(estWeeklyHours: number | null | undefined, estBillRate: number | null | undefined): number | null {
  if (estWeeklyHours == null || estBillRate == null) return null;
  if (!Number.isFinite(estWeeklyHours) || !Number.isFinite(estBillRate)) return null;
  return Math.round(estWeeklyHours * estBillRate * WEEKS_PER_YEAR * 100) / 100;
}

/** The annual value weighted by the stage's chance; null outside the working stages or when unpriced. */
export function prospectWeightedValue(stage: string, annualValue: number | null): number | null {
  if (annualValue == null || !isOpenProspectStage(stage)) return null;
  return Math.round(annualValue * PROSPECT_STAGE_WEIGHTS[stage] * 100) / 100;
}

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

/** Create or edit a prospect. A move to LOST needs a reason (checked by the API). */
export const ProspectInputSchema = z.object({
  name: z.string().trim().min(2).max(120),
  stage: z.enum(PROSPECT_STAGES).optional(),
  ownerUserId: z.string().uuid().nullable().optional(),
  contactName: optionalText(120),
  contactEmail: z.string().trim().email().max(254).nullable().optional().or(z.literal('').transform(() => null)),
  estWeeklyHours: z.number().int().nonnegative().max(100_000).nullable().optional(),
  estBillRate: z.number().nonnegative().max(10_000).nullable().optional(),
  expectedStartDate: dateOnly.nullable().optional(),
  notes: optionalText(2_000),
  lostReason: optionalText(500),
  wonClientId: z.string().uuid().nullable().optional(),
});
export type ProspectInput = z.infer<typeof ProspectInputSchema>;

export const ProspectUpdateSchema = ProspectInputSchema.partial();
export type ProspectUpdate = z.infer<typeof ProspectUpdateSchema>;

export interface ProspectRow {
  id: string;
  name: string;
  stage: ProspectStageKey;
  ownerUserId: string | null;
  ownerName: string | null;
  contactName: string | null;
  contactEmail: string | null;
  estWeeklyHours: number | null;
  /** Money: present only for callers who can read client money. */
  estBillRate?: number | null;
  /** hours × rate × 52. Money, as above. */
  annualValue?: number | null;
  /** annualValue × the stage weight (working stages only). Money, as above. */
  weightedValue?: number | null;
  expectedStartDate: string | null;
  stageChangedAt: string;
  daysInStage: number;
  lostReason: string | null;
  wonClientId: string | null;
  wonClientName: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProspectTotals {
  /** Prospects in a working stage. */
  open: number;
  /** Working prospects missing hours or rate, so not in the money totals. */
  unpriced: number;
  /** Sum of weighted annual value over the working stages. Money. */
  weightedValue?: number;
  /** Sum of annual value over the working stages, unweighted. Money. */
  unweightedValue?: number;
  /** Prospects (not lost) whose expected start is today or within the next 90 days. */
  startsNext90: number;
  /** Of those, how many are already won. */
  startsNext90Won: number;
}

export interface ProspectListResponse {
  /** Today on the company's calendar (YYYY-MM-DD) — the day the totals were counted from. */
  today: string;
  prospects: ProspectRow[];
  totals: ProspectTotals;
  weights: Record<OpenProspectStage, number>;
  /** False when money fields were left out for this caller. */
  money: boolean;
  /** True when the caller may add, edit and move prospects. */
  canWrite: boolean;
}

export interface ProspectOwner {
  id: string;
  name: string;
}
