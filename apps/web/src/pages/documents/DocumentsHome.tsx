import { useAuth } from '@/lib/auth';
import { AssociateDocumentsView } from './AssociateDocumentsView';
import { AdminDocumentsView } from './AdminDocumentsView';

export function DocumentsHome() {
  const { user, can } = useAuth();
  if (user?.role === 'ASSOCIATE') {
    return <AssociateDocumentsView />;
  }
  return <AdminDocumentsView canManage={can('manage:documents')} />;
}
