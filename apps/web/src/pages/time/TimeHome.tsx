import { useAuth } from '@/lib/auth';
import { AssociateTimeView } from './AssociateTimeView';
import { AdminTimeView } from './AdminTimeView';

export function TimeHome() {
  const { user, can } = useAuth();
  const isAssociate = user?.role === 'ASSOCIATE';
  const canManage = can('manage:time');

  // Associates land on the clock-in view; HR/Ops on the admin queue.
  // INTERNAL_RECRUITER and others with view:time but no associateId fall back
  // to the admin view too (read-only since they lack manage:time).
  if (isAssociate) {
    return <AssociateTimeView />;
  }
  return <AdminTimeView canManage={canManage} />;
}
