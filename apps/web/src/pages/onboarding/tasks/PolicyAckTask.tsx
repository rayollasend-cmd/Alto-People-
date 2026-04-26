import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { PolicyForApplication } from '@alto-people/shared';
import { useAuth } from '@/lib/auth';
import {
  acknowledgePolicy,
  getApplicationPolicies,
} from '@/lib/onboardingApi';
import { ApiError } from '@/lib/api';
import { TaskShell } from './ProfileInfoTask';
import { cn } from '@/lib/cn';

export function PolicyAckTask() {
  const { applicationId } = useParams<{ applicationId: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [policies, setPolicies] = useState<PolicyForApplication[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const isAssociate = user?.role === 'ASSOCIATE';
  const backTo = isAssociate
    ? `/onboarding/me/${applicationId}`
    : `/onboarding/applications/${applicationId}`;

  const refresh = useCallback(async () => {
    if (!applicationId) return;
    try {
      const res = await getApplicationPolicies(applicationId);
      setPolicies(res.policies);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load.');
    }
  }, [applicationId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const allAcked = !!policies && policies.every((p) => p.acknowledged);

  const handleAck = async (policyId: string) => {
    if (!applicationId || pendingId) return;
    setPendingId(policyId);
    setError(null);
    try {
      await acknowledgePolicy(applicationId, { policyId });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Acknowledgement failed.');
    } finally {
      setPendingId(null);
    }
  };

  return (
    <TaskShell title="Policy acknowledgments" backTo={backTo}>
      <p className="text-silver text-sm mb-5">
        Read each policy and click <em>Acknowledge</em>. The task will be marked
        complete once all required policies are acknowledged.
      </p>

      {error && (
        <p role="alert" className="text-sm text-alert mb-4">
          {error}
        </p>
      )}

      {!policies && <p className="text-silver">Loading…</p>}

      {policies && policies.length === 0 && (
        <p className="text-silver">No required policies for this application.</p>
      )}

      {policies && policies.length > 0 && (
        <ul className="space-y-3 mb-5">
          {policies.map((p) => (
            <li
              key={p.id}
              className={cn(
                'flex items-center gap-3 p-3 rounded border',
                p.acknowledged
                  ? 'border-gold/40 bg-gold/5'
                  : 'border-navy-secondary'
              )}
            >
              <span
                className={cn(
                  'inline-block w-3 h-3 rounded-full shrink-0 border',
                  p.acknowledged
                    ? 'bg-gold border-gold'
                    : 'bg-transparent border-silver/50'
                )}
                aria-hidden="true"
              />
              <div className="flex-1 min-w-0">
                <div className="text-white">
                  {p.title}{' '}
                  <span className="text-silver text-xs">{p.version}</span>
                </div>
                {p.industry && (
                  <div className="text-xs text-silver/70 capitalize">
                    {p.industry}
                  </div>
                )}
              </div>
              {p.acknowledged ? (
                <span className="text-xs text-gold uppercase tracking-widest shrink-0">
                  Acknowledged
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => handleAck(p.id)}
                  disabled={pendingId === p.id}
                  className={cn(
                    'text-sm px-3 py-1.5 rounded shrink-0 transition',
                    pendingId === p.id
                      ? 'bg-navy-secondary text-silver/50'
                      : 'bg-gold text-navy hover:bg-gold-bright'
                  )}
                >
                  {pendingId === p.id ? 'Saving…' : 'Acknowledge'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-3 pt-2">
        <button
          type="button"
          onClick={() => navigate(backTo)}
          className={cn(
            'px-5 py-2.5 rounded font-medium',
            allAcked
              ? 'bg-gold text-navy hover:bg-gold-bright'
              : 'bg-navy-secondary text-silver hover:text-white border border-navy-secondary'
          )}
        >
          {allAcked ? 'Done — back to checklist' : 'Back'}
        </button>
      </div>
    </TaskShell>
  );
}
