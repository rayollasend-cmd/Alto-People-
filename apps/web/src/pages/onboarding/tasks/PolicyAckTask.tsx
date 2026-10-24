import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { CheckCircle2, ChevronRight, Circle, CircleDot, FileText } from '@/components/ui/icons';
import type { PolicyForApplication } from '@alto-people/shared';
import { useAuth } from '@/lib/auth';
import {
  acknowledgePolicy,
  getApplicationPolicies,
} from '@/lib/onboardingApi';
import { ApiError } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { ContinueLabel, TaskShell, taskButtonCls, useNextTask } from './ProfileInfoTask';
import { cn } from '@/lib/cn';
import { ProgressBar } from '@/components/ProgressBar';
import { Button } from '@/components/ui/Button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { QueryError } from '@/components/ui/QueryError';

/**
 * Policies as a list, each read in a sheet.
 *
 * Twelve policies used to render as "one continuous read" — more than five
 * phone screens per policy, with a small "0 of 12" as the only sense of
 * where you were. Now every policy is a row (title, version, a check); a
 * tap opens its text in a sheet with "I acknowledge" at the bottom, and a
 * sticky bar says "4 of 12".
 *
 * Legal posture is unchanged: the full text renders in the sheet, and a
 * sentinel below its last line must scroll into view before that policy
 * can be acknowledged — the same "read to the end" evidence as before.
 * Each acknowledgment is its own POST (one audit record per policy);
 * "Acknowledge all I've read" fires the same POSTs, one at a time, for
 * exactly the policies whose text was read to the end.
 */
export function PolicyAckTask() {
  const { applicationId } = useParams<{ applicationId: string }>();
  const { user } = useAuth();
  const { t } = useI18n();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  // Bulk-acknowledge progress; null when not running.
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null);
  // Policies whose text was read to the end (the sheet's sentinel was seen).
  const [readIds, setReadIds] = useState<Set<string>>(new Set());
  // The policy open in the sheet.
  const [openId, setOpenId] = useState<string | null>(null);

  const isAssociate = user?.role === 'ASSOCIATE';
  const backTo = isAssociate
    ? `/onboarding/me/${applicationId}`
    : `/onboarding/applications/${applicationId}`;
  const next = useNextTask('POLICY_ACK');

  const policiesQuery = useQuery({
    queryKey: ['PolicyAckTask', 'policies', applicationId ?? null],
    queryFn: () => getApplicationPolicies(applicationId!),
    enabled: !!applicationId,
  });
  const policies: PolicyForApplication[] | null = policiesQuery.data?.policies ?? null;
  const { refetch } = policiesQuery;
  const refresh = useCallback(async (): Promise<PolicyForApplication[] | null> => {
    const r = await refetch();
    return r.data?.policies ?? null;
  }, [refetch]);

  const markRead = useCallback((id: string) => {
    setReadIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  }, []);

  const busy = pendingId !== null || bulk !== null;

  const handleAck = async (policyId: string) => {
    if (!applicationId || busy) return;
    setPendingId(policyId);
    setError(null);
    try {
      await acknowledgePolicy(applicationId, { policyId });
      const fresh = await refresh();
      // On to the next one still to acknowledge, in list order — twelve
      // policies shouldn't take twelve round trips through the list.
      const list = fresh ?? policies ?? [];
      const at = list.findIndex((p) => p.id === policyId);
      const following = [...list.slice(at + 1), ...list.slice(0, Math.max(0, at))].find((p) => !p.acknowledged);
      setOpenId(following ? following.id : null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('ob.policy.ackFailed'));
    } finally {
      setPendingId(null);
    }
  };

  const total = policies?.length ?? 0;
  const ackedCount = (policies ?? []).filter((p) => p.acknowledged).length;
  const allAcked = !!policies && total > 0 && ackedCount === total;
  const readNotAcked = (policies ?? []).filter((p) => !p.acknowledged && readIds.has(p.id));

  const handleAckRead = async () => {
    if (!applicationId || busy || readNotAcked.length === 0) return;
    const batch = readNotAcked;
    setError(null);
    setBulk({ done: 0, total: batch.length });
    for (let i = 0; i < batch.length; i++) {
      try {
        await acknowledgePolicy(applicationId, { policyId: batch[i].id });
      } catch (err) {
        // Stop at the first failure — everything before it is already
        // recorded, the refresh below shows exactly where it stopped.
        setError(err instanceof ApiError ? err.message : t('ob.policy.ackFailed'));
        break;
      }
      setBulk({ done: i + 1, total: batch.length });
    }
    await refresh();
    setBulk(null);
  };

  const openPolicy = policies?.find((p) => p.id === openId) ?? null;
  const openNumber = openPolicy ? (policies ?? []).indexOf(openPolicy) + 1 : 0;

  return (
    <TaskShell title={t('ob.policy.title')} backTo={backTo} kind="POLICY_ACK">
      <p className="text-silver text-sm mb-4">{t('ob.policy.introList')}</p>

      {policiesQuery.isError && !policies && (
        <QueryError className="mb-4" what={t('ob.policy.what')} query={policiesQuery} />
      )}

      {!policies && !policiesQuery.isError && <SkeletonRows count={3} rowHeight="h-16" />}

      {policies && total === 0 && (
        <EmptyState
          icon={FileText}
          title={t('ob.policy.emptyTitle')}
          description={t('ob.policy.emptyDesc')}
        />
      )}

      {policies && total > 0 && (
        <>
          {/* Where you are, always in view while the list scrolls. The
              negative top cancels <main>'s padding (a sticky box pins inside
              its scroller's padding), so rows don't show above the bar. */}
          <div
            className="sticky -top-4 z-10 -mx-5 mb-3 border-b border-navy-secondary bg-navy/95 px-5 py-2.5 backdrop-blur md:-top-6 md:-mx-6 md:px-6 lg:-top-8"
            data-testid="policy-progress"
          >
            <p className="mb-1.5 text-sm" aria-live="polite">
              <span className={cn('tabular-nums', allAcked ? 'text-gold' : 'text-white')}>
                {t('ob.policy.progress', { done: ackedCount, total })}
              </span>
            </p>
            <ProgressBar
              percent={(ackedCount / total) * 100}
              hideLabel
              label={t('ob.policy.progress', { done: ackedCount, total })}
            />
          </div>

          <ul className="space-y-2" aria-label={t('ob.policy.title')}>
            {policies.map((p) => {
              const read = readIds.has(p.id);
              const Icon = p.acknowledged ? CheckCircle2 : read ? CircleDot : Circle;
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => setOpenId(p.id)}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-lg border px-3 py-3 text-left transition-colors coarse:min-h-14',
                      'focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
                      p.acknowledged
                        ? 'border-gold/40 bg-gold/5 hover:border-gold/60'
                        : 'border-navy-secondary hover:border-gold/60',
                    )}
                    data-testid={`policy-row-${p.id}`}
                  >
                    <Icon
                      className={cn('h-5 w-5 shrink-0', p.acknowledged ? 'text-gold' : read ? 'text-success' : 'text-silver/70')}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-white">
                        {p.title} <span className="text-xs font-normal text-silver">{p.version}</span>
                      </span>
                      <span
                        className={cn(
                          'block text-xs',
                          p.acknowledged ? 'text-gold' : read ? 'text-success' : 'text-silver',
                        )}
                      >
                        {p.acknowledged
                          ? t('ob.policy.acknowledged')
                          : read
                            ? t('ob.policy.readNotAcked')
                            : t('ob.policy.notRead')}
                      </span>
                    </span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-silver" aria-hidden />
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {error && (
        <p role="alert" className="mt-4 text-sm text-alert">
          {error}
        </p>
      )}

      {policies && total > 0 && (
        <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-navy-secondary pt-4">
          {allAcked ? (
            <Button type="button" onClick={() => navigate(next?.route ?? backTo)} className={taskButtonCls}>
              <ContinueLabel label={next ? t('ob.policy.continue') : t('ob.policy.doneBack')} next={next} />
            </Button>
          ) : (
            <>
              <Button
                type="button"
                onClick={handleAckRead}
                loading={bulk !== null}
                disabled={readNotAcked.length === 0 || busy}
              >
                {bulk
                  ? t('ob.policy.acking', {
                      current: Math.min(bulk.done + 1, bulk.total),
                      total: bulk.total,
                    })
                  : t('ob.policy.ackRead', { count: readNotAcked.length })}
              </Button>
              {readNotAcked.length === 0 && (
                <span className="text-xs text-silver">{t('ob.policy.ackReadHint')}</span>
              )}
            </>
          )}
        </div>
      )}

      <Dialog open={openPolicy !== null} onOpenChange={(o) => !o && setOpenId(null)}>
        {openPolicy && (
          <PolicySheet
            key={openPolicy.id}
            policy={openPolicy}
            number={openNumber}
            total={total}
            read={readIds.has(openPolicy.id)}
            busy={pendingId === openPolicy.id}
            disabled={busy}
            onRead={() => markRead(openPolicy.id)}
            onAck={() => handleAck(openPolicy.id)}
            onClose={() => setOpenId(null)}
          />
        )}
      </Dialog>
    </TaskShell>
  );
}

function PolicySheet({
  policy,
  number,
  total,
  read,
  busy,
  disabled,
  onRead,
  onAck,
  onClose,
}: {
  policy: PolicyForApplication;
  number: number;
  total: number;
  read: boolean;
  busy: boolean;
  disabled: boolean;
  onRead: () => void;
  onAck: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // Read = the line below the text's last line has scrolled into view. A
  // text short enough to fit is read the moment it opens (the observer
  // fires on observe when already intersecting).
  useEffect(() => {
    if (policy.acknowledged || read) return;
    const el = sentinelRef.current;
    if (typeof IntersectionObserver === 'undefined' || !el) {
      // No way to watch the scroll position (very old browsers, jsdom) —
      // fail open, as the continuous read did.
      onRead();
      return;
    }
    const obs = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        onRead();
        obs.disconnect();
      }
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, [policy.acknowledged, read, onRead]);

  return (
    <DialogContent className="sm:max-w-2xl" data-testid="policy-sheet">
      <DialogHeader>
        <DialogTitle>{policy.title}</DialogTitle>
        <DialogDescription>
          {t('ob.policy.sectionNumber', { number, total })} · {policy.version}
          {policy.industry ? ` · ${policy.industry}` : ''}
        </DialogDescription>
      </DialogHeader>

      {policy.body ? (
        <div className="whitespace-pre-wrap text-sm leading-relaxed text-silver">{policy.body}</div>
      ) : policy.bodyUrl ? (
        <iframe
          src={policy.bodyUrl}
          title={policy.title}
          className="h-[60dvh] w-full rounded border border-navy-secondary bg-white"
        />
      ) : (
        <p className="text-sm text-silver/70">{t('ob.policy.noBody')}</p>
      )}

      {/* End-of-text marker: passing it is the "read to the end" evidence
          that unlocks I acknowledge. */}
      <div ref={sentinelRef} className="h-px" aria-hidden />

      {/* The state line above the button on a phone, beside it from sm. */}
      <DialogFooter sticky className="flex-col items-stretch sm:flex-row sm:items-center">
        {policy.acknowledged ? (
          <>
            <span className="flex items-center gap-1.5 text-sm text-gold sm:mr-auto">
              <CheckCircle2 className="h-4 w-4" aria-hidden />
              {policy.acknowledgedAt
                ? t('ob.policy.acknowledgedOn', { date: fmtDate(policy.acknowledgedAt) })
                : t('ob.policy.acknowledged')}
            </span>
            <Button type="button" variant="secondary" onClick={onClose}>
              {t('ob.policy.close')}
            </Button>
          </>
        ) : (
          <>
            <span className={cn('text-xs sm:mr-auto', read ? 'text-success' : 'text-silver')}>
              {read ? t('ob.policy.readInFull') : t('ob.policy.scrollToEnd')}
            </span>
            <Button type="button" onClick={onAck} loading={busy} disabled={disabled || !read}>
              {busy ? t('ob.policy.saving') : t('ob.policy.iAcknowledge')}
            </Button>
          </>
        )}
      </DialogFooter>
    </DialogContent>
  );
}
