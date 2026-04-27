import { useCallback, useEffect, useState } from 'react';
import type { Notification } from '@alto-people/shared';
import { listMyInbox, markRead } from '@/lib/communicationsApi';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { PageHeader } from '@/components/ui/PageHeader';

export function AssociateInboxView() {
  const [items, setItems] = useState<Notification[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const res = await listMyInbox();
      setItems(res.notifications);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load inbox.');
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const onClick = async (n: Notification) => {
    if (n.readAt) return;
    try {
      await markRead(n.id);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Mark-read failed.');
    }
  };

  const unreadCount = items?.filter((n) => !n.readAt).length ?? 0;

  return (
    <div className="max-w-3xl mx-auto">
      <PageHeader
        title={
          <>
            Inbox{' '}
            {unreadCount > 0 && (
              <span className="text-base text-gold align-middle ml-2">
                ({unreadCount} unread)
              </span>
            )}
          </>
        }
        subtitle="Messages from HR and the system."
      />

      {error && (
        <p role="alert" className="text-sm text-alert mb-3">
          {error}
        </p>
      )}
      {!items && <p className="text-silver">Loading…</p>}
      {items && items.length === 0 && (
        <p className="text-silver">No messages.</p>
      )}
      {items && items.length > 0 && (
        <ul className="space-y-2">
          {items.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                onClick={() => onClick(n)}
                className={cn(
                  'block w-full text-left p-4 rounded border transition',
                  n.readAt
                    ? 'border-navy-secondary bg-navy/60'
                    : 'border-gold/40 bg-gold/5 hover:bg-gold/10'
                )}
              >
                <div className="flex items-start justify-between gap-3 mb-1">
                  <div className="text-white">
                    {n.subject ?? <span className="text-silver italic">(no subject)</span>}
                  </div>
                  <span className="text-xs text-silver/70 tabular-nums">
                    {new Date(n.createdAt).toLocaleString()}
                  </span>
                </div>
                <div className="text-sm text-silver whitespace-pre-line">{n.body}</div>
                {n.senderEmail && (
                  <div className="text-[10px] uppercase tracking-widest text-silver/60 mt-2">
                    From {n.senderEmail}
                  </div>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
