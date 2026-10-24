/**
 * Its own module, not part of contracts.ts, because the web app's date
 * formatting (in the entry bundle) reads the labels: importing them from
 * contracts.ts pulled every schema, and zod, into the page every visitor
 * downloads first. contracts.ts re-exports both, so imports are unchanged.
 */

/**
 * Curated IANA timezones we support in the picker. US ones first (this is a
 * US-focused HR app), then a small set of common international ones so
 * remote / multinational employees aren't stuck. Keep this in sync with
 * the dropdown order on /settings.
 *
 * To add a timezone: append the IANA name AND a label here. The server
 * validates against this list — submitting an unknown TZ returns 400.
 */
export const SUPPORTED_TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'America/Toronto',
  'America/Mexico_City',
  'America/Sao_Paulo',
  'UTC',
  'Europe/London',
  'Europe/Paris',
  'Europe/Madrid',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
] as const;
export type SupportedTimezone = (typeof SUPPORTED_TIMEZONES)[number];

export const TIMEZONE_LABELS: Record<SupportedTimezone, string> = {
  'America/New_York': 'Eastern (New York)',
  'America/Chicago': 'Central (Chicago)',
  'America/Denver': 'Mountain (Denver)',
  'America/Phoenix': 'Mountain — no DST (Phoenix)',
  'America/Los_Angeles': 'Pacific (Los Angeles)',
  'America/Anchorage': 'Alaska (Anchorage)',
  'Pacific/Honolulu': 'Hawaii (Honolulu)',
  'America/Toronto': 'Eastern Canada (Toronto)',
  'America/Mexico_City': 'Mexico City',
  'America/Sao_Paulo': 'São Paulo',
  UTC: 'UTC',
  'Europe/London': 'London',
  'Europe/Paris': 'Paris',
  'Europe/Madrid': 'Madrid',
  'Asia/Kolkata': 'India (Kolkata)',
  'Asia/Singapore': 'Singapore',
  'Asia/Tokyo': 'Tokyo',
  'Australia/Sydney': 'Sydney',
};
