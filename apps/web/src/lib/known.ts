/**
 * A label or badge for a value the server sent, read from a map keyed by
 * the values a screen knows. A value the server adds later reads as its own
 * words ("Pending review") instead of crashing the page — the way the
 * Integrations page went down when the API gained a provider kind.
 *
 *   const statusOf = (s: string) => known(STATUS, s, (k) => ({ label: enumWords(k), variant: 'outline' }));
 */
export function known<V>(map: Record<string, V>, key: string | null | undefined, fallback: (key: string) => V): V {
  const k = key ?? '';
  return Object.prototype.hasOwnProperty.call(map, k) ? map[k]! : fallback(k);
}

/** "PENDING_REVIEW" → "Pending review". */
export function enumWords(key: string): string {
  return key ? key.charAt(0).toUpperCase() + key.slice(1).toLowerCase().replace(/_/g, ' ') : '—';
}
