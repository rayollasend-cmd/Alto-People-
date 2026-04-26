import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { listApplications } from '@/lib/onboardingApi';
import { ApiError } from '@/lib/api';
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
    listApplications()
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
        <h1 className="font-display text-3xl text-white mb-2">Onboarding</h1>
        <p className="text-alert">{error}</p>
      </div>
    );
  }

  if (applicationId === undefined) {
    return (
      <div className="max-w-2xl mx-auto text-silver">Loading…</div>
    );
  }

  if (applicationId === null) {
    return (
      <div className="max-w-2xl mx-auto">
        <h1 className="font-display text-3xl text-white mb-2">Onboarding</h1>
        <p className="text-silver">
          You don't have an active onboarding application yet. Once HR creates
          one, it'll appear here.
        </p>
      </div>
    );
  }

  return <Navigate to={`/onboarding/me/${applicationId}`} replace />;
}
