import { useEffect, useRef, useState } from 'react';
import type { DirectoryEntry, SearchGroup } from '@alto-people/shared';
import { listDirectory } from './directoryApi';
import { universalSearch } from './searchApi';

/**
 * Debounced people search for the command palette.
 *
 * Waits 250ms after the last keystroke before hitting the directory API,
 * and guards against out-of-order responses with a monotonically
 * increasing sequence number — a slow response for an old query can
 * never clobber the results of a newer one.
 *
 * Results are intentionally NOT cleared while a new search is in flight
 * so the palette list doesn't jump while the user types; the previous
 * matches stay visible until fresher ones land.
 */
export function usePeopleSearch(query: string, enabled: boolean) {
  const [results, setResults] = useState<DirectoryEntry[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  // Bumped on every effect run; a response only commits if its ticket
  // still matches. Bumping on disable/short-query also invalidates any
  // request that is still in flight.
  const seqRef = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (!enabled || q.length < 2) {
      seqRef.current += 1;
      setResults([]);
      setIsSearching(false);
      return;
    }

    const seq = ++seqRef.current;
    setIsSearching(true);
    const timer = setTimeout(() => {
      listDirectory({ q })
        .then((res) => {
          if (seq !== seqRef.current) return; // stale — ignore
          setResults(res.associates.slice(0, 5));
          setIsSearching(false);
        })
        .catch(() => {
          if (seq !== seqRef.current) return;
          setResults([]);
          setIsSearching(false);
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [query, enabled]);

  return { results, isSearching };
}

/**
 * Universal search for the palette — one debounced request that returns
 * every record kind the caller may see, grouped. Same debounce and
 * out-of-order guard as the people search above; results likewise stay
 * on screen while a refinement is in flight.
 */
export function useUniversalSearch(query: string, enabled: boolean) {
  const [groups, setGroups] = useState<SearchGroup[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const seqRef = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (!enabled || q.length < 2) {
      seqRef.current += 1;
      setGroups([]);
      setIsSearching(false);
      return;
    }
    const seq = ++seqRef.current;
    setIsSearching(true);
    const timer = setTimeout(() => {
      universalSearch(q)
        .then((res) => {
          if (seq !== seqRef.current) return;
          setGroups(res.groups);
          setIsSearching(false);
        })
        .catch(() => {
          if (seq !== seqRef.current) return;
          setGroups([]);
          setIsSearching(false);
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [query, enabled]);

  return { groups, isSearching };
}
