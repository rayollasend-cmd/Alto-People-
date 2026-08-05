import { useCallback, useEffect, useState } from 'react';
import { ArrowLeftRight } from 'lucide-react';
import type { ShiftSwapRequest, ShiftSwapStatus } from '@alto-people/shared';
import {
  cancelSwap,
  listSwapsIncoming,
  listSwapsOutgoing,
  peerAcceptSwap,
  peerDeclineSwap,
} from '@/lib/schedulingApi';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useConfirm } from '@/lib/confirm';
import { useI18n, type Translate } from '@/lib/i18n';
import { Button } from '@/components/ui/Button';
import { fmtDateTz, fmtShiftRangeTz, fmtWeekdayTz } from '@/lib/format';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorBanner } from '@/components/ui/ErrorBanner';

type Tab = 'incoming' | 'outgoing';

const STATUS_CLS: Record<ShiftSwapStatus, string> = {
  PENDING_PEER: 'text-gold',
  PEER_ACCEPTED: 'text-success',
  PEER_DECLINED: 'text-alert',
  MANAGER_APPROVED: 'text-success',
  MANAGER_REJECTED: 'text-alert',
  CANCELLED: 'text-silver/70',
};

/**
 * Raw enum → plain language, from the viewer's perspective. `label` is the
 * status itself; `hint` is the "what happens next" line for states where
 * the next step isn't obvious.
 */
function statusMeta(
  s: ShiftSwapRequest,
  tab: Tab,
  t: Translate,
): { label: string; hint?: string } {
  switch (s.status) {
    case 'PENDING_PEER':
      return tab === 'incoming'
        ? {
            label: t('swap.stWaitingYou'),
            hint: t('swap.stWaitingYouHint'),
          }
        : {
            label: t('swap.stWaitingPeer', { name: s.counterpartyName }),
            hint: t('swap.stWaitingPeerHint'),
          };
    case 'PEER_ACCEPTED':
      return {
        label: t('swap.stAccepted'),
        hint: t('swap.stAcceptedHint'),
      };
    case 'PEER_DECLINED':
      return tab === 'incoming'
        ? { label: t('swap.stYouDeclined') }
        : { label: t('swap.stPeerDeclined', { name: s.counterpartyName }) };
    case 'MANAGER_APPROVED':
      return { label: t('swap.stApproved') };
    case 'MANAGER_REJECTED':
      return {
        label: t('swap.stRejected'),
        hint: t('swap.stRejectedHint'),
      };
    case 'CANCELLED':
      return tab === 'incoming'
        ? { label: t('swap.stCancelledByRequester', { name: s.requesterName }) }
        : { label: t('swap.stCancelled') };
  }
}

export function SwapMarketplace({
  // Parent bumps this when a swap is created elsewhere on the page (the
  // shift-card offer flow) so the list refetches without a manual reload.
  refreshToken = 0,
}: {
  refreshToken?: number;
}) {
  const confirm = useConfirm();
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('incoming');
  const [items, setItems] = useState<ShiftSwapRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const res = tab === 'incoming' ? await listSwapsIncoming() : await listSwapsOutgoing();
      setItems(res.requests);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('swap.loadFailed'));
    }
  }, [tab, t]);

  useEffect(() => {
    refresh();
  }, [refresh, refreshToken]);

  const wrap = async (id: string, fn: () => Promise<unknown>) => {
    setPendingId(id);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('swap.actionFailed'));
    } finally {
      setPendingId(null);
    }
  };

  const declineSwap = async (s: ShiftSwapRequest) => {
    if (
      !(await confirm({
        title: t('swap.declineConfirmTitle'),
        description: t('swap.declineConfirmDesc', { name: s.requesterName }),
        confirmLabel: t('swap.decline'),
        destructive: true,
      }))
    ) {
      return;
    }
    await wrap(s.id, () => peerDeclineSwap(s.id));
  };

  return (
    <section className="bg-navy border border-navy-secondary rounded-lg p-5 mb-5">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="font-display text-2xl text-white">{t('swap.title')}</h2>
      </div>
      <div role="tablist" className="flex gap-2 mb-4 border-b border-navy-secondary">
        {(['incoming', 'outgoing'] as const).map((tabId) => (
          <button
            key={tabId}
            type="button"
            role="tab"
            aria-selected={tab === tabId}
            onClick={() => setTab(tabId)}
            className={cn(
              'px-3 py-2 coarse:min-h-11 text-sm border-b-2 -mb-px transition capitalize',
              tab === tabId
                ? 'border-gold text-gold'
                : 'border-transparent text-silver hover:text-white active:text-white'
            )}
          >
            {t(tabId === 'incoming' ? 'swap.tabIncoming' : 'swap.tabOutgoing')}
          </button>
        ))}
      </div>

      {error && (
        <ErrorBanner
          className="mb-3"
          action={
            <Button size="sm" variant="secondary" onClick={() => void refresh()}>
              {t('common.retry')}
            </Button>
          }
        >
          {error}
        </ErrorBanner>
      )}
      {!items && <SkeletonRows count={3} rowHeight="h-16" />}
      {items && items.length === 0 && (
        <EmptyState
          icon={ArrowLeftRight}
          title={t(tab === 'incoming' ? 'swap.emptyIncomingTitle' : 'swap.emptyOutgoingTitle')}
          description={t(
            tab === 'incoming' ? 'swap.emptyIncomingDesc' : 'swap.emptyOutgoingDesc',
          )}
        />
      )}

      {items && items.length > 0 && (
        <ul className="space-y-2">
          {items.map((s) => {
            const meta = statusMeta(s, tab, t);
            return (
            <li
              key={s.id}
              className="p-3 bg-navy-secondary/30 border border-navy-secondary rounded"
            >
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <div className="text-white text-sm">
                    {s.shiftPosition} · {s.shiftClientName ?? '—'}
                  </div>
                  <div className="text-xs text-silver tabular-nums">
                    {fmtWeekdayTz(s.shiftStartsAt, s.shiftTimezone)},{' '}
                    {fmtDateTz(s.shiftStartsAt, s.shiftTimezone)} ·{' '}
                    {fmtShiftRangeTz(s.shiftStartsAt, s.shiftEndsAt, s.shiftTimezone)}
                  </div>
                  {s.inExchange && (
                    <div className="text-xs text-gold/90 tabular-nums mt-0.5">
                      {t(tab === 'incoming' ? 'swap.theyTake' : 'swap.youTake')}
                      {s.inExchange.position} ·{' '}
                      {fmtWeekdayTz(s.inExchange.startsAt, s.inExchange.timezone)},{' '}
                      {fmtDateTz(s.inExchange.startsAt, s.inExchange.timezone)} ·{' '}
                      {fmtShiftRangeTz(
                        s.inExchange.startsAt,
                        s.inExchange.endsAt,
                        s.inExchange.timezone,
                      )}
                    </div>
                  )}
                  <div className="text-xs text-silver mt-1">
                    {tab === 'incoming' ? (
                      <>{t('swap.from')} <span className="text-white">{s.requesterName}</span></>
                    ) : (
                      <>{t('swap.to')} <span className="text-white">{s.counterpartyName}</span></>
                    )}
                  </div>
                  {s.note && (
                    <div className="text-xs text-silver/70 mt-1 italic">"{s.note}"</div>
                  )}
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={cn('text-xs', STATUS_CLS[s.status])}>
                    {meta.label}
                  </span>
                  {tab === 'incoming' && s.status === 'PENDING_PEER' && (
                    <>
                      <Button
                        type="button"
                        size="sm"
                        className="coarse:min-h-11"
                        onClick={() => wrap(s.id, () => peerAcceptSwap(s.id))}
                        disabled={pendingId === s.id}
                      >
                        {t('swap.accept')}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="coarse:min-h-11"
                        onClick={() => void declineSwap(s)}
                        disabled={pendingId === s.id}
                      >
                        {t('swap.decline')}
                      </Button>
                    </>
                  )}
                  {tab === 'outgoing' &&
                    (s.status === 'PENDING_PEER' || s.status === 'PEER_ACCEPTED') && (
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        onClick={() => wrap(s.id, () => cancelSwap(s.id))}
                        disabled={pendingId === s.id}
                      >
                        {t('common.cancel')}
                      </Button>
                    )}
                </div>
              </div>
              {meta.hint && (
                <div className="text-xs text-silver/70 mt-2">{meta.hint}</div>
              )}
            </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
