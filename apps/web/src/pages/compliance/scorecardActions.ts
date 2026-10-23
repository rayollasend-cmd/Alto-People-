import type { ScorecardAction, ScorecardSeverity } from '@alto-people/shared';

/** One row of the Open actions list: a signal with several people missing
 *  it (folded), or a one-off action. */
export type ActionEntry =
  | { kind: 'group'; key: string; label: string; link: string | null; severity: ScorecardSeverity; actions: ScorecardAction[] }
  | { kind: 'single'; action: ScorecardAction };

/** Rows shown per page; a folded signal counts as one row. */
export const ACTIONS_PAGE = 25;

/**
 * Fold the list by signal: ten people missing a background check are one
 * row ("Background check on file — 10 people"), opened to list them. A
 * signal with a single person stays a plain row. Order follows the list
 * (critical first), each group placed where its first action falls.
 */
export function groupScorecardActions(actions: ScorecardAction[]): ActionEntry[] {
  const counts = new Map<string, number>();
  for (const a of actions) if (a.group) counts.set(a.group.key, (counts.get(a.group.key) ?? 0) + 1);
  const entries: ActionEntry[] = [];
  const byKey = new Map<string, Extract<ActionEntry, { kind: 'group' }>>();
  const rank: Record<ScorecardSeverity, number> = { critical: 0, warn: 1, ok: 2 };
  for (const a of actions) {
    const g = a.group;
    if (!g || (counts.get(g.key) ?? 0) < 2) {
      entries.push({ kind: 'single', action: a });
      continue;
    }
    let entry = byKey.get(g.key);
    if (!entry) {
      entry = { kind: 'group', key: g.key, label: g.label, link: g.link, severity: a.severity, actions: [] };
      byKey.set(g.key, entry);
      entries.push(entry);
    }
    entry.actions.push(a);
    if (rank[a.severity] < rank[entry.severity]) entry.severity = a.severity;
  }
  return entries;
}

