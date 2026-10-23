import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { MapPin } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/cn';
import { suggestAddresses, type SuggestedAddress } from '@/lib/geoApi';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import { Input, type InputProps } from './Input';

/**
 * The street-line box of an address form, with suggestions as you type.
 *
 * Pick one and the form's other boxes fill from it — city, state, ZIP, the
 * unit on line 2 — along with the point it came with (a site's geofence
 * starts there). The form owns its fields; this only says what was picked
 * (`onPick`), and `pickedFields` turns a pick into the four values.
 *
 * Production asks Mapbox. Where there is no type-ahead provider (dev
 * without a key, the tests, a deployment on Nominatim alone) the server
 * says so once and this is a plain text box from then on: no combobox
 * role, no message, nothing to explain. A provider outage is just as
 * quiet — the person types the address in, as they always could.
 *
 * Keyboard (combobox, list autocomplete): ↓ opens the list and walks it,
 * ↑ walks back, Enter takes the highlighted address, Escape closes the
 * list (and only the list — the dialog around it stays open), Tab leaves.
 * Enter with nothing highlighted is left to the form.
 */

/** Below this, every street matches and nothing helps (the server agrees). */
const MIN_CHARS = 4;
const NOTHING: { results: SuggestedAddress[]; provider: string | null } = { results: [], provider: null };

export interface AddressAutocompleteProps
  extends Omit<InputProps, 'value' | 'onChange' | 'role' | 'type'> {
  value: string;
  /** What the person typed. */
  onChange: (value: string) => void;
  /** An address taken from the list. */
  onPick: (address: SuggestedAddress) => void;
  /** Lean the suggestions toward here (a client's other store, say). */
  near?: { lat: number; lng: number } | null;
}

/**
 * What a pick puts in a form's boxes. A form with no line 2 (`line2:
 * false`) keeps the unit on the street line, where the mail carrier reads
 * it. A part the provider didn't name comes back empty rather than leaving
 * the last address's value behind.
 */
export function pickedFields(s: SuggestedAddress, opts: { line2?: boolean } = {}) {
  const street = s.line1 ?? s.label;
  const ownLine2 = opts.line2 !== false;
  return {
    line1: !ownLine2 && s.line2 ? `${street} ${s.line2}` : street,
    /** null: the pick had no unit — keep whatever line 2 says. */
    line2: ownLine2 ? s.line2 : null,
    city: s.city ?? '',
    state: s.state ?? '',
    zip: s.zip ?? '',
  };
}

/** "Destin, FL 32541" — the part of the address under the street line. */
function placeLine(s: SuggestedAddress): string {
  const place = [s.city, [s.state, s.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  if (place) return place;
  return s.address.startsWith(s.label) ? s.address.slice(s.label.length).replace(/^[\s,]+/, '') : s.address;
}

export const AddressAutocomplete = React.forwardRef<HTMLInputElement, AddressAutocompleteProps>(function AddressAutocomplete(
  { value, onChange, onPick, near, className, onKeyDown, onFocus, onBlur, autoComplete = 'address-line1', ...inputProps },
  ref,
) {
  const { t } = useI18n();
  const baseId = React.useId().replace(/:/g, '');
  const listId = `addr-list-${baseId}`;
  const optionId = (i: number) => `addr-opt-${baseId}-${i}`;
  // Only what the person types is looked up: a form opening on a saved
  // address, or the street line a pick just wrote, never sends a request.
  const [typed, setTyped] = React.useState(false);
  // The server said there is no type-ahead here: a plain box from now on.
  const [off, setOff] = React.useState(false);
  const [focused, setFocused] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState(-1);
  const [announce, setAnnounce] = React.useState('');
  const listRef = React.useRef<HTMLUListElement>(null);

  const term = value.trim();
  const debounced = useDebouncedValue(term, 250);
  const nearKey = near ? `${near.lat.toFixed(3)},${near.lng.toFixed(3)}` : '';
  // Only the settled text is looked up — never the text from before a
  // clear or a paste that the debounce hasn't caught up with yet.
  const fetchable = typed && !off && debounced.length >= MIN_CHARS && debounced === term;
  const search = useQuery({
    queryKey: ['geo', 'address-suggest', debounced, nearKey],
    queryFn: ({ signal }) => suggestAddresses(debounced, near, signal),
    enabled: fetchable,
    staleTime: 5 * 60_000,
    retry: false,
  });
  // The list on screen: the last answer, kept while the next keystroke is
  // looked up so it doesn't blink, gone once the text is too short.
  const [shown, setShown] = React.useState<{ results: SuggestedAddress[]; provider: string | null }>(NOTHING);
  const results = typed && !off && term.length >= MIN_CHARS ? shown.results : NOTHING.results;
  const provider = shown.provider;

  // A fresh answer for what's in the box opens the list (while the box has
  // focus) and says how many there are; an empty one closes it; "no
  // type-ahead here" turns this into a plain box for good.
  const settled = fetchable && search.isSuccess ? search.data : undefined;
  React.useEffect(() => {
    if (!settled) return;
    if (!settled.available) {
      setOff(true);
      setShown(NOTHING);
      setOpen(false);
      return;
    }
    const n = settled.results.length;
    setShown({ results: settled.results, provider: settled.provider });
    setActive(-1);
    setOpen(focused && n > 0);
    if (focused && n > 0) setAnnounce(n === 1 ? t('addr.foundOne') : t('addr.found', { n }));
    // `focused` is read, not followed: focusing again shouldn't re-announce.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled, t]);

  // Escape closes the list before the dialog around it hears the key: the
  // dialog listens on the document in the capture phase, so the list
  // listens one step earlier, on the window.
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      setOpen(false);
      setActive(-1);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  // Keep the highlighted address in view as the arrows walk the list.
  React.useEffect(() => {
    if (!open || active < 0) return;
    const el = document.getElementById(optionId(active));
    if (el && listRef.current?.contains(el)) el.scrollIntoView?.({ block: 'nearest' });
    // optionId is stable for the component's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, open]);

  const pick = (s: SuggestedAddress) => {
    setTyped(false);
    setShown(NOTHING);
    setOpen(false);
    setActive(-1);
    setAnnounce(t('addr.filled'));
    onPick(s);
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented || off) return;
    const n = results.length;
    switch (e.key) {
      case 'ArrowDown':
        if (n === 0) return;
        e.preventDefault();
        if (!open) {
          setOpen(true);
          setActive(0);
        } else setActive((a) => (a + 1) % n);
        break;
      case 'ArrowUp':
        if (!open || n === 0) return;
        e.preventDefault();
        setActive((a) => (a <= 0 ? n - 1 : a - 1));
        break;
      case 'Enter': {
        const s = open && active >= 0 ? results[active] : undefined;
        if (!s) return;
        e.preventDefault();
        pick(s);
        break;
      }
      case 'Tab':
        setOpen(false);
        break;
    }
  };

  const showList = open && !off && results.length > 0;
  const combobox = off
    ? {}
    : {
        role: 'combobox' as const,
        'aria-autocomplete': 'list' as const,
        'aria-expanded': showList,
        'aria-controls': showList ? listId : undefined,
        'aria-activedescendant': showList && active >= 0 ? optionId(active) : undefined,
      };

  return (
    <div className="relative">
      <Input
        ref={ref}
        {...inputProps}
        {...combobox}
        type="text"
        autoComplete={autoComplete}
        value={value}
        className={className}
        onChange={(e) => {
          setTyped(true);
          onChange(e.target.value);
        }}
        onKeyDown={onKey}
        onFocus={(e) => {
          setFocused(true);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          setOpen(false);
          onBlur?.(e);
        }}
      />
      {showList && (
        <div className="absolute inset-x-0 top-full z-50 mt-1 overflow-hidden rounded-lg border border-line bg-surface elev-2">
          <ul ref={listRef} id={listId} role="listbox" aria-label={t('addr.suggestions')} className="max-h-64 overflow-y-auto overscroll-contain p-1">
            {results.map((s, i) => (
              <li
                key={`${s.address}|${i}`}
                id={optionId(i)}
                role="option"
                aria-selected={i === active}
                // Keep focus in the box: a press on the list must not blur it shut first.
                onMouseDown={(e) => e.preventDefault()}
                onPointerMove={() => setActive(i)}
                onClick={() => pick(s)}
                className={cn(
                  'flex min-h-10 cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 coarse:min-h-11',
                  i === active ? 'bg-surface-raised' : '',
                )}
              >
                <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                  <span className="block text-sm text-ink">{s.label}</span>
                  <span className="block text-xs text-ink-muted">{placeLine(s)}</span>
                </span>
              </li>
            ))}
          </ul>
          {provider === 'mapbox' && (
            <p className="border-t border-line px-3 py-1 text-xs2 text-ink-muted">{t('addr.byMapbox')}</p>
          )}
        </div>
      )}
      <span className="sr-only" role="status" aria-live="polite">
        {announce}
      </span>
    </div>
  );
});
