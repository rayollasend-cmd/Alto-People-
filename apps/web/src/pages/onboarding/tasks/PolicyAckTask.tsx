import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CheckCircle2, FileText, ChevronDown } from 'lucide-react';
import type { PolicyForApplication } from '@alto-people/shared';
import { useAuth } from '@/lib/auth';
import {
  acknowledgePolicy,
  getApplicationPolicies,
} from '@/lib/onboardingApi';
import { ApiError } from '@/lib/api';
import { TaskShell } from './ProfileInfoTask';
import { cn } from '@/lib/cn';

/**
 * Phase 5 fix — the associate now reads the full policy body inline and
 * scrolls to the bottom before the Acknowledge button enables. Required for
 * legal defensibility: "I didn't see what I was clicking" is the exact
 * defense we don't want available.
 */
export function PolicyAckTask() {
  const { applicationId } = useParams<{ applicationId: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [policies, setPolicies] = useState<PolicyForApplication[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

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
      setOpenId(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Acknowledgement failed.');
    } finally {
      setPendingId(null);
    }
  };

  return (
    <TaskShell title="Policy acknowledgments" backTo={backTo}>
      <p className="text-silver text-sm mb-5">
        Read each Alto HR policy in full, then click <em>Acknowledge</em>. The
        Acknowledge button only enables after you've scrolled to the bottom of
        the document. Your acknowledgment is stored as part of your permanent
        employment record.
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
            <PolicyRow
              key={p.id}
              policy={p}
              expanded={openId === p.id}
              onToggle={() => setOpenId((cur) => (cur === p.id ? null : p.id))}
              onAck={() => handleAck(p.id)}
              busy={pendingId === p.id}
            />
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
        {!allAcked && policies && policies.length > 0 && (
          <span className="text-xs text-silver">
            {policies.filter((p) => p.acknowledged).length} of {policies.length} acknowledged
          </span>
        )}
      </div>
    </TaskShell>
  );
}

function PolicyRow({
  policy,
  expanded,
  onToggle,
  onAck,
  busy,
}: {
  policy: PolicyForApplication;
  expanded: boolean;
  onToggle: () => void;
  onAck: () => void;
  busy: boolean;
}) {
  return (
    <li
      className={cn(
        'rounded border transition-colors',
        policy.acknowledged
          ? 'border-gold/40 bg-gold/5'
          : 'border-navy-secondary'
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-3 p-3 text-left"
        aria-expanded={expanded}
      >
        <span
          className={cn(
            'inline-block w-3 h-3 rounded-full shrink-0 border',
            policy.acknowledged
              ? 'bg-gold border-gold'
              : 'bg-transparent border-silver/50'
          )}
          aria-hidden="true"
        />
        <FileText className="h-4 w-4 text-silver shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-white truncate">
            {policy.title}{' '}
            <span className="text-silver text-xs">{policy.version}</span>
          </div>
          {policy.industry && (
            <div className="text-xs text-silver/70 capitalize">
              {policy.industry}
            </div>
          )}
        </div>
        {policy.acknowledged ? (
          <span className="text-xs text-gold uppercase tracking-widest shrink-0">
            Acknowledged
          </span>
        ) : (
          <ChevronDown
            className={cn(
              'h-4 w-4 text-silver/60 transition-transform shrink-0',
              expanded && 'rotate-180'
            )}
          />
        )}
      </button>

      {expanded && (
        <PolicyBody
          policy={policy}
          onAck={onAck}
          busy={busy}
        />
      )}
    </li>
  );
}

function PolicyBody({
  policy,
  onAck,
  busy,
}: {
  policy: PolicyForApplication;
  onAck: () => void;
  busy: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrolledToEnd, setScrolledToEnd] = useState(false);

  // If body is short enough that there's no scrollbar, the user has already
  // "seen the whole thing" — enable the button immediately. Re-checked on
  // every render in case content loads late.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollHeight <= el.clientHeight + 4) {
      setScrolledToEnd(true);
    }
  }, [policy.body, policy.bodyUrl]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom <= 24) {
      setScrolledToEnd(true);
    }
  };

  const isAlreadyAcknowledged = policy.acknowledged;

  return (
    <div className="border-t border-navy-secondary">
      {policy.body ? (
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="max-h-96 overflow-y-auto px-4 py-3 text-sm text-silver whitespace-pre-wrap leading-relaxed bg-navy-secondary/20"
        >
          {policy.body}
        </div>
      ) : policy.bodyUrl ? (
        <div className="px-4 py-3">
          <iframe
            ref={(node) => {
              // For iframes we can't observe scroll easily — once the
              // associate has clicked the link to load the file, treat as
              // read. The iframe load event below sets scrolledToEnd.
              if (node) scrollRef.current = node as unknown as HTMLDivElement;
            }}
            src={policy.bodyUrl}
            title={policy.title}
            className="w-full h-96 rounded border border-navy-secondary bg-white"
            onLoad={() => setScrolledToEnd(true)}
          />
        </div>
      ) : (
        <p className="px-4 py-3 text-sm text-silver/70">
          Policy text not available — contact HR if you have questions before
          acknowledging.
        </p>
      )}

      {!isAlreadyAcknowledged && (
        <div className="flex items-center justify-between px-4 py-3 bg-navy-secondary/40 border-t border-navy-secondary">
          <span
            className={cn(
              'text-xs flex items-center gap-1.5',
              scrolledToEnd ? 'text-success' : 'text-silver/60'
            )}
          >
            {scrolledToEnd ? (
              <>
                <CheckCircle2 className="h-3.5 w-3.5" />
                Read in full — you can acknowledge
              </>
            ) : (
              'Scroll to the bottom to enable Acknowledge'
            )}
          </span>
          <button
            type="button"
            onClick={onAck}
            disabled={busy || !scrolledToEnd}
            className={cn(
              'text-sm px-3 py-1.5 rounded shrink-0 transition',
              busy || !scrolledToEnd
                ? 'bg-navy-secondary text-silver/50 cursor-not-allowed'
                : 'bg-gold text-navy hover:bg-gold-bright'
            )}
          >
            {busy ? 'Saving…' : 'Acknowledge'}
          </button>
        </div>
      )}
    </div>
  );
}
