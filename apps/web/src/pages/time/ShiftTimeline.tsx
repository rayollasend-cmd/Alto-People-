import { Coffee, LogIn, LogOut, Play } from 'lucide-react';
import type { TimeEntry } from '@alto-people/shared';
import { browserTimeZone, fmtDateTz, tzAbbrev } from '@/lib/format';
import { cn } from '@/lib/cn';
import { fmtPunchTime, formatHM, punchDayOffset } from './punchFormat';

/**
 * The shift, told in the order it happened.
 *
 * Reviewers approve a SEQUENCE of punches — clocked in, out for break, back
 * from break, clocked out — but the queue used to scatter that story across
 * grid cells and a detached "Breaks" box, leaving the reviewer to reassemble
 * it in their head (the top user complaint about the approval queue). This
 * renders the shift the way workforce tools present it: a proportional bar
 * (worked time in gold, breaks carved out), the chronological punch list
 * underneath, and one plain-English totals line showing how gross − breaks
 * becomes the paid figure.
 */

interface BreakWindow {
  id: string;
  type: string;
  startMs: number;
  endMs: number;
  open: boolean;
}

const breakLabel = (type: string): string =>
  type === 'MEAL' ? 'meal break' : type === 'REST' ? 'rest break' : 'break';

export function ShiftTimeline({ entry }: { entry: TimeEntry }) {
  const tz = entry.locationTimezone ?? null;
  const startMs = new Date(entry.clockInAt).getTime();
  // ACTIVE entries have no clock-out; the server computes minutesElapsed to
  // "now", so the bar's right edge is the moment the list was fetched.
  const endMs = entry.clockOutAt
    ? new Date(entry.clockOutAt).getTime()
    : startMs + entry.minutesElapsed * 60_000;
  const spanMs = Math.max(endMs - startMs, 60_000);
  const stillClocked = !entry.clockOutAt;

  // Clamp breaks into the shift window and sort chronologically. An open
  // break (no end punch yet) runs to the edge of the bar.
  const breaks: BreakWindow[] = (entry.breaks ?? [])
    .map((b) => ({
      id: b.id,
      type: b.type,
      startMs: new Date(b.startedAt).getTime(),
      endMs: b.endedAt ? new Date(b.endedAt).getTime() : endMs,
      open: !b.endedAt,
    }))
    .filter((b) => b.endMs > startMs && b.startMs < endMs)
    .sort((a, b) => a.startMs - b.startMs)
    .map((b) => ({
      ...b,
      startMs: Math.max(b.startMs, startMs),
      endMs: Math.min(b.endMs, endMs),
    }));

  // Bar geometry: gold spans for worked stretches over a muted track, so
  // breaks appear as visible gaps rather than a legend to decode.
  const pct = (ms: number) => ((ms - startMs) / spanMs) * 100;
  const worked: Array<{ from: number; to: number }> = [];
  let cursor = startMs;
  for (const b of breaks) {
    if (b.startMs > cursor) worked.push({ from: cursor, to: b.startMs });
    cursor = Math.max(cursor, b.endMs);
  }
  if (cursor < endMs) worked.push({ from: cursor, to: endMs });

  const netMin = entry.netMinutes ?? entry.minutesElapsed;
  const breakMin = Math.max(0, entry.minutesElapsed - netMin);

  // "+1d" whenever a punch lands on a later site-local calendar day than
  // the clock-in — overnight shifts stop reading as time travel.
  const daySuffix = (iso: string): string => {
    const off = punchDayOffset(entry.clockInAt, iso, tz);
    return off > 0 ? ` +${off}d` : '';
  };

  return (
    <div className="rounded-md border border-navy-secondary bg-navy-secondary/30 p-3">
      <div className="mb-2.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-2xs uppercase tracking-widest text-silver">
          {fmtDateTz(entry.clockInAt, tz ?? undefined)}
          {tz && tz !== browserTimeZone() && (
            <span className="text-silver/60"> · site time ({tzAbbrev(tz, entry.clockInAt)})</span>
          )}
        </span>
        <span className="text-sm tabular-nums text-silver">
          {breakMin > 0 ? (
            <>
              {formatHM(entry.minutesElapsed)} on site − {formatHM(breakMin)} break
              {' = '}
              <span className="font-medium text-white">{formatHM(netMin)} paid</span>
            </>
          ) : (
            <>
              <span className="font-medium text-white">{formatHM(netMin)}</span>
              {stillClocked ? ' so far' : ' worked'} · no breaks
            </>
          )}
        </span>
      </div>

      {/* Proportional bar: gold = on the clock, gaps = breaks. */}
      <div className="relative h-2.5 overflow-hidden rounded-full bg-navy-secondary">
        {worked.map((w) => (
          <div
            key={w.from}
            className="absolute inset-y-0 bg-gold/90"
            style={{ left: `${pct(w.from)}%`, width: `${Math.max(pct(w.to) - pct(w.from), 0.5)}%` }}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-2xs tabular-nums text-silver/70">
        <span>{fmtPunchTime(entry.clockInAt, tz)}</span>
        <span>
          {stillClocked
            ? 'now'
            : `${fmtPunchTime(entry.clockOutAt!, tz)}${daySuffix(entry.clockOutAt!)}`}
        </span>
      </div>

      {/* The punch sequence, one event per line, in the order it happened. */}
      <ol className="mt-3 space-y-1.5 text-sm">
        <PunchEvent icon={<LogIn className="h-3.5 w-3.5 text-gold" />} label="Clocked in">
          {fmtPunchTime(entry.clockInAt, tz)}
        </PunchEvent>
        {breaks.map((b) => (
          <li key={b.id} className="space-y-1.5">
            <PunchEvent
              as="div"
              icon={<Coffee className="h-3.5 w-3.5 text-silver" />}
              label={`Out for ${breakLabel(b.type)}`}
            >
              {fmtPunchTime(new Date(b.startMs).toISOString(), tz)}
              {daySuffix(new Date(b.startMs).toISOString())}
            </PunchEvent>
            {b.open ? (
              <PunchEvent
                as="div"
                icon={<Play className="h-3.5 w-3.5 text-warning" />}
                label="Still on break"
                muted
              >
                {formatHM(Math.round((b.endMs - b.startMs) / 60_000))} so far
              </PunchEvent>
            ) : (
              <PunchEvent
                as="div"
                icon={<Play className="h-3.5 w-3.5 text-gold" />}
                label="Back from break"
                detail={formatHM(Math.round((b.endMs - b.startMs) / 60_000))}
              >
                {fmtPunchTime(new Date(b.endMs).toISOString(), tz)}
                {daySuffix(new Date(b.endMs).toISOString())}
              </PunchEvent>
            )}
          </li>
        ))}
        {stillClocked ? (
          <PunchEvent
            icon={
              <span className="relative flex h-2 w-2 mx-[3px]">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success/60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
              </span>
            }
            label="Still on the clock"
            muted
          >
            {formatHM(entry.minutesElapsed)} elapsed
          </PunchEvent>
        ) : (
          <PunchEvent icon={<LogOut className="h-3.5 w-3.5 text-gold" />} label="Clocked out">
            {fmtPunchTime(entry.clockOutAt!, tz)}
            {daySuffix(entry.clockOutAt!)}
          </PunchEvent>
        )}
      </ol>
    </div>
  );
}

function PunchEvent({
  icon,
  label,
  detail,
  muted,
  as = 'li',
  children,
}: {
  icon: React.ReactNode;
  label: string;
  /** Small right-aligned annotation, e.g. the break's duration. */
  detail?: string;
  muted?: boolean;
  as?: 'li' | 'div';
  children: React.ReactNode;
}) {
  const Tag = as;
  return (
    <Tag className="flex items-center gap-2.5">
      <span className="flex w-4 shrink-0 items-center justify-center">{icon}</span>
      <span className={cn('flex-1 truncate', muted ? 'text-silver/80' : 'text-white')}>
        {label}
      </span>
      <span className="tabular-nums text-silver">
        {children}
        {detail && <span className="text-silver/60"> · {detail}</span>}
      </span>
    </Tag>
  );
}
