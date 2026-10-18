import { useState } from 'react';
import { Banknote, Check, Copy, FlaskConical, Landmark, ShieldCheck, UserSearch, type LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import type { ProviderConnection, ProviderHealth, ProviderKind } from '@/lib/providersApi';
import { fmtDateTime, fmtRelativeDate } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { useConfirm, type ConfirmOptions } from '@/lib/confirm';

/** Shared words and pieces for the provider screens. */

export const KIND_ICON: Record<ProviderKind, LucideIcon> = {
  EVERIFY: ShieldCheck,
  BACKGROUND_CHECK: UserSearch,
  DRUG_TEST: FlaskConical,
  TAX_FILING: Landmark,
  PAYOUT: Banknote,
};

/** What each kind does when nothing is connected, and what connecting changes — plain words. */
export const KIND_COPY: Record<ProviderKind, { title: string; manual: string; connected: string }> = {
  EVERIFY: {
    title: 'E-Verify',
    manual: 'Cases are opened on the government site and the result is typed in here.',
    connected: 'Cases open straight from the I-9 and results come back on their own.',
  },
  BACKGROUND_CHECK: {
    title: 'Background checks',
    manual: 'Checks are ordered in the provider’s own site and recorded here by hand.',
    connected: 'Checks are ordered from here and reports come back on their own.',
  },
  DRUG_TEST: {
    title: 'Drug tests',
    manual: 'Tests are ordered with the lab directly and results are recorded here.',
    connected: 'Tests are ordered from here, with a donor pass emailed to the person.',
  },
  TAX_FILING: {
    title: 'Tax filing',
    manual: 'Forms are downloaded and filed through the agency or a partner, then marked filed.',
    connected: 'Forms are e-filed from here and the agency’s answer is recorded.',
  },
  PAYOUT: {
    title: 'Payouts',
    manual: 'Paychecks go out on the platform’s payment rail.',
    connected: 'Paychecks go out from your own Wise balance and returns are re-sent.',
  },
};

export const HEALTH_BADGE: Record<ProviderHealth, { label: string; variant: 'success' | 'destructive' | 'outline' | 'pending' }> = {
  healthy: { label: 'Working', variant: 'success' },
  failing: { label: 'Needs attention', variant: 'destructive' },
  not_tested: { label: 'Not tested yet', variant: 'pending' },
  paused: { label: 'Paused', variant: 'outline' },
};

export function environmentLabel(env: 'SANDBOX' | 'PRODUCTION'): string {
  return env === 'PRODUCTION' ? 'Live' : 'Sandbox';
}

/** One sentence on how the connection is doing, with the time. */
export function healthLine(c: ProviderConnection): string {
  switch (c.health) {
    case 'healthy':
      return c.lastSuccessAt ? `Last answered ${fmtRelativeDate(c.lastSuccessAt)}.` : 'The last test worked.';
    case 'failing':
      return `Failing since ${fmtDateTime(c.lastErrorAt)}${c.lastError ? `: ${c.lastError}` : '.'}`;
    case 'paused':
      return 'Paused — nothing is sent. Manual entry still works.';
    default:
      return 'Saved, but not tested. Test it before relying on it.';
  }
}

export const WHAT_TO_DO =
  'Check the credentials and the environment (sandbox keys don’t work live), then test again. If the provider itself is down, nothing is lost — the manual path still works.';

export function CopyValue({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="min-w-0">
      <div className="mb-1 text-xs text-ink-muted">{label}</div>
      <div className="flex items-center gap-2 rounded-md border border-line bg-surface-raised px-3 py-2">
        <code className="min-w-0 flex-1 break-all font-mono text-xs text-ink">{value}</code>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`Copy ${label.toLowerCase()}`}
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(
              () => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              },
              () => toast.error('Couldn’t copy — select it and copy by hand.'),
            );
          }}
        >
          {copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
        </Button>
      </div>
    </div>
  );
}

/**
 * The app's confirm dialog, or the browser's when a screen is rendered
 * outside the confirm provider (some drawers are mounted standalone in
 * tests and embeds). Always calls the same hook, so hook order is stable.
 */
export function useSafeConfirm(): (o: ConfirmOptions) => Promise<boolean> {
  try {
    return useConfirm();
  } catch {
    return async (o) => window.confirm(o.title);
  }
}
