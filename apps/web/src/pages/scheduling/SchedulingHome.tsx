import { useAuth } from '@/lib/auth';
import { AssociateScheduleView } from './AssociateScheduleView';
import { AdminSchedulingView } from './AdminSchedulingView';

export function SchedulingHome() {
  const { user, can } = useAuth();
  // Associates see their assigned upcoming shifts. Anyone with manage:scheduling
  // (HR/Ops) sees the full grid + create UI.
  if (user?.role === 'ASSOCIATE') {
    return <AssociateScheduleView />;
  }
  return <AdminSchedulingView canManage={can('manage:scheduling')} />;
}
