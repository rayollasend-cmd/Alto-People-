import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { DirectoryEntry, SearchGroup } from '@alto-people/shared';
import { listDirectory } from './directoryApi';
import { universalSearch } from './searchApi';
import { useDebouncedValue } from './useDebouncedValue';

/**
 * Debounced people search for the command palette.
 *
 * Waits 250ms after the last keystroke before hitting the directory API.
 * The debounced term is part of the query key, so an old query's answer
 * can never clobber a newer one — React Query only ever hands back the
 * data for the key currently asked for.
 *
 * Results are intentionally NOT cleared while a new search is in flight
 * (placeholderData keeps the previous key's answer) so the palette list
 * doesn't jump while the user types; the previous matches stay visible
 * until fresher ones land.
 */
export function usePeopleSearch(query: string, enabled: boolean) {
  const q = useDebouncedValue(query.trim(), 250);
  const active = enabled && q.length >= 2;
  const search = useQuery({
    queryKey: ['palette', 'people', q],
    queryFn: () => listDirectory({ q }),
    enabled: active,
    staleTime: 30_000,
    retry: false,
    placeholderData: keepPreviousData,
    select: (res): DirectoryEntry[] => res.associates.slice(0, 5),
  });
  return {
    results: active ? (search.data ?? []) : [],
    isSearching: active && (search.isFetching || query.trim() !== q),
  };
}

/**
 * Universal search for the palette — one debounced request that returns
 * every record kind the caller may see, grouped. Same debounce and
 * previous-results-stay-visible behavior as the people search above.
 */
export function useUniversalSearch(query: string, enabled: boolean) {
  const q = useDebouncedValue(query.trim(), 250);
  const active = enabled && q.length >= 2;
  const search = useQuery({
    queryKey: ['palette', 'universal', q],
    queryFn: () => universalSearch(q),
    enabled: active,
    staleTime: 30_000,
    retry: false,
    placeholderData: keepPreviousData,
    select: (res): SearchGroup[] => res.groups,
  });
  return {
    groups: active ? (search.data ?? []) : [],
    isSearching: active && (search.isFetching || query.trim() !== q),
  };
}
