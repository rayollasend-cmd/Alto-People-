import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Crosshair, Home, Loader2, MapPin, Search, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { hapticConfirm } from '@/lib/haptics';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/Button';
import { searchRideAddresses, whereAmI, type AddressSuggestion } from '@/lib/transportApi';
import { LazyLiveMap } from '@/components/transport/LazyLiveMap';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';

/**
 * WHERE THE VAN SHOULD MEET THEM.
 *
 * This replaced a <select> of known places plus a free-text box, and the
 * free-text box was the accuracy hole. What someone types is only an
 * address if a geocoder agrees: anything else was accepted, saved without
 * coordinates, and turned up at 6am in the driver's stop list as a row
 * with no pin and a street name to puzzle over. The rider was never told.
 *
 * So nothing here is typed in the end — it is picked. Their saved places
 * and the company's own stops answer instantly with no network at all,
 * and anything else comes back from the geocoder as suggestions that
 * each carry their own coordinates. Whatever they choose is mappable
 * because it was mappable before they chose it.
 *
 * Three ways in, in the order people actually use them:
 *   1. Somewhere they have been before — one tap, no typing.
 *   2. Where they are standing — the phone knows, reverse-geocoded.
 *   3. Search — debounced, biased toward the store they are booking to,
 *      because "1500 nw 7" means the one down the road.
 */

export type Pickup =
  | { kind: 'stop'; id: string; name: string }
  | { kind: 'place'; id: string; label: string; address: string }
  | {
      kind: 'address';
      address: string;
      lat: number;
      lng: number;
      precision: 'exact' | 'approximate';
    };

/** What to show once something is chosen. */
export function pickupText(p: Pickup): string {
  if (p.kind === 'stop') return p.name;
  if (p.kind === 'place') return p.address;
  return p.address;
}

/** Mapbox and Nominatim are both quick; this is about not billing every keystroke. */
const DEBOUNCE_MS = 300;
const MIN_QUERY = 4;

interface Row {
  key: string;
  icon: typeof MapPin;
  title: string;
  detail?: string;
  badge?: string;
  onPick: () => void;
}

/**
 * Move the pin to the door.
 *
 * Only ever shown for a match the provider graded approximate — it found
 * the street but interpolated along it rather than finding the building.
 * On a long road, or an apartment complex with one gate, that is the
 * difference between a two-minute wait and a missed van. An exact match
 * skips this entirely, which is most of them.
 */
function ConfirmPinDialog({
  pickup,
  onCancel,
  onConfirm,
}: {
  pickup: Extract<Pickup, { kind: 'address' }>;
  onCancel: () => void;
  onConfirm: (p: Pickup) => void;
}) {
  const { t } = useI18n();
  const [point, setPoint] = useState({ lat: pickup.lat, lng: pickup.lng });
  // Whether they have actually moved it. The marker shifting is the real
  // feedback, but a thumb covers the marker at the moment of the tap — so
  // something outside the map has to say the tap landed.
  const [moved, setMoved] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('ride.pinTitle')}</DialogTitle>
          <DialogDescription>{t('ride.pinBody')}</DialogDescription>
        </DialogHeader>
        {/* This is the one screen where a few pixels are a few metres of
            walking, in the dark, at the end of a shift — so it takes the
            height it can get. Capped, and short of the sheet, because a
            map that pushes "This is the spot" below the fold is worse
            than a small one: they can aim but not commit. */}
        <div className="h-[38vh] max-h-[22rem] min-h-[15rem] overflow-hidden rounded-lg border border-navy-secondary sm:h-72">
          <LazyLiveMap
            ariaLabel={t('ride.pinTitle')}
            className="h-full w-full rounded-none"
            markers={[{ id: 'pickup', kind: 'stop', lat: point.lat, lng: point.lng, label: pickup.address }]}
            // `controls` left at its default ON, where the trip map turns
            // it off. Pinch-to-zoom is a two-handed gesture and this is a
            // one-handed moment — holding a phone in a parking lot, aiming
            // at a door. The driver's pin dialog keeps them for the same
            // reason. It also matters more here than anywhere: the fit
            // opens wide (see LiveMap's single-marker branch), so +/- is
            // the only way in without a second hand.
            maxZoom={17}
            fitKey={`${pickup.address}`}
            onPick={(p) => {
              setPoint(p);
              setMoved(true);
              hapticConfirm();
            }}
          />
        </div>
        {/* The street they are pinning ON. Was text-xs at silver/70 — the
            smallest type at the lowest contrast, on the one line that says
            whether this is even the right road. */}
        <p className="flex items-start gap-1.5 text-sm text-silver">
          <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-gold" aria-hidden="true" />
          <span className="min-w-0">{pickup.address}</span>
        </p>
        {moved && (
          <p role="status" className="flex items-center gap-1.5 text-sm text-success">
            <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
            {t('ride.pinMoved')}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            {t('ride.pinBack')}
          </Button>
          <Button onClick={() => onConfirm({ ...pickup, ...point, precision: 'exact' })}>
            <Check className="h-4 w-4" />
            {t('ride.pinConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PickupPicker({
  value,
  onChange,
  stops,
  places,
  locationId,
  label,
  invalid,
}: {
  value: Pickup | null;
  onChange: (p: Pickup | null) => void;
  stops: Array<{ id: string; name: string; address: string }>;
  places: Array<{ id: string; label: string; address: string }>;
  locationId: string | null;
  label: string;
  invalid?: boolean;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<AddressSuggestion[]>([]);
  const [searching, setSearching] = useState(false);
  const [locating, setLocating] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  // An approximate match is held here until they have moved the pin.
  const [confirming, setConfirming] = useState<Extract<Pickup, { kind: 'address' }> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = 'pickup-suggestions';

  // Out-of-order guard: a slow response for "150" must never overwrite the
  // results for "1500 nw", which is the classic autocomplete flicker.
  const seq = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (q.length < MIN_QUERY) {
      setResults([]);
      setSearching(false);
      return;
    }
    const mine = ++seq.current;
    setSearching(true);
    const timer = window.setTimeout(async () => {
      try {
        const { results: found } = await searchRideAddresses(q, locationId);
        if (seq.current === mine) setResults(found);
      } catch {
        if (seq.current === mine) setResults([]);
      } finally {
        if (seq.current === mine) setSearching(false);
      }
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query, locationId]);

  const q = query.trim().toLowerCase();
  const match = (s: string) => s.toLowerCase().includes(q);

  // Saved places and stops are already in hand, so they answer while the
  // network call is still in flight — which is why they are listed first.
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const p of places) {
      if (q && !match(p.label) && !match(p.address)) continue;
      out.push({
        key: `place:${p.id}`,
        icon: Home,
        title: p.label,
        detail: p.address,
        badge: t('ride.pickSaved'),
        onPick: () => choose({ kind: 'place', id: p.id, label: p.label, address: p.address }),
      });
    }
    for (const s of stops) {
      if (q && !match(s.name) && !match(s.address)) continue;
      out.push({
        key: `stop:${s.id}`,
        icon: MapPin,
        title: s.name,
        detail: s.address,
        badge: t('ride.pickStop'),
        onPick: () => choose({ kind: 'stop', id: s.id, name: s.name }),
      });
    }
    for (const r of results) {
      out.push({
        key: `addr:${r.lat},${r.lng},${r.address}`,
        icon: Search,
        title: r.label,
        detail: r.address,
        onPick: () =>
          choose({
            kind: 'address',
            address: r.address,
            lat: r.lat,
            lng: r.lng,
            precision: r.precision,
          }),
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [places, stops, results, q, t]);

  useEffect(() => setActive(0), [rows.length]);

  const choose = (p: Pickup) => {
    // The provider found the street but guessed along it — on a long road
    // that is a missed van, so the pin gets moved before this counts.
    if (p.kind === 'address' && p.precision === 'approximate') {
      setConfirming(p);
      setOpen(false);
      return;
    }
    onChange(p);
    setOpen(false);
    setQuery('');
    setResults([]);
    setNote(null);
  };

  const useMyLocation = () => {
    if (!navigator.geolocation) {
      setNote(t('ride.locateFailed'));
      return;
    }
    setLocating(true);
    setNote(null);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        try {
          const { address } = await whereAmI({ lat, lng });
          // Always 'exact': this point came from the phone's GPS, which is
          // a better fix than any geocoder will give us, so there is
          // nothing for the pin step to improve. A missing street name
          // only costs us the label — the coordinates still land the van
          // on them, so they get shown as a coordinate rather than being
          // sent round a confirmation they don't need.
          choose({
            kind: 'address',
            address: address ?? `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
            lat,
            lng,
            precision: 'exact',
          });
        } catch {
          setNote(t('ride.locateFailed'));
        } finally {
          setLocating(false);
        }
      },
      () => {
        setLocating(false);
        setNote(t('ride.locateDenied'));
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
    );
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open || rows.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (i + 1) % rows.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (i - 1 + rows.length) % rows.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      rows[active]?.onPick();
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  const pinDialog = confirming ? (
    <ConfirmPinDialog
      pickup={confirming}
      onCancel={() => {
        setConfirming(null);
        setOpen(true);
      }}
      onConfirm={(p) => {
        setConfirming(null);
        onChange(p);
        setQuery('');
        setResults([]);
      }}
    />
  ) : null;

  /* Chosen: show it plainly and get out of the way. */
  if (value) {
    return (
      <div className="space-y-1.5">
        {pinDialog}
        <span className="block text-sm text-silver">{label}</span>
        <div className="flex items-start gap-2.5 rounded-lg border border-gold/40 bg-gold/[0.06] px-3 py-2.5">
          <Check className="mt-0.5 h-4 w-4 shrink-0 text-gold" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-white">
              {value.kind === 'place' ? value.label : value.kind === 'stop' ? value.name : value.address}
            </span>
            {value.kind !== 'stop' && value.kind === 'place' && (
              <span className="block truncate text-xs text-silver">{value.address}</span>
            )}
            {value.kind === 'address' && value.precision === 'approximate' && (
              // Not an error — the geocoder found the street but not the
              // building. Worth saying, because on a long road that is the
              // difference between a two-minute wait and a missed van.
              <span className="mt-0.5 block text-xs text-warning">{t('ride.pickApprox')}</span>
            )}
          </span>
          <button
            type="button"
            onClick={() => {
              onChange(null);
              setOpen(true);
              window.setTimeout(() => inputRef.current?.focus(), 0);
            }}
            // The undo for a wrong pickup, and it was a 45x20px word. On a
            // finger it goes to the 44px floor — missing it taps the chip,
            // which does nothing, so a miss reads as "the app is stuck".
            className="inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-xs text-silver hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright coarse:min-h-11 coarse:px-3 coarse:text-sm"
          >
            {t('ride.pickChange')}
          </button>
        </div>
      </div>
    );
  }

  /* Choosing. */
  return (
    <div className="space-y-1.5">
      {pinDialog}
      <label htmlFor="pickup-search" className="block text-sm text-silver">
        {label} <span className="text-alert">*</span>
      </label>
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-silver/60"
          aria-hidden="true"
        />
        <input
          id="pickup-search"
          ref={inputRef}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && rows[active] ? `pickup-opt-${active}` : undefined}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={t('ride.pickPlaceholder')}
          autoComplete="off"
          className={cn(
            // text-base, not text-sm: below 16px iOS zooms the whole page
            // on focus and the form has to be pinched back out.
            'h-11 w-full rounded-md border bg-navy-secondary/40 pl-9 pr-9 text-base text-white placeholder:text-silver/50',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
            // Room for the clear button once a finger widens it.
            'coarse:pr-12',
            invalid ? 'border-alert' : 'border-navy-secondary',
          )}
        />
        {query && (
          <button
            type="button"
            onClick={() => {
              setQuery('');
              inputRef.current?.focus();
            }}
            aria-label={t('common.clear')}
            // A 24px target for the one control that undoes a mistyped
            // address; on a finger it fills the field's height instead.
            className="absolute right-1 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded text-silver/60 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright coarse:h-11 coarse:w-11"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <Button type="button" variant="ghost" size="sm" onClick={useMyLocation} loading={locating} disabled={locating}>
        <Crosshair className="h-3.5 w-3.5" />
        {locating ? t('ride.locating') : t('ride.useWhereIAm')}
      </Button>

      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label={label}
          // overscroll-contain: flicking past the end of the suggestions
          // used to hand the fling to the booking sheet behind it, which
          // scrolled the whole form away mid-choice.
          className="max-h-64 overflow-y-auto overscroll-contain rounded-lg border border-navy-secondary bg-navy"
        >
          {rows.map((r, i) => {
            const Icon = r.icon;
            return (
              <li key={r.key}>
                <button
                  type="button"
                  id={`pickup-opt-${i}`}
                  role="option"
                  aria-selected={i === active}
                  onMouseEnter={() => setActive(i)}
                  onClick={r.onPick}
                  className={cn(
                    // A row with no second line lands at 40px; the tap
                    // target has to be the whole row, not the text in it.
                    'flex w-full items-start gap-2.5 px-3 py-2.5 text-left coarse:min-h-11',
                    'focus:outline-none',
                    i === active ? 'bg-navy-secondary/60' : 'hover:bg-navy-secondary/30',
                  )}
                >
                  <Icon className="mt-0.5 h-4 w-4 shrink-0 text-gold" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-white">{r.title}</span>
                    {r.detail && <span className="block truncate text-xs text-silver/70">{r.detail}</span>}
                  </span>
                  {r.badge && (
                    <span className="shrink-0 rounded-full bg-navy-secondary px-1.5 py-0.5 text-2xs text-silver">
                      {r.badge}
                    </span>
                  )}
                </button>
              </li>
            );
          })}

          {searching && (
            <li className="flex items-center gap-2 px-3 py-2.5 text-xs text-silver">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              {t('ride.pickSearching')}
            </li>
          )}
          {!searching && rows.length === 0 && (
            <li className="px-3 py-3 text-xs text-silver">
              {query.trim().length < MIN_QUERY ? t('ride.pickKeepTyping') : t('ride.pickNoMatch')}
            </li>
          )}
        </ul>
      )}

      {note && (
        // The only thing said when the phone refuses a location fix, read
        // outdoors at night — text-sm, not the 12px meta tier.
        <p role="alert" className="text-sm text-warning">
          {note}
        </p>
      )}
    </div>
  );
}
