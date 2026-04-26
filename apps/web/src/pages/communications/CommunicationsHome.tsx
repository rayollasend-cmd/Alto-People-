import { useAuth } from '@/lib/auth';
import { AssociateInboxView } from './AssociateInboxView';
import { AdminCommsView } from './AdminCommsView';

export function CommunicationsHome() {
  const { user, can } = useAuth();
  if (user?.role === 'ASSOCIATE') {
    return <AssociateInboxView />;
  }
  return <AdminCommsView canManage={can('manage:communications')} />;
}
