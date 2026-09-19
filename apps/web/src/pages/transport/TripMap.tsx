import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Crosshair, Maximize2, X } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/cn';
import type { GeoPoint, MyLiveRide, Ride } from '@/lib/transportApi';
import { LazyLiveMap, type MapMarker } from '@/components/transport/LazyLiveMap';

/**
 * The rider's trip on the map — the ride-hailing screen, at every stage:
 *
 *   finding a driver  the pickup pulsing (radar) and a gentle arc to where
 *                     they're headed
 *   van confirmed     the same trip, the pickup marked as theirs
 *   on the way        the van gliding in, a bold line flowing from it to
 *                     their pickup, the rest of the trip dashed
 *   here              close in on the van at their pickup
 *   on board          the van and a flowing line on to the store (or home)
 *
 * Their own pickup only — never another rider's stop. Tap the expand
 * button for the map full screen; the crosshair fits the trip again.
 */

export type TripStage = 'FINDING' | 'CONFIRMED' | 'ON_THE_WAY' | 'HERE' | 'ON_BOARD';

export function tripStage(ride: Ride, live: MyLiveRide | null): TripStage {
  if (ride.status === 'BOARDED' || live?.status === 'BOARDED') return 'ON_BOARD';
  if (ride.vanArrivedAt || live?.vanArrivedAt) return 'HERE';
  if (ride.run?.status === 'ACTIVE' || live?.runStatus === 'ACTIVE') return 'ON_THE_WAY';
  if (ride.run || live?.van) return 'CONFIRMED';
  return 'FINDING';
}

const pt = (p: GeoPoint): [number, number] => [p.lng, p.lat];

/** A gentle arc between two points — a planned trip reads as a trip, not
 *  as a road it isn't (there's no turn-by-turn routing behind it). */
export function arc(a: GeoPoint, b: GeoPoint, bend = 0.18, n = 40): Array<[number, number]> {
  const cx = (a.lng + b.lng) / 2 - (b.lat - a.lat) * bend;
  const cy = (a.lat + b.lat) / 2 + (b.lng - a.lng) * bend;
  const out: Array<[number, number]> = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push([u * u * a.lng + 2 * u * t * cx + t * t * b.lng, u * u * a.lat + 2 * u * t * cy + t * t * b.lat]);
  }
  return out;
}

export interface TripGeometry {
  markers: MapMarker[];
  route?: Array<[number, number]>;
  path?: Array<[number, number]>;
  maxZoom: number;
}

export function tripGeometry(stage: TripStage, live: MyLiveRide, vanLabel: string): TripGeometry {
  const toWork = live.direction === 'TO_WORK';
  const pickup = live.pickup.point;
  const dest = live.destination.point;
  const van = live.position && (stage === 'ON_THE_WAY' || stage === 'HERE' || stage === 'ON_BOARD') ? live.position : null;
  const markers: MapMarker[] = [];
  if (van) markers.push({ id: 'van', kind: 'van', ...van, label: vanLabel, stale: live.stale, highlight: true });
  if (pickup && stage !== 'ON_BOARD') {
    markers.push({
      id: 'pickup',
      kind: toWork ? 'home' : 'store',
      ...pickup,
      label: live.pickup.label,
      highlight: true,
      pulse: stage === 'FINDING',
    });
  }
  if (dest && stage !== 'HERE') markers.push({ id: 'dest', kind: toWork ? 'store' : 'home', ...dest, label: live.destination.label });

  if (stage === 'HERE') return { markers, maxZoom: 16 };
  if (stage === 'ON_BOARD') return { markers, path: van && dest ? [pt(van), pt(dest)] : undefined, maxZoom: 15 };
  const trip = pickup && dest ? arc(pickup, dest) : undefined;
  if (stage === 'ON_THE_WAY' && van && pickup) return { markers, path: [pt(van), pt(pickup)], route: trip, maxZoom: 15 };
  return { markers, route: trip, maxZoom: 14 };
}

export function TripMap({
  stage,
  live,
  vanLabel,
  className,
  overlay,
}: {
  stage: TripStage;
  live: MyLiveRide;
  vanLabel: string;
  className?: string;
  /** What rides along at the foot of the full-screen map. */
  overlay?: React.ReactNode;
}) {
  const { t } = useI18n();
  const [full, setFull] = useState(false);
  const [recenter, setRecenter] = useState(0);
  const geo = useMemo(() => tripGeometry(stage, live, vanLabel), [stage, live, vanLabel]);
  const fresh = !!live.position && !live.stale && (stage === 'ON_THE_WAY' || stage === 'ON_BOARD' || stage === 'HERE');
  if (geo.markers.length === 0) return null;

  const chip = fresh ? (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-midnight/85 px-2.5 py-1 text-2xs font-semibold uppercase tracking-wider text-white shadow backdrop-blur">
      <span className="relative flex h-2 w-2" aria-hidden="true">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-70 motion-reduce:hidden" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
      </span>
      {t('ride.mapLive')}
    </span>
  ) : stage === 'FINDING' || stage === 'CONFIRMED' ? (
    <span className="inline-flex items-center rounded-full bg-midnight/85 px-2.5 py-1 text-2xs font-semibold uppercase tracking-wider text-silver shadow backdrop-blur">
      {t('ride.mapYourTrip')}
    </span>
  ) : null;

  const buttons = (inFull: boolean) => (
    <div className="flex flex-col gap-2">
      <MapButton label={t('ride.mapRecenter')} onClick={() => setRecenter((n) => n + 1)}>
        <Crosshair className="h-4 w-4" />
      </MapButton>
      {inFull ? (
        <MapButton label={t('ride.mapClose')} onClick={() => setFull(false)}>
          <X className="h-4 w-4" />
        </MapButton>
      ) : (
        <MapButton label={t('ride.mapFull')} onClick={() => setFull(true)}>
          <Maximize2 className="h-4 w-4" />
        </MapButton>
      )}
    </div>
  );

  return (
    <>
      <div className={cn('relative', className)}>
        <LazyLiveMap
          ariaLabel={t('ride.liveMap')}
          className="h-full w-full rounded-none"
          markers={geo.markers}
          route={geo.route}
          path={geo.path}
          maxZoom={geo.maxZoom}
          padding={{ top: 56, bottom: 64, left: 40, right: 56 }}
          fitKey={`${stage}:${recenter}`}
          controls={false}
          footInset={20}
        />
        <div className="pointer-events-none absolute left-3 top-3">{chip}</div>
        <div className="absolute right-3 top-3">{buttons(false)}</div>
      </div>
      {full && (
        <FullMap onClose={() => setFull(false)}>
          <LazyLiveMap
            ariaLabel={t('ride.liveMap')}
            className="h-full w-full rounded-none"
            markers={geo.markers}
            route={geo.route}
            path={geo.path}
            maxZoom={geo.maxZoom}
            padding={{ top: 80, bottom: 220, left: 48, right: 64 }}
            fitKey={`${stage}:${recenter}`}
            controls={false}
          />
          <div className="pointer-events-none absolute left-4 top-[calc(env(safe-area-inset-top,0px)+1rem)]">{chip}</div>
          <div className="absolute right-4 top-[calc(env(safe-area-inset-top,0px)+1rem)]">{buttons(true)}</div>
          {overlay && (
            // Clear of the map credit's (i) in the corner.
            <div className="absolute inset-x-3 bottom-[calc(env(safe-area-inset-bottom,0px)+3rem)] mx-auto max-w-lg">{overlay}</div>
          )}
        </FullMap>
      )}
    </>
  );
}

function MapButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="grid h-10 w-10 place-items-center rounded-full bg-midnight/85 text-white shadow-lg backdrop-blur transition-colors hover:bg-navy focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
    >
      {children}
    </button>
  );
}

/** The map, the whole screen — Escape or the X closes it. */
function FullMap({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const { t } = useI18n();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={t('ride.liveMap')} className="fixed inset-0 z-[70] bg-midnight animate-enter">
      {children}
    </div>,
    document.body,
  );
}
