import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { listDirectory } from '@/lib/directoryApi';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import { cn } from '@/lib/cn';
import { associatePhotoUrl, personPhotoUrl } from '@/lib/photoUrl';
import { Avatar } from './Avatar';
import { Input } from './Input';

export interface PickedAssociate {
  id: string;
  name: string;
}

/** A search hit — the pick plus the directory's cache-busted photo, which
 *  stays inside the picker (onChange still hands back just {id, name}). */
interface PickerResult extends PickedAssociate {
  photoUrl: string | null;
}

/**
 * Directory typeahead that resolves to an associate {id, name}. Replaces
 * the raw-UUID-paste inputs that used to litter payroll forms. Debounced,
 * min 2 chars, top 8 matches.
 */
export function AssociatePicker({
  value,
  onChange,
  placeholder = 'Search associate…',
  className,
  id,
}: {
  value: PickedAssociate | null;
  onChange: (v: PickedAssociate | null) => void;
  placeholder?: string;
  /**
   * Forwarded to both the search input and the selected-value chip, so a
   * caller can match a toolbar's control height (the default Input is h-10).
   */
  className?: string;
  /** Applied to the search input so a <Field>/<label htmlFor> can bind. */
  id?: string;
}) {
  const [term, setTerm] = useState('');
  const [open, setOpen] = useState(false);
  // The photo of the row just picked, so the chip shows the same
  // cache-busted face; a value set from outside falls back to the id.
  const [pickedPhoto, setPickedPhoto] = useState<{ id: string; url: string | null } | null>(null);
  const debouncedTerm = useDebouncedValue(term.trim(), 250);
  const canSearch = !value && debouncedTerm.length >= 2;

  // PERF: limit 8 — without it the server returned up to 1000 full
  // directory records per keystroke, 992 of which were discarded.
  const search = useQuery({
    queryKey: ['directory', 'picker', debouncedTerm],
    queryFn: () => listDirectory({ q: debouncedTerm, limit: 8 }),
    enabled: canSearch,
    staleTime: 30_000,
    retry: false,
    select: (r): PickerResult[] =>
      r.associates.slice(0, 8).map((a) => ({
        id: a.id,
        name: `${a.firstName} ${a.lastName}`.trim(),
        photoUrl: a.photoUrl,
      })),
  });
  const results = canSearch ? (search.data ?? []) : [];
  // A failed search must not masquerade as "no matches" — this picker is
  // embedded on a dozen pages and silently lied on all of them when the
  // directory call failed.
  const searchFailed = canSearch && search.isError;
  // The list opens itself when an answer (or a failure) lands for the
  // current term; a pick closes it until the next answer.
  const lastShownFor = useRef<string | null>(null);
  useEffect(() => {
    if (!canSearch) {
      lastShownFor.current = null;
      return;
    }
    if (search.isPending) return;
    if (lastShownFor.current === debouncedTerm) return;
    lastShownFor.current = debouncedTerm;
    setOpen(true);
  }, [canSearch, debouncedTerm, search.isPending]);

  if (value) {
    return (
      <div
        className={cn(
          'flex items-center justify-between rounded-md border border-navy-secondary bg-navy px-3 py-2 text-sm',
          className,
        )}
      >
        <span className="flex min-w-0 items-center gap-2 text-white">
          <Avatar
            src={
              pickedPhoto?.id === value.id
                ? personPhotoUrl({ photoUrl: pickedPhoto.url, associateId: value.id })
                : associatePhotoUrl(value.id)
            }
            name={value.name}
            size="xs"
            className="-my-1"
          />
          <span className="truncate">{value.name}</span>
        </span>
        <button
          type="button"
          onClick={() => {
            onChange(null);
            setTerm('');
          }}
          className="text-silver/60 hover:text-white"
          aria-label="Clear associate"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="relative">
      <Input
        id={id}
        placeholder={placeholder}
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        onFocus={() => results.length > 0 && setOpen(true)}
        className={className}
      />
      {open && searchFailed && (
        <div className="absolute z-20 mt-1 w-full rounded-md border border-warning/40 bg-navy px-3 py-2 text-xs text-warning elev-2">
          Search unavailable — check your connection and keep typing to retry.
        </div>
      )}
      {open && !searchFailed && results.length > 0 && (
        <div className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-md border border-navy-secondary bg-navy elev-2">
          {results.map((r) => (
            <button
              key={r.id}
              type="button"
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-silver hover:bg-navy-secondary hover:text-white"
              onClick={() => {
                setPickedPhoto({ id: r.id, url: r.photoUrl });
                onChange({ id: r.id, name: r.name });
                setOpen(false);
              }}
            >
              <Avatar
                src={personPhotoUrl({ photoUrl: r.photoUrl, associateId: r.id })}
                name={r.name}
                size="xs"
                className="-my-1"
              />
              <span className="truncate">{r.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
