import { useEffect, useState } from 'react';
import { CloudOff, RefreshCw } from '@/components/ui/icons';
import { toast } from 'sonner';
import { armOfflineQueueReplay, listQueuedWrites, onQueueChange, replayQueuedWrites, type QueuedWrite } from '@/lib/offlineQueue';
import { Button } from '@/components/ui/Button';

/**
 * Access pack — what is waiting to be sent. Shows only while the offline
 * queue holds something: how many, the oldest, and a "Send now" for the
 * person who knows the signal is back before the app does. A replay that
 * drops a conflicting item says which one and why.
 */
export function OfflineQueueBanner() {
  const [queue, setQueue] = useState<QueuedWrite[]>(() => (typeof window === 'undefined' ? [] : listQueuedWrites()));
  const [sending, setSending] = useState(false);
  useEffect(() => {
    const off = onQueueChange(setQueue);
    const disarm = armOfflineQueueReplay((o) => {
      if (o.sent > 0) toast.success(`Sent ${o.sent} change${o.sent === 1 ? '' : 's'} saved while offline.`);
      for (const d of o.dropped) toast.error(`Not applied: ${d.item.label}. ${d.message}`, { duration: 10_000 });
    });
    return () => {
      off();
      disarm();
    };
  }, []);
  // A driver's taps (lib/offlineTransport, kind 'transport-tap') have their own
  // "N taps waiting to send" line on the drive sheet; listing them here too
  // said it twice. They still replay with the rest (armOfflineQueueReplay above).
  const shown = queue.filter((q) => q.kind !== 'transport-tap');
  if (shown.length === 0) return null;
  return (
    <div role="status" className="flex flex-wrap items-center gap-3 border-b border-warning/40 bg-warning/10 px-4 py-2 text-sm text-ink">
      <CloudOff className="h-4 w-4 text-warning" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        {shown.length === 1 ? '1 change' : `${shown.length} changes`} saved offline — {shown[0]!.label}
        {shown.length > 1 ? ` and ${shown.length - 1} more` : ''}. They send when the signal is back.
      </span>
      <Button
        size="sm"
        variant="outline"
        loading={sending}
        onClick={async () => {
          setSending(true);
          try {
            const o = await replayQueuedWrites();
            if (o.sent === 0 && o.dropped.length === 0) toast.info('Still no signal. Keeping them for later.');
            else if (o.sent > 0) toast.success(`Sent ${o.sent}.`);
            for (const d of o.dropped) toast.error(`Not applied: ${d.item.label}. ${d.message}`, { duration: 10_000 });
          } finally {
            setSending(false);
          }
        }}
      >
        <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Send now
      </Button>
    </div>
  );
}
