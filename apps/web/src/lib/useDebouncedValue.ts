import { useEffect, useState } from 'react';

/**
 * The value as it stood `ms` ago, settled. A typeahead keyed on this fires
 * one query per pause rather than one per keystroke, and because the
 * debounced value is part of the query key, React Query dedupes and
 * caches each term on its own.
 */
export function useDebouncedValue<T>(value: T, ms = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}
