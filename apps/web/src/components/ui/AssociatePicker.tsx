import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { listDirectory } from '@/lib/directoryApi';
import { cn } from '@/lib/cn';
import { Input } from './Input';

export interface PickedAssociate {
  id: string;
  name: string;
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
  const [results, setResults] = useState<PickedAssociate[]>([]);
  const [open, setOpen] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);

  useEffect(() => {
    if (value || term.trim().length < 2) {
      setResults([]);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      // PERF: limit 8 — without it the server returned up to 1000 full
      // directory records per keystroke, 992 of which were discarded.
      listDirectory({ q: term.trim(), limit: 8 })
        .then((r) => {
          if (!live) return;
          setSearchFailed(false);
          setResults(
            r.associates.slice(0, 8).map((a) => ({
              id: a.id,
              name: `${a.firstName} ${a.lastName}`.trim(),
            })),
          );
          setOpen(true);
        })
        .catch(() => {
          if (!live) return;
          // A failed search must not masquerade as "no matches" — this
          // picker is embedded on a dozen pages and silently lied on all
          // of them when the directory call failed.
          setResults([]);
          setSearchFailed(true);
          setOpen(true);
        });
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [term, value]);

  if (value) {
    return (
      <div
        className={cn(
          'flex items-center justify-between rounded-md border border-navy-secondary bg-navy px-3 py-2 text-sm',
          className,
        )}
      >
        <span className="text-white">{value.name}</span>
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
              className="block w-full px-3 py-2 text-left text-sm text-silver hover:bg-navy-secondary hover:text-white"
              onClick={() => {
                onChange(r);
                setOpen(false);
              }}
            >
              {r.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
