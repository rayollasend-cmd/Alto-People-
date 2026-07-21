import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { listDirectory } from '@/lib/directoryApi';
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
}: {
  value: PickedAssociate | null;
  onChange: (v: PickedAssociate | null) => void;
  placeholder?: string;
}) {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<PickedAssociate[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (value || term.trim().length < 2) {
      setResults([]);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      listDirectory({ q: term.trim() })
        .then((r) => {
          if (!live) return;
          setResults(
            r.associates.slice(0, 8).map((a) => ({
              id: a.id,
              name: `${a.firstName} ${a.lastName}`.trim(),
            })),
          );
          setOpen(true);
        })
        .catch(() => setResults([]));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [term, value]);

  if (value) {
    return (
      <div className="flex items-center justify-between rounded-md border border-navy-secondary bg-navy px-3 py-2 text-sm">
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
        placeholder={placeholder}
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        onFocus={() => results.length > 0 && setOpen(true)}
      />
      {open && results.length > 0 && (
        <div className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-md border border-navy-secondary bg-navy shadow-lg">
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
