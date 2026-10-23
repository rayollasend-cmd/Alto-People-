import { apiFetch } from './api';

/**
 * Address suggestions for the address forms (GET /geo/address-suggest).
 *
 * A suggestion arrives taken apart — street line, city, state, ZIP — with
 * its point, so a pick fills the form's own boxes and a site's geofence
 * gets coordinates without anyone typing them.
 */
export interface SuggestedAddress {
  /** The headline — the street line, unit included when one was typed. */
  label: string;
  /** The whole address on one line. */
  address: string;
  line1: string | null;
  /** The unit typed with the street ("Apt 2"). */
  line2: string | null;
  city: string | null;
  /** USPS two-letter code. */
  state: string | null;
  zip: string | null;
  /** "Okaloosa County" — settles the time zone in a state that has two. */
  county: string | null;
  lat: number;
  lng: number;
  /** 'exact' found the building; 'approximate' placed it along the street. */
  precision: 'exact' | 'approximate';
}

export type AddressSuggestResponse =
  | { available: true; provider: string; outage: boolean; results: SuggestedAddress[] }
  /** No type-ahead provider: 'not_configured' (no geocoder) or 'no_typeahead' (Nominatim only). */
  | { available: false; reason: 'not_configured' | 'no_typeahead'; results: [] };

export const suggestAddresses = (q: string, near?: { lat: number; lng: number } | null, signal?: AbortSignal) =>
  apiFetch<AddressSuggestResponse>(
    `/geo/address-suggest?q=${encodeURIComponent(q)}${near ? `&near=${near.lat.toFixed(5)},${near.lng.toFixed(5)}` : ''}`,
    { signal },
  );
