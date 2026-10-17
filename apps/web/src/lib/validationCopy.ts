import type { TermKey } from '@alto-people/shared';

type Term = (key: TermKey) => string;

/**
 * Validation copy built from the tenant's words, so a hotel reads
 * "Pick a team member." where a staffing company reads "Pick an associate."
 * One builder, one sentence shape: every form that needs a person, a site
 * or a manager chosen says it the same way.
 */
export function pickOne(term: Term, key: 'worker' | 'site' | 'manager' = 'worker'): string {
  return `Pick ${withArticle(term(key).toLowerCase())}.`;
}

/** "an associate" / "a team member" / "a store" — the indefinite article by sound. */
export function withArticle(noun: string): string {
  const first = noun.trim().charAt(0).toLowerCase();
  return `${'aeiou'.includes(first) ? 'an' : 'a'} ${noun.trim()}`;
}
