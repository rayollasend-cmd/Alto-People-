import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';

/**
 * Per-associate iCal feed tokens.
 *
 * Calendar clients (Google, Apple, Outlook) poll the feed URL on a schedule
 * with no credentials, so the token in the URL IS the authorization. We
 * mint a deterministic HMAC of the associate id with a server secret —
 * stable across requests so subscriptions keep working, but un-guessable
 * without the secret. Rotating CALENDAR_FEED_SECRET invalidates every
 * outstanding subscription in one move.
 */

function feedSecret(): string {
  return env.CALENDAR_FEED_SECRET ?? env.JWT_SECRET;
}

export function mintCalendarToken(associateId: string): string {
  return createHmac('sha256', feedSecret())
    .update(associateId, 'utf8')
    .digest('base64url');
}

/**
 * Returns the associateId if the token matches one. We HMAC the candidate
 * associateId rather than reversing the token (HMAC isn't reversible), so
 * the caller passes both in. Used by the route to confirm the path's
 * associateId+token pair are consistent before responding.
 */
export function verifyCalendarToken(
  associateId: string,
  candidate: string,
): boolean {
  const expected = mintCalendarToken(associateId);
  if (expected.length !== candidate.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(candidate));
}

/* ===== iCal serializer ================================================== */

interface IcsEvent {
  uid: string;
  startsAt: Date;
  endsAt: Date;
  summary: string;
  description?: string | null;
  location?: string | null;
  status?: 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED';
}

/** Format a Date as an iCal UTC timestamp: YYYYMMDDTHHMMSSZ. */
function fmtUtc(d: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

/**
 * Escape per RFC 5545 §3.3.11: backslash, semicolon, comma, newline.
 * Order matters — backslash first so we don't double-escape what we add.
 */
function escapeText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * Fold a content line at 75 octets per RFC 5545 §3.1. Continuations start
 * with a single space. Folding by char count is fine for ASCII; our shift
 * fields are ASCII (position, location, client name) so this is safe.
 */
function fold(line: string): string {
  if (line.length <= 75) return line;
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    const chunk = i === 0 ? line.slice(i, i + 75) : ' ' + line.slice(i, i + 74);
    out.push(chunk);
    i += i === 0 ? 75 : 74;
  }
  return out.join('\r\n');
}

export function buildIcs(opts: {
  calendarName: string;
  events: IcsEvent[];
  /** Stable iCal product id. */
  prodId?: string;
}): string {
  const now = fmtUtc(new Date());
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:-//Alto People//${opts.prodId ?? 'Schedule Feed'}//EN`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    fold(`X-WR-CALNAME:${escapeText(opts.calendarName)}`),
    'X-PUBLISHED-TTL:PT1H',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
  ];

  for (const ev of opts.events) {
    lines.push('BEGIN:VEVENT');
    lines.push(fold(`UID:${ev.uid}`));
    lines.push(`DTSTAMP:${now}`);
    lines.push(`DTSTART:${fmtUtc(ev.startsAt)}`);
    lines.push(`DTEND:${fmtUtc(ev.endsAt)}`);
    lines.push(fold(`SUMMARY:${escapeText(ev.summary)}`));
    if (ev.location) lines.push(fold(`LOCATION:${escapeText(ev.location)}`));
    if (ev.description) {
      lines.push(fold(`DESCRIPTION:${escapeText(ev.description)}`));
    }
    if (ev.status) lines.push(`STATUS:${ev.status}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  // RFC 5545 mandates CRLF line endings.
  return lines.join('\r\n') + '\r\n';
}
