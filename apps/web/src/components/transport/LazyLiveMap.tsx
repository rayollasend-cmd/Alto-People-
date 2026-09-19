import { lazy, Suspense } from 'react';
import { Skeleton } from '@/components/ui/Skeleton';
import type { LiveMapProps } from './LiveMap';

export type { LiveMapProps, MapMarker } from './LiveMap';

// MapLibre is ~800 KB — only the pages that show a van pay for it.
const LiveMap = lazy(() => import('./LiveMap'));

export function LazyLiveMap(props: LiveMapProps) {
  return (
    <Suspense fallback={<Skeleton className={props.className} />}>
      <LiveMap {...props} />
    </Suspense>
  );
}
