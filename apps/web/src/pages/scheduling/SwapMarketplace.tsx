import { useCallback, useEffect, useState } from 'react';
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

type Tab = 'incoming' | 'outgoing';

const STATUS_CLS: Record<ShiftSwapStatus, string> = {
  PENDING_PEER: 'text-gold',
  PEER_ACCEPTED: 'text-emerald-300',
  PEER_DECLINED: 'text-alert',
  MANAGER_APPROVED: 'text-emerald-300',
  MANAGER_REJECTED: 'text-alert',
  CANCELLED: 'text-silver/60',
};

export function SwapMarketplace() {
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
      setError(err instanceof ApiError ? err.message : 'Failed to load.');
    }
  }, [tab]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const wrap = async (id: string, fn: () => Promise<unknown>) => {
    setPendingId(id);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Action failed.');
    } finally {
      setPendingId(null);
    }
  };

  return (
    <section className="bg-navy border border-navy-secondary rounded-lg p-5 mb-5">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="font-display text-2xl text-white">Shift swaps</h2>
      </div>
      <div role="tablist" className="flex gap-2 mb-4 border-b border-navy-secondary">
        {(['incoming', 'outgoing'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cn(
              'px-3 py-2 text-sm border-b-2 -mb-px transition capitalize',
              tab === t
                ? 'border-gold text-gold'
                : 'border-transparent text-silver hover:text-white'
            )}
          >
            {t}
          </button>
        ))}
      </div>

      {error && (
        <p role="alert" className="text-sm text-alert mb-3">
          {error}
        </p>
      )}
      {!items && <p className="text-silver">Loading…</p>}
      {items && items.length === 0 && (
        <p className="text-silver">No swap requests in this view.</p>
      )}

      {items && items.length > 0 && (
        <ul className="space-y-2">
          {items.map((s) => (
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
                    {new Date(s.shiftStartsAt).toLocaleString()} –{' '}
                    {new Date(s.shiftEndsAt).toLocaleTimeString()}
                  </div>
                  <div className="text-xs text-silver mt-1">
                    {tab === 'incoming' ? (
                      <>From <span className="text-white">{s.requesterName}</span></>
                    ) : (
                      <>To <span className="text-white">{s.counterpartyName}</span></>
                    )}
                  </div>
                  {s.note && (
                    <div className="text-xs text-silver/70 mt-1 italic">"{s.note}"</div>
                  )}
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={cn('text-[10px] uppercase tracking-widest', STATUS_CLS[s.status])}>
                    {s.status.replace(/_/g, ' ')}
                  </span>
                  {tab === 'incoming' && s.status === 'PENDING_PEER' && (
                    <>
                      <button
                        type="button"
                        onClick={() => wrap(s.id, () => peerAcceptSwap(s.id))}
                        disabled={pendingId === s.id}
                        className="text-xs px-2 py-1 rounded border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-50"
                      >
                        Accept
                      </button>
                      <button
                        type="button"
                        onClick={() => wrap(s.id, () => peerDeclineSwap(s.id))}
                        disabled={pendingId === s.id}
                        className="text-xs px-2 py-1 rounded border border-alert/40 text-alert hover:bg-alert/10 disabled:opacity-50"
                      >
                        Decline
                      </button>
                    </>
                  )}
                  {tab === 'outgoing' &&
                    (s.status === 'PENDING_PEER' || s.status === 'PEER_ACCEPTED') && (
                      <button
                        type="button"
                        onClick={() => wrap(s.id, () => cancelSwap(s.id))}
                        disabled={pendingId === s.id}
                        className="text-xs px-2 py-1 rounded border border-silver/30 text-silver hover:bg-silver/10 disabled:opacity-50"
                      >
                        Cancel
                      </button>
                    )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
