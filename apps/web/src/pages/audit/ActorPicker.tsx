import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X } from '@/components/ui/icons';
import { getAuditActor, searchAuditActors, type AuditActor } from '@/lib/auditApi';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import { cn } from '@/lib/cn';
import { Input } from '@/components/ui/Input';

/**
 * The Actor filter (F500 G4): pick the person by name or email — the audit
 * table keys actors by account id, which nobody can type. The value is the
 * account id (kept in the URL); its name is looked up for the chip.
 */
export function ActorPicker({ value, onChange, className, id }: { value: string | null; onChange: (id: string | null) => void; className?: string; id?: string }) {
  const [term, setTerm] = useState('');
  const [open, setOpen] = useState(false);
  const debounced = useDebouncedValue(term.trim(), 250);
  const canSearch = !value && debounced.length >= 2;
  const search = useQuery({ queryKey: ['audit', 'actors', debounced], queryFn: () => searchAuditActors(debounced), enabled: canSearch, staleTime: 30_000, retry: false });
  const picked = useQuery({ queryKey: ['audit', 'actor', value], queryFn: () => getAuditActor(value!), enabled: !!value, staleTime: 5 * 60_000 });
  const results: AuditActor[] = canSearch ? (search.data?.actors ?? []) : [];
  const shownFor = useRef<string | null>(null);
  useEffect(() => {
    if (!canSearch || search.isPending || shownFor.current === debounced) return;
    shownFor.current = debounced;
    setOpen(true);
  }, [canSearch, debounced, search.isPending]);

  if (value) {
    const who = picked.data?.actors[0];
    return (
      <div className={cn('flex h-8 min-w-0 items-center justify-between gap-2 rounded-md border border-line bg-surface px-2.5 text-xs', className)}>
        <span className="min-w-0 truncate text-ink" title={who?.email}>
          Actor: {who ? who.name : picked.isPending ? '…' : 'an account'}
        </span>
        <button type="button" onClick={() => onChange(null)} className="text-ink-muted hover:text-ink" aria-label="Clear the actor">
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    );
  }
  return (
    <div className={cn('relative min-w-0', className)}>
      <Input
        id={id}
        className="h-8 text-xs"
        placeholder="Actor: name or email…"
        aria-label="Actor"
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        onFocus={() => results.length > 0 && setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
      />
      {open && canSearch && search.isError && (
        <div className="absolute z-20 mt-1 w-full rounded-md border border-warning/40 bg-surface px-3 py-2 text-xs text-warning elev-2">Search isn’t available right now.</div>
      )}
      {open && canSearch && !search.isError && !search.isPending && results.length === 0 && (
        <div className="absolute z-20 mt-1 w-full rounded-md border border-line bg-surface px-3 py-2 text-xs text-ink-muted elev-2">No account matches “{debounced}”.</div>
      )}
      {open && results.length > 0 && (
        <ul className="absolute z-20 mt-1 max-h-56 w-full min-w-[16rem] overflow-auto rounded-md border border-line bg-surface elev-2" role="listbox" aria-label="Matching accounts">
          {results.map((r) => (
            <li key={r.id} role="option" aria-selected={false}>
              <button
                type="button"
                className="flex w-full flex-col px-3 py-2 text-left text-sm hover:bg-surface-raised"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange(r.id);
                  setTerm('');
                  setOpen(false);
                }}
              >
                <span className="truncate text-ink">{r.name}</span>
                {r.name !== r.email && <span className="truncate text-xs text-ink-muted">{r.email}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
