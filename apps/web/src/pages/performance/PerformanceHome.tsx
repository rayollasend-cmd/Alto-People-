import { useAuth } from '@/lib/auth';
import { AssociateReviewsView } from './AssociateReviewsView';
import { AdminReviewsView } from './AdminReviewsView';

export function PerformanceHome() {
  const { user, can } = useAuth();
  if (user?.role === 'ASSOCIATE') {
    return <AssociateReviewsView />;
  }
  return <AdminReviewsView canManage={can('manage:performance')} />;
}
