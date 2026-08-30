import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CheckCircle2, FileText } from 'lucide-react';
import type { PolicyForApplication } from '@alto-people/shared';
import { useAuth } from '@/lib/auth';
import {
  acknowledgePolicy,
  getApplicationPolicies,
} from '@/lib/onboardingApi';
import { ApiError } from '@/lib/api';
import { TaskShell, useNextTask } from './ProfileInfoTask';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/Button';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';

/**
 * One continuous read instead of 12 expand→scroll→tap accordions.
 *
 * Legal posture is unchanged: every policy body still renders in full and a
 * per-policy sentinel below the LAST line must enter the viewport before
 * that policy can be acknowledged — the exact "scrolled to the bottom"
 * evidence the old per-accordion gate produced. Each acknowledgment is
 * still its own explicit action against the same per-policy POST, so the
 * audit trail (one record per policy) is identical; "Acknowledge all
 * remaining" only enables after EVERY sentinel has passed and then fires
 * the same POSTs one at a time.
 */
export function PolicyAckTask() {
  const { applicationId } = useParams<{ applicationId: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [policies, setPolicies] = useState<PolicyForApplication[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  // Bulk-acknowledge progress; null when not running.
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null);
  // Policies whose end-of-body sentinel has entered the viewport.
  const [readIds, setReadIds] = useState<Set<string>>(new Set());
  // Ids unacknowledged at FIRST load, in server order. Sections acked
  // during this session stay in place (collapsing them mid-read would yank
  // the scroll position out from under the reader); only policies already
  // acknowledged before the visit collapse to the checked rows up top.
  const readingOrderRef = useRef<string[] | null>(null);
  const sentinels = useRef(new Map<string, HTMLElement>());

  const isAssociate = user?.role === 'ASSOCIATE';
  const backTo = isAssociate
    ? `/onboarding/me/${applicationId}`
    : `/onboarding/applications/${applicationId}`;
  const next = useNextTask('POLICY_ACK');

  const refresh = useCallback(async (): Promise<PolicyForApplication[] | null> => {
    if (!applicationId) return null;
    try {
      const res = await getApplicationPolicies(applicationId);
      if (readingOrderRef.current === null) {
        readingOrderRef.current = res.policies
          .filter((p) => !p.acknowledged)
          .map((p) => p.id);
      }
      setPolicies(res.policies);
      return res.policies;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load.');
      return null;
    }
  }, [applicationId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Mark a section read once its sentinel (below the body's last line)
  // scrolls into view. Sections short enough to be fully visible on mount
  // are marked immediately — the observer fires on observe when already
  // intersecting, preserving the old short-body auto-enable.
  useEffect(() => {
    if (!policies) return;
    if (typeof IntersectionObserver === 'undefined') {
      // No way to watch the scroll position (very old browsers, jsdom) —
      // fail open like the old scrollHeight===0 fallback did.
      setReadIds(new Set(policies.map((p) => p.id)));
      return;
    }
    const obs = new IntersectionObserver((entries) => {
      const hits = entries.filter((e) => e.isIntersecting);
      if (hits.length === 0) return;
      setReadIds((prev) => {
        const nextSet = new Set(prev);
        for (const e of hits) {
          const id = (e.target as HTMLElement).dataset.policyId;
          if (id) nextSet.add(id);
          obs.unobserve(e.target);
        }
        return nextSet;
      });
    });
    for (const el of sentinels.current.values()) obs.observe(el);
    return () => obs.disconnect();
  }, [policies]);

  const busy = pendingId !== null || bulk !== null;

  const handleAck = async (policyId: string) => {
    if (!applicationId || busy) return;
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

  const handleAckAll = async () => {
    if (!applicationId || !policies || busy) return;
    const remaining = policies.filter((p) => !p.acknowledged);
    if (remaining.length === 0) return;
    setError(null);
    setBulk({ done: 0, total: remaining.length });
    for (let i = 0; i < remaining.length; i++) {
      try {
        await acknowledgePolicy(applicationId, { policyId: remaining[i].id });
      } catch (err) {
        // Stop at the first failure — everything before it is already
        // recorded, the refresh below shows exactly where it stopped.
        setError(
          err instanceof ApiError ? err.message : 'Acknowledgement failed.'
        );
        break;
      }
      setBulk({ done: i + 1, total: remaining.length });
    }
    await refresh();
    setBulk(null);
  };

  const readingOrder = readingOrderRef.current ?? [];
  const byId = new Map((policies ?? []).map((p) => [p.id, p]));
  const readingList = readingOrder
    .map((id) => byId.get(id))
    .filter((p): p is PolicyForApplication => p !== undefined);
  const priorAcked = (policies ?? []).filter(
    (p) => p.acknowledged && !readingOrder.includes(p.id)
  );

  const total = policies?.length ?? 0;
  const ackedCount = (policies ?? []).filter((p) => p.acknowledged).length;
  const remainingCount = total - ackedCount;
  const allAcked = !!policies && total > 0 && remainingCount === 0;
  const allRead = readingList.every(
    (p) => p.acknowledged || readIds.has(p.id)
  );

  return (
    <TaskShell title="Policy acknowledgments" backTo={backTo}>
      <p className="text-silver text-sm mb-5">
        All Alto HR policies you need to acknowledge are below in one
        continuous read. Scroll through each one — you can acknowledge a
        policy as you pass it, or acknowledge everything at the end once
        you've read it all. Your acknowledgments are stored as part of your
        permanent employment record.
      </p>

      {policies && total > 0 && (
        <p className="text-xs text-silver mb-4" aria-live="polite">
          <span className={cn(allAcked && 'text-gold')}>
            {ackedCount} of {total} acknowledged
          </span>
        </p>
      )}

      {!policies && <SkeletonRows count={3} rowHeight="h-16" />}

      {policies && total === 0 && (
        <EmptyState
          icon={FileText}
          title="No policies to acknowledge"
          description="This application's onboarding template doesn't require any policy acknowledgments."
        />
      )}

      {priorAcked.length > 0 && (
        <ul className="space-y-2 mb-6">
          {priorAcked.map((p) => (
            <li
              key={p.id}
              className="flex items-center gap-3 px-3 py-2 rounded border border-gold/40 bg-gold/5"
            >
              <CheckCircle2 className="h-4 w-4 text-gold shrink-0" aria-hidden />
              <span className="flex-1 min-w-0 truncate text-sm text-white">
                {p.title}{' '}
                <span className="text-silver text-xs">{p.version}</span>
              </span>
              <span className="text-2xs text-gold uppercase tracking-widest shrink-0">
                Acknowledged
              </span>
            </li>
          ))}
        </ul>
      )}

      {readingList.length > 0 && (
        <div className="space-y-8 mb-6">
          {readingList.map((p) => (
            <PolicySection
              key={p.id}
              policy={p}
              number={(policies ?? []).findIndex((x) => x.id === p.id) + 1}
              total={total}
              read={p.acknowledged || readIds.has(p.id)}
              busy={pendingId === p.id}
              disabled={busy}
              onAck={() => handleAck(p.id)}
              sentinelRef={(node) => {
                if (node) sentinels.current.set(p.id, node);
                else sentinels.current.delete(p.id);
              }}
            />
          ))}
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm text-alert mb-4">
          {error}
        </p>
      )}

      {policies && total > 0 && (
        <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-navy-secondary">
          {allAcked ? (
            <Button
              type="button"
              onClick={() => navigate(next?.route ?? backTo)}
            >
              {next
                ? `Continue → ${next.label}`
                : 'Done — back to checklist'}
            </Button>
          ) : (
            <>
              <Button
                type="button"
                onClick={handleAckAll}
                loading={bulk !== null}
                disabled={!allRead || busy}
              >
                {bulk
                  ? `Acknowledging ${Math.min(bulk.done + 1, bulk.total)} of ${bulk.total}…`
                  : `Acknowledge all remaining (${remainingCount})`}
              </Button>
              <span className="text-xs text-silver">
                {allRead
                  ? 'You’ve read everything — one tap records the rest.'
                  : 'Scroll through every policy above to enable.'}
              </span>
            </>
          )}
        </div>
      )}
    </TaskShell>
  );
}

function PolicySection({
  policy,
  number,
  total,
  read,
  busy,
  disabled,
  onAck,
  sentinelRef,
}: {
  policy: PolicyForApplication;
  number: number;
  total: number;
  read: boolean;
  busy: boolean;
  disabled: boolean;
  onAck: () => void;
  sentinelRef: (node: HTMLDivElement | null) => void;
}) {
  return (
    <section
      className={cn(
        'rounded border',
        policy.acknowledged ? 'border-gold/40 bg-gold/5' : 'border-navy-secondary'
      )}
    >
      <header className="px-4 pt-3 pb-2 border-b border-navy-secondary">
        <div className="text-2xs uppercase tracking-widest text-silver/70">
          Policy {number} of {total}
        </div>
        <h2 className="text-base font-medium text-white">
          {policy.title}{' '}
          <span className="text-silver text-xs font-normal">{policy.version}</span>
        </h2>
        {policy.industry && (
          <div className="text-xs text-silver/70 capitalize">{policy.industry}</div>
        )}
      </header>

      {policy.body ? (
        <div className="px-4 py-3 text-sm text-silver whitespace-pre-wrap leading-relaxed bg-navy-secondary/20">
          {policy.body}
        </div>
      ) : policy.bodyUrl ? (
        <div className="px-4 py-3">
          <iframe
            src={policy.bodyUrl}
            title={policy.title}
            className="w-full h-96 rounded border border-navy-secondary bg-white"
          />
        </div>
      ) : (
        <p className="px-4 py-3 text-sm text-silver/70">
          Policy text not available — contact HR if you have questions before
          acknowledging.
        </p>
      )}

      {/* End-of-body marker: passing it is the "scrolled to the bottom"
          evidence that gates this policy's Acknowledge. */}
      <div ref={sentinelRef} data-policy-id={policy.id} className="h-px" aria-hidden />

      <div className="flex items-center justify-between gap-3 px-4 py-3 bg-navy-secondary/40 border-t border-navy-secondary">
        {policy.acknowledged ? (
          <span className="text-xs text-gold flex items-center gap-1.5">
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
            <span>Acknowledged</span>
          </span>
        ) : (
          <>
            <span
              className={cn(
                'text-xs flex items-center gap-1.5',
                read ? 'text-success' : 'text-silver/70'
              )}
            >
              {read ? (
                <>
                  <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                  Read in full — you can acknowledge
                </>
              ) : (
                'Scroll past the full text to enable Acknowledge'
              )}
            </span>
            <Button
              type="button"
              size="sm"
              onClick={onAck}
              loading={busy}
              disabled={disabled || !read}
              className="shrink-0"
            >
              {busy ? 'Saving…' : 'Acknowledge'}
            </Button>
          </>
        )}
      </div>
    </section>
  );
}
