import { useAuth } from '@/lib/auth';
import { AssociateTimeOffView } from './AssociateTimeOffView';
import { AdminTimeOffView } from './AdminTimeOffView';

export function TimeOffHome() {
  const { user, can } = useAuth();
  const isAssociate = user?.role === 'ASSOCIATE';
  const canManage = can('manage:time');

  if (isAssociate) {
    return <AssociateTimeOffView />;
  }
  return <AdminTimeOffView canManage={canManage} />;
}
