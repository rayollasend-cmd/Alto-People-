import { createHash } from 'node:crypto';
import type { MinorBand, ResolvedRules, RuleLevel, RuleParams, RuleSetDef } from './params.js';

/**
 * Brief 2-2 step 1 — resolution (report §4.1).
 *
 *   For a site on a work date: per jurisdiction or owner, the set in force
 *   is the latest effectiveFrom on or before the date (highest version on a
 *   tie; RETIRED never). Layers apply federal → state → city → tenant →
 *   site. Within a family each layer sets only the fields it names and the
 *   most specific wins, except the protective combiners the law requires:
 *
 *     - minimum wage: the highest rate any layer sets;
 *     - overtime thresholds: the lowest any layer sets (null = "this layer
 *       has none", never "remove the federal one"); multipliers: the highest;
 *     - minors: every band of every layer applies (the strictest limit binds).
 *
 *   An override can therefore add protection but never take it away below
 *   the law, whatever a tenant enters.
 */

const LEVEL_ORDER: Record<RuleLevel, number> = { FEDERAL: 0, STATE: 1, CITY: 2, TENANT: 3, SITE: 4 };

export const setLabel = (s: RuleSetDef) => `${s.jurisdiction} ${s.effectiveFrom} v${s.version}`;

/** The set in force for each key on `date` (YYYY-MM-DD), ordered by level. */
export function setsInForce(candidates: readonly RuleSetDef[], date: string): RuleSetDef[] {
  const best = new Map<string, RuleSetDef>();
  for (const s of candidates) {
    if (s.status === 'RETIRED' || s.effectiveFrom > date) continue;
    const cur = best.get(s.jurisdiction);
    if (!cur || s.effectiveFrom > cur.effectiveFrom || (s.effectiveFrom === cur.effectiveFrom && s.version > cur.version)) best.set(s.jurisdiction, s);
  }
  return [...best.values()].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
}

type Fam = Record<string, unknown>;

const LOWER_WINS = new Set(['overtime.weeklyThreshold', 'overtime.dailyThreshold', 'overtime.dailyDoubleThreshold']);
const HIGHER_WINS = new Set(['overtime.weeklyMultiplier', 'overtime.dailyMultiplier', 'overtime.doubleMultiplier', 'minimumWage.rateCents']);

export function resolveRules(layers: readonly RuleSetDef[]): ResolvedRules {
  const params: Record<string, Fam> = {};
  const origin: Record<string, string> = {};
  const bands: MinorBand[] = [];
  for (const layer of layers) {
    const label = setLabel(layer);
    for (const [family, block] of Object.entries(layer.params) as Array<[keyof RuleParams, Fam | undefined]>) {
      if (!block) continue;
      if (family === 'minors') {
        const m = block as NonNullable<RuleParams['minors']>;
        for (const b of m.bands ?? []) bands.push(b);
        if (m.bands?.length) origin['minors.bands'] = origin['minors.bands'] ? `${origin['minors.bands']}, ${label}` : label;
        continue;
      }
      const into = (params[family] ??= {});
      for (const [field, value] of Object.entries(block)) {
        if (value === undefined) continue;
        const key = `${family}.${field}`;
        const prev = into[field];
        if (LOWER_WINS.has(key)) {
          if (value === null) {
            if (prev === undefined) {
              into[field] = null;
              origin[key] = label;
            }
            continue;
          }
          if (prev === undefined || prev === null || (value as number) < (prev as number)) {
            into[field] = value;
            origin[key] = label;
          }
          continue;
        }
        if (HIGHER_WINS.has(key)) {
          if (prev === undefined || (value as number) > (prev as number)) {
            into[field] = value;
            origin[key] = label;
          }
          continue;
        }
        into[field] = value;
        origin[key] = label;
      }
    }
  }
  if (bands.length) params.minors = { bands, severity: 'block' };
  const labels = layers.map(setLabel);
  return {
    params: params as RuleParams,
    layers: labels,
    fingerprint: createHash('sha256').update(labels.join('|')).digest('hex').slice(0, 16),
    payable: layers.length > 0 && layers.every((l) => l.status === 'ACTIVE'),
    origin,
  };
}

/** Resolution for a site on a date from a pool of sets (packs plus the tenant's and site's overrides). */
export function resolveFor(pool: readonly RuleSetDef[], jurisdictions: readonly string[], overrideKeys: readonly string[], date: string): ResolvedRules {
  const wanted = new Set([...jurisdictions, ...overrideKeys]);
  return resolveRules(setsInForce(pool.filter((s) => wanted.has(s.jurisdiction)), date));
}
