import { Navigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { AssociateReviewsView } from './AssociateReviewsView';
import { AdminReviewsView } from './AdminReviewsView';

/** Tabs that live on /performance/extras; old links (/performance?tab=pips) land there. */
const EXTRAS_TABS = new Set(['goals', 'kudos', 'one-on-ones', 'pips', 'reviews360', 'timeline']);

export function PerformanceHome() {
  const { user, can } = useAuth();
  const [params] = useSearchParams();
  const tab = params.get('tab');
  if (user?.role !== 'ASSOCIATE' && tab && EXTRAS_TABS.has(tab)) {
    return <Navigate to={`/performance/extras?tab=${tab}`} replace />;
  }
  if (user?.role === 'ASSOCIATE') {
    return <AssociateReviewsView />;
  }
  return <AdminReviewsView canManage={can('manage:performance')} />;
}
