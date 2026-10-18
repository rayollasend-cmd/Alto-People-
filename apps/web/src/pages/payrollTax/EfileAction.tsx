import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useConfirm } from '@/lib/confirm';
import { fmtDateTime } from '@/lib/format';
import { efileForm, providerSummary, refreshEfile } from '@/lib/providersApi';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';

/**
 * E-file one form through the connected filing partner, and its status in
 * plain words: with the partner, at the agency, accepted (which files it),
 * or rejected with the agency's reason. Without a partner connected nothing
 * renders and "Mark filed" stays the way to record a filing.
 */

const STATUS: Record<'SUBMITTED' | 'SENT_TO_AGENCY' | 'ACCEPTED' | 'REJECTED', { label: string; variant: 'pending' | 'success' | 'destructive' }> = {
  SUBMITTED: { label: 'With the filing partner', variant: 'pending' },
  SENT_TO_AGENCY: { label: 'Sent to the agency', variant: 'pending' },
  ACCEPTED: { label: 'Accepted', variant: 'success' },
  REJECTED: { label: 'Rejected', variant: 'destructive' },
};

export function EfileStatus({ status, at, reason }: { status: keyof typeof STATUS | null | undefined; at?: string | null; reason?: string | null }) {
  if (!status) return null;
  const s = STATUS[status];
  return (
    <span className="inline-flex max-w-full flex-col items-start gap-0.5" title={at ? `Updated ${fmtDateTime(at)}` : undefined}>
      <Badge size="sm" variant={s.variant}>
        E-file: {s.label}
      </Badge>
      {status === 'REJECTED' && reason && <span className="max-w-[22rem] text-xs text-alert">{reason}</span>}
    </span>
  );
}

export function EfileAction({
  formId,
  formLabel,
  status,
  efileStatus,
  onChanged,
}: {
  formId: string;
  formLabel: string;
  status: string;
  efileStatus: keyof typeof STATUS | null | undefined;
  onChanged: () => void;
}) {
  const confirm = useConfirm();
  const summary = useQuery({ queryKey: ['providers', 'summary'], queryFn: providerSummary, staleTime: 60_000 });
  const partner = summary.data?.connected.TAX_FILING;
  const send = useMutation({
    mutationFn: () => efileForm(formId),
    onSuccess: (v) => {
      onChanged();
      if (v.efileStatus === 'REJECTED') toast.error(`Rejected: ${v.efileRejectionReason ?? 'see the reason on the form.'}`);
      else toast.success(v.efileStatus === 'ACCEPTED' ? 'Accepted and filed.' : 'Sent. The agency’s answer will appear here.');
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'The filing partner didn’t answer. Try again in a moment.'),
  });
  const check = useMutation({
    mutationFn: () => refreshEfile(formId),
    onSuccess: () => onChanged(),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Couldn’t check the filing.'),
  });

  if (!partner) return null;
  const canSend = (status === 'DRAFT' || status === 'AMENDED') && (!efileStatus || efileStatus === 'REJECTED');
  const waiting = efileStatus === 'SUBMITTED' || efileStatus === 'SENT_TO_AGENCY';

  if (canSend) {
    return (
      <Button
        size="sm"
        variant="secondary"
        loading={send.isPending}
        onClick={async () => {
          const ok = await confirm({
            title: efileStatus === 'REJECTED' ? `File the ${formLabel} again?` : `E-file the ${formLabel}?`,
            description: `${partner.label}${partner.environment === 'SANDBOX' ? ' (sandbox — nothing reaches the agency)' : ''} sends it to the agency as it is now. Check the amounts first; a filed return can only be corrected with an amendment.`,
            confirmLabel: efileStatus === 'REJECTED' ? 'File again' : 'E-file',
          });
          if (ok) send.mutate();
        }}
      >
        {efileStatus === 'REJECTED' ? 'File again' : 'E-file'}
      </Button>
    );
  }
  if (waiting) {
    return (
      <Button size="sm" variant="ghost" loading={check.isPending} onClick={() => check.mutate()}>
        Check status
      </Button>
    );
  }
  return null;
}
