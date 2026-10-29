import { createContext, useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { hapticConfirm } from '@/lib/haptics';
import { onPendingMarks, type PendingMark } from '@/lib/offlineTransport';
import { replayQueuedWrites } from '@/lib/offlineQueue';
import { CloudOff } from '@/components/ui/icons';
import { Button } from '@/components/ui/Button';
import type { MarkEvidence, RideRun } from '@/lib/transportApi';
import type { TripKey } from '../ShiftMap';
import '@/lib/i18n/en/drive';

/**
 * The plumbing drive mode shares: the driver's taps still waiting to send,
 * the safety sheet and the shift map from anywhere on the page, a per-
 * control lock around every action, a ticking clock, and which stops the
 * driver already opened directions to.
 */

/** The shift's stops (the ShiftMap drawer), from anywhere on the page. */
export const ShiftMapContext = createContext<(trip: TripKey) => void>(() => {});

/** The safety sheet, from any run on the page. */
export const SafetyContext = createContext<{ open: (run: RideRun | null) => void }>({ open: () => {} });

/** The driver's taps still waiting to send (floor walk 5). */
export const PendingMarksContext = createContext<PendingMark[]>([]);

export function usePendingMarks(): PendingMark[] {
  const queryClient = useQueryClient();
  const [marks, setMarks] = useState<PendingMark[]>([]);
  const before = useRef(0);
  useEffect(
    () =>
      onPendingMarks((m) => {
        setMarks(m);
        // Something sent: the server's word replaces the "(sending)" rows.
        if (m.length < before.current) void queryClient.invalidateQueries({ queryKey: ['transport', 'driver'] });
        before.current = m.length;
      }),
    [queryClient],
  );
  return marks;
}

/** "3 taps waiting to send", with Send now — while the queue holds any. */
export function PendingPill({ marks }: { marks: PendingMark[] }) {
  const { t } = useI18n();
  const [sending, setSending] = useState(false);
  if (marks.length === 0) return null;
  return (
    <div role="status" className="flex flex-wrap items-center gap-3 rounded-lg border border-caution-300 bg-caution-50 px-4 py-2.5 text-base text-caution-800" data-testid="pending-taps">
      <CloudOff className="h-5 w-5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 font-medium">{marks.length === 1 ? t('drive.pendingOne') : t('drive.pendingMany', { count: marks.length })}</span>
      <Button
        size="sm"
        variant="secondary"
        className="coarse:text-sm"
        loading={sending}
        disabled={sending}
        onClick={async () => {
          setSending(true);
          try {
            await replayQueuedWrites();
          } finally {
            setSending(false);
          }
        }}
      >
        {t('drive.sendNow')}
      </Button>
    </div>
  );
}

export function useTick(ms: number, on = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms, on]);
  return now;
}

export type Act = (key: string, fn: () => Promise<unknown>, success?: string) => Promise<void>;
export type IsBusy = (key: string) => boolean;

/**
 * Run a driver action, then refresh the runs. Floor walk 5: a lock per
 * control (one slow tap never freezes the whole card), a tap with no
 * signal is saved and says so, and a tap that landed far from the stop
 * says how far (floor walk 17).
 */
export function useAct(): { act: Act; isBusy: IsBusy } {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const act: Act = async (key, fn, success) => {
    setBusy((b) => new Set(b).add(key));
    try {
      const out = (await fn()) as { queued?: boolean; result?: { evidence?: MarkEvidence | null } } | undefined;
      hapticConfirm();
      if (out?.queued) {
        toast.info(t('drive.savedOffline'));
        return;
      }
      const evidence = out?.result?.evidence;
      if (evidence?.far && evidence.distanceM !== null) toast.warning(t('drive.farFromStop', { meters: evidence.distanceM }));
      if (success) toast.success(success);
      await queryClient.invalidateQueries({ queryKey: ['transport', 'driver'] });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy((b) => {
        const n = new Set(b);
        n.delete(key);
        return n;
      });
    }
  };
  return { act, isBusy: (key) => busy.has(key) };
}

/**
 * Which stops the driver already opened directions to, for this run.
 *
 * A map app can't hand the driver back, so the app remembers instead:
 * Navigate notes the stop (in session storage, which survives the phone
 * reloading the tab while the map had the screen), and the step machine
 * moves on — "Navigate to stop 1" becomes "Arrived at Seaside Housing".
 */
export function useNavMemory(runId: string): { navigated: (key: string) => boolean; remember: (key: string) => void; forget: (key: string) => void } {
  const prefix = `alto:drive:nav:${runId}:`;
  const read = useCallback(() => {
    const out = new Set<string>();
    try {
      for (let i = 0; i < window.sessionStorage.length; i++) {
        const k = window.sessionStorage.key(i);
        if (k?.startsWith(prefix)) out.add(k.slice(prefix.length));
      }
    } catch {
      /* storage is a convenience */
    }
    return out;
  }, [prefix]);
  const [keys, setKeys] = useState<Set<string>>(read);
  useEffect(() => setKeys(read()), [read]);
  const write = (key: string, on: boolean) => {
    try {
      if (on) window.sessionStorage.setItem(prefix + key, String(Date.now()));
      else window.sessionStorage.removeItem(prefix + key);
    } catch {
      /* storage is a convenience */
    }
    setKeys((k) => {
      const n = new Set(k);
      if (on) n.add(key);
      else n.delete(key);
      return n;
    });
  };
  return { navigated: (key) => keys.has(key), remember: (key) => write(key, true), forget: (key) => write(key, false) };
}
