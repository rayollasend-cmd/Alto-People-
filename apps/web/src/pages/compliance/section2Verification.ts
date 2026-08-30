import type { I9DocumentList } from '@alto-people/shared';
import type { I9DocumentListItem } from '@/lib/i9Api';

/**
 * Section 2 verification rules shared by the two verifier surfaces — the
 * Compliance I-9 drawer (I9Tab) and the inline verifier in the onboarding
 * application drawer (ApplicationDetail's I9Card). One implementation so
 * the auto-picked list / pre-checked docs / minimum-count rules can't
 * drift between them.
 */

/** Federal minimum: List A needs one document, Lists B + C need two. */
export function minDocsForSection2List(list: I9DocumentList): number {
  return list === 'LIST_A' ? 1 : 2;
}

/**
 * Pre-select the list the associate's classified uploads support — a
 * passport pre-picks List A, license + SSN card pre-pick B+C. Unclassified
 * (pre-catalog) docs suggest nothing; HR still decides. Returns the docs
 * the classifier already matched to that list as `preChecked` so HR
 * adjusts the picks instead of re-selecting what the system identified.
 * Missing-blob docs stay unpicked: their checkbox is disabled and they
 * can't have been inspected.
 */
export function autoDetectSection2(docs: I9DocumentListItem[]): {
  documentList: I9DocumentList;
  preChecked: string[];
} | null {
  const usable = docs.filter((d) => d.status !== 'REJECTED');
  let auto: I9DocumentList | null = null;
  if (usable.some((d) => d.i9List === 'A')) {
    auto = 'LIST_A';
  } else if (
    usable.some((d) => d.i9List === 'B') &&
    usable.some((d) => d.i9List === 'C')
  ) {
    auto = 'LIST_B_AND_C';
  }
  if (!auto) return null;
  const wanted = auto === 'LIST_A' ? ['A'] : ['B', 'C'];
  return {
    documentList: auto,
    preChecked: usable
      .filter((d) => d.fileAvailable && d.i9List && wanted.includes(d.i9List))
      .map((d) => d.id),
  };
}

/**
 * `?return=` handed over by the application drawer's "Open Section 2
 * verifier" link. Only same-origin app paths are honored — anything not
 * starting with a single '/' (absolute URLs, protocol-relative '//host')
 * is dropped so the param can't become an open redirect.
 */
export function sanitizeReturnPath(raw: string | null): string | null {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return null;
  return raw;
}
