import { useState } from 'react';
import { useBreakAttestationPrompt } from '@/components/time/BreakAttestationPrompt';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@/lib/api';
import { getMySop } from '@/lib/opsApi';
import { clockIn, clockOut, getActiveTimeEntry, tryGetGeolocation } from '@/lib/timeApi';
import { hapticSuccess } from '@/lib/haptics';
import { toast } from '@/components/ui/Toaster';

/**
 * A supervisor's clock, wherever they are in the app — My floor, Store Ops,
 * the end of their SOP. Clocking in opens their store shift's SOP
 * (server-side) and takes them straight to it; clocking out while it's
 * open is refused, and takes them back to it.
 */
export function useShiftClock(options: { enabled?: boolean } = {}) {
  const enabled = options.enabled ?? true;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const q = useQuery({
    queryKey: ['time', 'active'],
    queryFn: getActiveTimeEntry,
    enabled,
    staleTime: 30_000,
  });
  const [busy, setBusy] = useState(false);

  const settle = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['time', 'active'] }),
      queryClient.invalidateQueries({ queryKey: ['ops', 'my-sop'] }),
    ]);

  const openSop = (id: string) => navigate(`/ops?tab=shift&shift=${id}`);

  const clockInNow = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const geo = await tryGetGeolocation();
      await clockIn({ geo: geo ?? undefined });
      hapticSuccess();
      await settle();
      const { sop } = await getMySop().catch(() => ({ sop: null }));
      if (sop) {
        toast.success(`Clocked in — your ${sop.windowLabel ?? ''} SOP is open. Submit it before you clock out.`);
        openSop(sop.id);
      } else {
        toast.success('Clocked in.');
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Clock-in failed.');
    } finally {
      setBusy(false);
    }
  };

  const breakPrompt = useBreakAttestationPrompt();
  const clockOutNow = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // Where the state requires breaks, ask before clocking out (lib/timeCorrections on the API).
      const breakAnswer = await breakPrompt.ask();
      if (breakAnswer === 'cancel') return;
      const geo = await tryGetGeolocation();
      await clockOut({ geo: geo ?? undefined, breakAttestation: breakAnswer });
      hapticSuccess();
      toast.success('Clocked out — good shift.');
      await settle();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'sop_open') {
        toast.error(err.message);
        const id = (err.details as { opsShiftId?: string } | undefined)?.opsShiftId;
        if (id) openSop(id);
      } else if (err instanceof ApiError && err.code === 'not_clocked_in') {
        toast.message("You're already clocked out.");
        await settle();
      } else {
        toast.error(err instanceof ApiError ? err.message : 'Clock-out failed.');
      }
    } finally {
      setBusy(false);
    }
  };

  return {
    /** The open time entry, null when off the clock, undefined while loading. */
    active: q.data ? q.data.active : undefined,
    busy,
    clockInNow,
    clockOutNow,
    /** The break question asked at clock-out; render it wherever the hook is used. */
    breakPrompt: breakPrompt.element,
  };
}
