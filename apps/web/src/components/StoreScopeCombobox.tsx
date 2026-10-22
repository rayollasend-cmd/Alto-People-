import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/cn';
import { shortStoreName, type StoreScopeClient } from '@/lib/storeScope';

/**
 * The store scope as a searchable list — the top bar's picker once there
 * are more clients than a row of buttons can hold, and below xl at any
 * count. A native <select> of 300 names is a scroll, not a choice; this one
 * filters as you type.
 *
 * Keyboard: Enter, Space or ↓ on the button opens it with the search
 * focused; ↑/↓ (Home/End) walk the list, Enter picks, Escape closes and
 * returns to the button, Tab leaves. "All clients" is always first and the
 * current scope is marked.
 */

/** Clients whose name (or short store name) contains every word typed. */
export function matchClients(clients: readonly StoreScopeClient[], query: string): StoreScopeClient[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...clients];
  return clients.filter((c) => {
    const hay = c.name.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

interface Props {
  clients: readonly StoreScopeClient[];
  clientId: string;
  onChange: (id: string) => void;
  className?: string;
  'data-testid'?: string;
}

export function StoreScopeCombobox({ clients, clientId, onChange, className, 'data-testid': testId }: Props) {
  const { t } = useI18n();
  const baseId = useId().replace(/:/g, '');
  const listId = `store-scope-list-${baseId}`;
  const optionId = (i: number) => `store-scope-opt-${baseId}-${i}`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const options = useMemo<StoreScopeClient[]>(
    () => [{ id: '', name: t('nav.allClients') }, ...matchClients(clients, query)],
    [clients, query, t],
  );
  const current = clients.find((c) => c.id === clientId);

  const openList = () => {
    setQuery('');
    const at = clientId ? clients.findIndex((c) => c.id === clientId) + 1 : 0;
    setActive(Math.max(0, at));
    setOpen(true);
  };
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };
  const pick = (id: string) => {
    onChange(id);
    close(true);
  };

  // The search takes focus as the list opens.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // A press anywhere else closes it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  // Keep the active option in view as the arrows walk a long list.
  useEffect(() => {
    if (!open) return;
    const el = document.getElementById(optionId(active));
    if (el && listRef.current?.contains(el)) el.scrollIntoView?.({ block: 'nearest' });
    // optionId is stable for the component's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, open]);

  const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openList();
    }
  };

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const last = options.length - 1;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActive((a) => Math.min(last, a + 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActive((a) => Math.max(0, a - 1));
        break;
      case 'Home':
        e.preventDefault();
        setActive(0);
        break;
      case 'End':
        e.preventDefault();
        setActive(last);
        break;
      case 'Enter': {
        e.preventDefault();
        const o = options[active];
        if (o) pick(o.id);
        break;
      }
      case 'Escape':
        e.preventDefault();
        close(true);
        break;
      case 'Tab':
        setOpen(false);
        break;
    }
  };

  const matches = options.length - 1;
  return (
    <div ref={rootRef} className={cn('relative', className)} data-testid={testId}>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-label={t('top.storeScope')}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => (open ? close(false) : openList())}
        onKeyDown={onTriggerKey}
        title={current?.name}
        className={cn(
          'inline-flex h-8 max-w-[18rem] items-center gap-1.5 rounded-md border border-navy-secondary bg-navy-secondary/40 pl-2.5 pr-2 text-xs text-ink transition-colors',
          'hover:border-silver/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright coarse:h-11 coarse:text-base',
          open && 'border-gold',
        )}
      >
        <span className="min-w-0 truncate">{current ? shortStoreName(current.name) : t('nav.allClients')}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-line bg-surface p-1.5 elev-2">
          <div className="relative mb-1.5">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-muted" aria-hidden="true" />
            <input
              ref={inputRef}
              type="search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                // Typing points at the first client that matches, not at "All clients".
                setActive(e.target.value.trim() ? 1 : 0);
              }}
              onKeyDown={onSearchKey}
              aria-label={t('top.findClient')}
              placeholder={t('top.findClient')}
              aria-controls={listId}
              aria-activedescendant={options[active] ? optionId(active) : undefined}
              aria-autocomplete="list"
              autoComplete="off"
              className="h-9 w-full rounded-md border border-line bg-surface-sunken pl-8 pr-2 text-sm text-ink placeholder:text-ink-subtle focus:border-gold focus:outline-none coarse:h-11 coarse:text-base"
            />
          </div>
          <ul ref={listRef} id={listId} role="listbox" aria-label={t('top.storeScope')} className="max-h-72 overflow-y-auto overscroll-contain">
            {options.map((o, i) => {
              const selected = o.id === clientId;
              return (
                <li
                  key={o.id || 'all'}
                  id={optionId(i)}
                  role="option"
                  aria-selected={selected}
                  onPointerMove={() => setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(o.id)}
                  className={cn(
                    'flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm coarse:min-h-11',
                    i === active ? 'bg-surface-raised text-ink' : 'text-ink-muted',
                    i === 0 && 'border-b border-line',
                  )}
                  title={o.name}
                >
                  <Check className={cn('h-3.5 w-3.5 shrink-0', selected ? 'text-accent' : 'invisible')} aria-hidden="true" />
                  <span className={cn('min-w-0 flex-1 line-clamp-2 [overflow-wrap:anywhere]', selected && 'font-medium text-ink')}>{o.name}</span>
                  {selected && <span className="sr-only"> ({t('top.currentScope')})</span>}
                </li>
              );
            })}
            {matches === 0 && query.trim() && (
              <li role="presentation" className="px-2 py-2 text-xs2 text-ink-muted">
                {t('top.noClientMatch', { q: query.trim() })}
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
