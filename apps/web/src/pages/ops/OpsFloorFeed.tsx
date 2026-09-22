import { useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Camera,
  CheckCircle2,
  DoorOpen,
  Flag,
  Thermometer,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui/Badge';
import { FilterChip } from '@/components/ui/FilterBar';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { opsPhotoUrl, type OpsFeedEvent, type OpsFeedPhoto } from '@/lib/opsApi';
import { fmtAgo, fmtClock, fmtFull, OPS_TZ } from './opsTime';

/**
 * From the floor, and the floor feed.
 *
 * Both are the same record seen two ways — the photographs, and the
 * running narration of what got done. They used to be decoration: a
 * horizontal strip of thumbnails captioned with the CLIENT's name, and a
 * scrolling list with relative times, no way to narrow it, and no way to
 * get from a line to the shift it came from.
 *
 * Now each is a way in. Every line and every photograph names its
 * building, carries the time it happened, and opens the shift record it
 * belongs to — which is where "what happened" is actually answered.
 */

const PERIOD_LABEL: Record<string, string> = {
  MORNING: 'Morning',
  EVENING: 'Evening',
  CLOSING: 'Closing',
  OVERNIGHT: 'Overnight',
};

const KIND_ICON: Record<OpsFeedEvent['kind'], typeof Activity> = {
  task: CheckCircle2,
  temp: Thermometer,
  photo: Camera,
  open: DoorOpen,
  close: Flag,
};

const KINDS: { value: OpsFeedEvent['kind'] | 'all' | 'alerts'; label: string }[] = [
  { value: 'all', label: 'Everything' },
  { value: 'alerts', label: 'Alerts' },
  { value: 'temp', label: 'Temps' },
  { value: 'task', label: 'Tasks' },
  { value: 'photo', label: 'Photos' },
  { value: 'close', label: 'Closes' },
];

/** The photographs, as evidence rather than decoration. */
export function OpsPhotoWall({
  photos,
  loading,
  onOpenRecord,
}: {
  photos: OpsFeedPhoto[] | null;
  loading: boolean;
  onOpenRecord: (shiftId: string) => void;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">
          <Camera className="mr-1.5 inline h-4 w-4 text-gold" aria-hidden="true" />
          From the floor
          <span className="ml-2 text-2xs font-normal uppercase tracking-wider text-silver/50">
            photo evidence
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading && !photos ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="aspect-[4/3] rounded-lg" />
            ))}
          </div>
        ) : !photos || photos.length === 0 ? (
          // Previously this card unmounted itself when empty, so nobody
          // learned it existed or that a shift had photographed nothing.
          <EmptyState
            icon={Camera}
            title="No photos yet"
            description="Supervisors photograph the floor as they work the checklist — anything taken in this window appears here."
          />
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {photos.map((p) => (
              <li key={p.id} className="group">
                <a
                  href={opsPhotoUrl(p.id)}
                  target="_blank"
                  rel="noreferrer"
                  // The old name was the task title alone, so fourteen
                  // links all read "Check freezer temps".
                  aria-label={`Open the full photo: ${p.title}, ${p.store}, ${
                    PERIOD_LABEL[p.period] ?? p.period
                  } ${p.department}, ${fmtFull(p.at)} (opens in a new tab)`}
                  className="block overflow-hidden rounded-lg border border-navy-secondary focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
                >
                  <img
                    src={opsPhotoUrl(p.id)}
                    alt={`${p.title} at ${p.store}`}
                    loading="lazy"
                    className="aspect-[4/3] w-full object-cover transition-transform group-hover:scale-[1.03]"
                  />
                </a>
                <div className="mt-1.5 min-w-0">
                  <button
                    type="button"
                    onClick={() => onOpenRecord(p.shiftId)}
                    className="block max-w-full truncate text-left text-xs font-medium text-white hover:text-gold hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
                    aria-label={`Open the shift record for ${p.store}, ${
                      PERIOD_LABEL[p.period] ?? p.period
                    } ${p.department}`}
                  >
                    {p.store}
                  </button>
                  <div className="truncate text-2xs text-silver/70">{p.title}</div>
                  <div className="text-2xs tabular-nums text-silver/50" title={fmtFull(p.at)}>
                    {fmtClock(p.at)} · {fmtAgo(p.at)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** The narration: what got done, where, when — and a way into each one. */
export function OpsFloorFeed({
  events,
  generatedAt,
  hours,
  loading,
  failed,
  onOpenRecord,
}: {
  events: OpsFeedEvent[] | null;
  generatedAt: string | null;
  hours: number;
  loading: boolean;
  failed: boolean;
  onOpenRecord: (shiftId: string) => void;
}) {
  const [kind, setKind] = useState<(typeof KINDS)[number]['value']>('all');

  const shown = useMemo(() => {
    const all = events ?? [];
    if (kind === 'all') return all;
    if (kind === 'alerts') return all.filter((e) => e.alert);
    return all.filter((e) => e.kind === kind);
  }, [events, kind]);

  const alerts = (events ?? []).filter((e) => e.alert).length;

  return (
    <Card className="xl:sticky xl:top-4 xl:self-start">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">
          <Activity className="mr-1.5 inline h-4 w-4 text-gold" aria-hidden="true" />
          Floor feed
          <span className="ml-2 text-2xs font-normal uppercase tracking-wider text-silver/50">
            {generatedAt ? `as of ${fmtClock(generatedAt)}` : 'loading'}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div
          className="mb-2 flex flex-wrap items-center gap-1"
          role="group"
          aria-label="Filter the feed"
        >
          {KINDS.map((k) => (
            <FilterChip
              key={k.value}
              active={kind === k.value}
              onClick={() => setKind(k.value)}
            >
              {k.label}
              {k.value === 'alerts' && alerts > 0 && (
                <span className="ml-1 text-alert">{alerts}</span>
              )}
            </FilterChip>
          ))}
        </div>
        <p className="mb-2 text-2xs text-silver/50">
          Last {hours}h · times in {OPS_TZ.split('/')[1]?.replace('_', ' ')}
        </p>

        {loading && !events ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-12 rounded-md" />
            ))}
          </div>
        ) : failed ? (
          // Loading, failed and genuinely quiet used to render the same
          // sentence, so a broken feed looked like a calm floor.
          <p className="py-6 text-center text-sm text-alert">
            The feed could not be loaded. The board above is unaffected.
          </p>
        ) : shown.length === 0 ? (
          <p className="py-6 text-center text-sm text-silver">
            {kind === 'all'
              ? 'Quiet — completions, temperatures and photos appear here as they happen.'
              : 'Nothing of that kind in this window.'}
          </p>
        ) : (
          <ul
            tabIndex={0}
            role="region"
            aria-label="Floor feed, newest first"
            className="relative max-h-[560px] space-y-0 overflow-y-auto pr-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
          >
            {shown.map((e) => {
              const Icon = KIND_ICON[e.kind];
              return (
                <li
                  key={`${e.shiftId}-${e.kind}-${e.at}-${e.headline}`}
                  className="border-b border-navy-secondary/40 last:border-0"
                >
                  <button
                    type="button"
                    onClick={() => onOpenRecord(e.shiftId)}
                    aria-label={`${e.headline} — ${e.store}, ${
                      PERIOD_LABEL[e.period] ?? e.period
                    } ${e.department}, ${fmtFull(e.at)}. Open the shift record.`}
                    className="flex w-full items-start gap-2.5 rounded py-2 text-left transition-colors hover:bg-navy-secondary/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
                  >
                    <span
                      className={cn(
                        'mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full',
                        e.alert ? 'bg-alert/15 text-alert' : 'bg-navy-secondary/60 text-silver',
                      )}
                    >
                      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-white">{e.headline}</span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-2xs text-silver/70">
                        <span className="font-medium text-silver">{e.store}</span>
                        <span className="text-gold">{PERIOD_LABEL[e.period] ?? e.period}</span>
                        <span>{e.department}</span>
                        <span className="tabular-nums" title={fmtFull(e.at)}>
                          {fmtClock(e.at)} · {fmtAgo(e.at)}
                        </span>
                      </span>
                      {e.detail && (
                        <span
                          className={cn(
                            'mt-0.5 block truncate text-2xs',
                            e.alert ? 'text-alert' : 'text-silver/60',
                          )}
                        >
                          {e.detail}
                        </span>
                      )}
                    </span>
                    {e.alert && (
                      <Badge variant="destructive" size="sm" className="shrink-0">
                        <AlertTriangle className="mr-1 h-3 w-3" aria-hidden="true" />
                        alert
                      </Badge>
                    )}
                    {e.photoId && (
                      <img
                        src={opsPhotoUrl(e.photoId)}
                        alt=""
                        loading="lazy"
                        className="h-9 w-9 shrink-0 rounded object-cover"
                      />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
