import { lazy, Suspense } from 'react';
import { useAuth } from '@/lib/auth';
import { Skeleton } from '@/components/ui/Skeleton';

// PERF: each view is its own chunk, like Dashboard's variants. The admin grid
// is most of the page's weight and an associate on a phone never renders it.
const AssociateScheduleView = lazy(() =>
  import('./AssociateScheduleView').then((m) => ({ default: m.AssociateScheduleView })),
);
const AdminSchedulingView = lazy(() =>
  import('./AdminSchedulingView').then((m) => ({ default: m.AdminSchedulingView })),
);

function SchedulingFallback() {
  return (
    <div className="space-y-4" aria-label="Loading">
      <Skeleton className="h-8 w-1/3" />
      <Skeleton className="h-10" />
      <Skeleton className="h-96" />
    </div>
  );
}

export function SchedulingHome() {
  const { user, can } = useAuth();
  // Associates see their assigned upcoming shifts. Anyone with manage:scheduling
  // (HR/Ops) sees the full grid + create UI.
  return (
    <Suspense fallback={<SchedulingFallback />}>
      {user?.role === 'ASSOCIATE' ? (
        <AssociateScheduleView />
      ) : (
        <AdminSchedulingView canManage={can('manage:scheduling')} />
      )}
    </Suspense>
  );
}
