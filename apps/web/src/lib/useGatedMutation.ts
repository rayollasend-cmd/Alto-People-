import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import type { PendingApprovalResponse } from '@alto-people/shared';
import { ApiError } from './api';
import { useAuth } from './auth';
import { useI18n } from './i18n';
import { MY_REQUESTS_KEY, isPending, type Gated } from './approvalRequestsApi';
import '@/lib/i18n/en/appr';

/**
 * A change that may go to a second person (second-person approvals): a
 * bill-rate card, a pay-rate change, a job's rates. The route answers the
 * saved row, or 202 { pending, approvalId, title } — and a screen that toasts
 * "Rate updated" over the second told the user a rate changed that hadn't
 * (CODE-12 / MONEY-11: "Default rate saved", "Job updated", "Rate updated").
 *
 *   const save = useGatedMutation({
 *     mutationFn: (v: Vars) => upsertRateDefault(v),
 *     applied: (_row, v) => `Default rate saved for ${v.position}.`,
 *     failed: 'Could not save the rate.',
 *     onDone: refresh,
 *   });
 *
 * Landed: the `applied` toast and onApplied. Waiting: "Sent for approval"
 * with the request's title, a link to it, and onPending — the caller puts the
 * old value back on screen there (the new one is not in force).
 */
export interface GatedMutationOptions<TVars, TData, Extra extends object = object> {
  mutationFn: (vars: TVars) => Promise<Gated<TData, Extra>>;
  /** The toast when the change landed. */
  applied: string | ((data: TData, vars: TVars) => string);
  /** One line on what holds until the decision ("The old rate stays in force."); defaults to the request's title. */
  pendingNote?: string | ((p: PendingApprovalResponse & Extra, vars: TVars) => string);
  /** The error toast's title; the server's own sentence is its description. */
  failed: string;
  onApplied?: (data: TData, vars: TVars) => unknown;
  onPending?: (p: PendingApprovalResponse & Extra, vars: TVars) => unknown;
  /** After either answer (refresh the list). */
  onDone?: () => unknown;
}

/** Where a requester follows their request: the approvals record (their pending ones) when they can open it, else the approvals queue focused on it. */
export function approvalRequestHref(p: { approvalId: string }, who: { canRecord: boolean; userId: string | null }): string {
  if (who.canRecord && who.userId) return `/audit/approvals?status=PENDING&requester=${encodeURIComponent(who.userId)}`;
  return `/approvals?tab=requests&approval=${encodeURIComponent(p.approvalId)}`;
}

/**
 * The "Sent for approval" toast, for a call site that awaits the gated
 * function itself: `const res = await updateJob(…); if (isPending(res)) sent(res);`
 */
export function useSentForApproval(): (p: PendingApprovalResponse, note?: string) => void {
  const { t } = useI18n();
  const { can, user } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const canRecord = can('view:audit') || can('manage:org') || can('process:payroll');
  return (p, note) => {
    toast.success(t('appr.gated.sent'), {
      description: note ? `${p.title} — ${note}` : t('appr.gated.waiting', { title: p.title }),
      action: { label: t('appr.gated.view'), onClick: () => navigate(approvalRequestHref(p, { canRecord, userId: user?.id ?? null })) },
    });
    void qc.invalidateQueries({ queryKey: MY_REQUESTS_KEY });
  };
}

export function useGatedMutation<TVars, TData, Extra extends object = object>(
  opts: GatedMutationOptions<TVars, TData, Extra>,
): UseMutationResult<Gated<TData, Extra>, Error, TVars> {
  const sent = useSentForApproval();
  return useMutation<Gated<TData, Extra>, Error, TVars>({
    mutationFn: opts.mutationFn,
    onSuccess: async (res, vars) => {
      if (isPending(res)) {
        const p = res as PendingApprovalResponse & Extra;
        sent(p, typeof opts.pendingNote === 'function' ? opts.pendingNote(p, vars) : opts.pendingNote);
        await opts.onPending?.(p, vars);
      } else {
        const data = res as TData;
        toast.success(typeof opts.applied === 'function' ? opts.applied(data, vars) : opts.applied);
        await opts.onApplied?.(data, vars);
      }
      await opts.onDone?.();
    },
    onError: (err) => {
      toast.error(opts.failed, { description: err instanceof ApiError ? err.message : undefined });
    },
  });
}
