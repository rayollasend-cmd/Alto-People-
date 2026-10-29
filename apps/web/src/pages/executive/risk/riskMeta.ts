import type { ExecRisk, ExecRiskCategory, ExecRiskSeverity } from '@alto-people/shared';

/** The register's vocabulary: severities high → low, the five areas a risk belongs to. */
export const SEVERITIES: readonly ExecRiskSeverity[] = ['high', 'medium', 'low'];
export const CATEGORIES: readonly ExecRiskCategory[] = ['client', 'compliance', 'people', 'cash', 'operations'];
export const CATEGORY_FILTERS = ['all', ...CATEGORIES] as const;
export type CategoryFilter = (typeof CATEGORY_FILTERS)[number];

/** The areas a company has: one with no clients (a hotel) has no client area — unless a client risk is somehow on its register. */
export function categoriesFor(clients: boolean, risks: ExecRisk[]): ExecRiskCategory[] {
  return CATEGORIES.filter((c) => clients || c !== 'client' || risks.some((r) => r.category === 'client'));
}

export const SEVERITY_RANK: Record<ExecRiskSeverity, number> = { high: 3, medium: 2, low: 1 };

/**
 * The severity chip from the palette's scales — a 100 wash, 200 edge, 800
 * ink: high is negative, medium caution, low the neutral family (a low
 * risk is on the register, not an alarm).
 */
export const SEVERITY_CHIP: Record<ExecRiskSeverity, string> = {
  high: 'bg-negative-100 text-negative-800 border border-negative-200',
  medium: 'bg-caution-100 text-caution-800 border border-caution-200',
  low: 'bg-neutral-100 text-neutral-800 border border-neutral-200',
};

export const SEVERITY_DOT: Record<ExecRiskSeverity, string> = {
  high: 'bg-negative-700',
  medium: 'bg-caution-700',
  low: 'bg-neutral-600',
};

/** Rising is worse, easing is better, steady and new are neither. */
export const TREND_TEXT: Record<ExecRisk['trend'], string> = {
  rising: 'text-negative-800',
  easing: 'text-positive-800',
  steady: 'text-ink-muted',
  new: 'text-ink-muted',
};

export function countBy<K extends string>(risks: ExecRisk[], key: (r: ExecRisk) => K, keys: readonly K[]): Record<K, number> {
  const out = Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
  for (const r of risks) out[key(r)] = (out[key(r)] ?? 0) + 1;
  return out;
}
