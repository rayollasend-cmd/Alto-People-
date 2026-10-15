import { Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Briefcase, AlertCircle } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { listApplications } from '@/lib/onboardingApi';
import { ApiError } from '@/lib/api';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { ListTemplate } from '@/components/templates';
import { ApplicationsList } from './ApplicationsList';

export function OnboardingHome() {
  const { user } = useAuth();
  const isAssociate = user?.role === 'ASSOCIATE';

  if (!isAssociate) {
    return <ApplicationsList />;
  }

  return <AssociateRedirect />;
}

function AssociateRedirect() {
  // Associates only ever have a handful of applications and we just need
  // the most recent one to redirect into. pageSize=1 keeps the response
  // tiny even though the API would scope this to the current associate
  // anyway.
  const { data, error: queryError, isPending } = useQuery({
    queryKey: ['onboarding', 'associate-most-recent'],
    queryFn: async () =>
      (await listApplications({ pageSize: 1 })).applications[0]?.id ?? null,
  });
  const error = queryError
    ? queryError instanceof ApiError
      ? queryError.message
      : 'Failed to load your onboarding.'
    : null;
  const applicationId = isPending ? undefined : (data ?? null);

  if (error) {
    return (
      // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
      <ListTemplate
          className="mx-auto"
          title="Onboarding"
      >
        <EmptyState
          icon={AlertCircle}
          title="Couldn't load onboarding"
          description={error}
        />
      </ListTemplate>
    );
  }

  if (applicationId === undefined) {
    // Mirrors the AssociateChecklist shape we're about to redirect into:
    // hero greeting + subtitle, a progress card, then a stack of task
    // rows. Keeps the redirect transition from feeling like a layout
    // shift even if the redirect resolves slowly.
    return (
      <div className="mx-auto">
        <Skeleton className="h-9 w-64 mb-2" />
        <Skeleton className="h-4 w-80 mb-6" />
        <Skeleton className="h-28 mb-6 rounded-lg" />
        <div className="space-y-2.5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-14 rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  if (applicationId === null) {
    return (
      // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
      <ListTemplate
          className="mx-auto"
          title="Onboarding"
      >
        <EmptyState
          icon={Briefcase}
          title="No active onboarding"
          description="Once HR creates an application for you, it'll show up here with a checklist of what to complete."
        />
      </ListTemplate>
    );
  }

  return <Navigate to={`/onboarding/me/${applicationId}`} replace />;
}
