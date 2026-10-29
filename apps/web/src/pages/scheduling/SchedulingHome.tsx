import { lazy, Suspense } from 'react';
import { useAuth } from '@/lib/auth';
import { useReadable } from '@/lib/useReadable';
import { NoAccess } from '@/components/ui/NoAccess';
import { Skeleton } from '@/components/ui/Skeleton';
import { useI18n } from '@/lib/i18n';

// PERF: each view is its own chunk, like Dashboard's variants. The admin grid
// is most of the page's weight and an associate on a phone never renders it.
const AssociateScheduleView = lazy(() =>
  import('./AssociateScheduleView').then((m) => ({ default: m.AssociateScheduleView })),
);
const AdminSchedulingView = lazy(() =>
  import('./AdminSchedulingView').then((m) => ({ default: m.AdminSchedulingView })),
);

function SchedulingFallback() {
  const { t } = useI18n();
  return (
    <div className="space-y-4" aria-label={t('common.loading')}>
      <Skeleton className="h-8 w-1/3" />
      <Skeleton className="h-10" />
      <Skeleton className="h-96" />
    </div>
  );
}

export function SchedulingHome() {
  const { user, can } = useAuth();
  // The board reads GET /scheduling/shifts (manage:scheduling, view:executive
  // or process:payroll). A role that holds view:scheduling without any of
  // them — the client portal — reads its store's week at /portal/schedule.
  const readsBoard = useReadable(['manage:scheduling', 'view:executive', 'process:payroll']);
  if (user?.role !== 'ASSOCIATE' && !readsBoard) return <NoAccess />;
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
