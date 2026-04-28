import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { Briefcase, AlertCircle } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { listApplications } from '@/lib/onboardingApi';
import { ApiError } from '@/lib/api';
import { PageHeader } from '@/components/ui/PageHeader';
import { Skeleton, SkeletonRows } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
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
  const [applicationId, setApplicationId] = useState<string | null | undefined>(
    undefined
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Associates only ever have a handful of applications and we just need
    // the most recent one to redirect into. pageSize=1 keeps the response
    // tiny even though the API would scope this to the current associate
    // anyway.
    listApplications({ pageSize: 1 })
      .then((res) => {
        if (cancelled) return;
        setApplicationId(res.applications[0]?.id ?? null);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError) {
          setError(err.message);
        } else {
          setError('Failed to load your onboarding.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="max-w-2xl mx-auto">
        <PageHeader title="Onboarding" />
        <EmptyState
          icon={AlertCircle}
          title="Couldn't load onboarding"
          description={error}
        />
      </div>
    );
  }

  if (applicationId === undefined) {
    return (
      <div className="max-w-2xl mx-auto">
        <PageHeader title="Onboarding" />
        <Skeleton className="h-8 w-48 mb-4" />
        <SkeletonRows count={4} rowHeight="h-16" />
      </div>
    );
  }

  if (applicationId === null) {
    return (
      <div className="max-w-2xl mx-auto">
        <PageHeader title="Onboarding" />
        <EmptyState
          icon={Briefcase}
          title="No active onboarding"
          description="Once HR creates an application for you, it'll show up here with a checklist of what to complete."
        />
      </div>
    );
  }

  return <Navigate to={`/onboarding/me/${applicationId}`} replace />;
}
