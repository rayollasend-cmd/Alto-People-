import { useState } from 'react';
import { Banknote, Building2, Calculator, CalendarCheck2, Check, Copy, CreditCard, FlaskConical, Landmark, Plug, ShieldCheck, UserSearch, type LucideIcon } from '@/components/ui/icons';
import { toast } from 'sonner';
import type { ProviderConnection, ProviderHealth, ProviderKind } from '@/lib/providersApi';
import { fmtDateTime, fmtRelativeDate } from '@/lib/format';
import { cn } from '@/lib/cn';
import { ApiError } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { useConfirm, type ConfirmOptions } from '@/lib/confirm';

/** Shared words and pieces for the provider screens. */

export const KIND_ICON: Record<ProviderKind, LucideIcon> = {
  EVERIFY: ShieldCheck,
  BACKGROUND_CHECK: UserSearch,
  DRUG_TEST: FlaskConical,
  TAX_FILING: Landmark,
  PAYOUT: Banknote,
  TAX_ENGINE: Calculator,
  EMBEDDED_PAYROLL: CalendarCheck2,
  ORIGINATION: Building2,
  BANK_FEED: CreditCard,
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
  TAX_ENGINE: {
    title: 'Tax engine',
    manual: 'State and local taxes are worked out by the built-in engine, each local rate reviewed with your tax adviser.',
    connected: 'State and local taxes come from your licensed engine; if it doesn’t answer, the built-in engine steps in and the run says so.',
  },
  EMBEDDED_PAYROLL: {
    title: 'Payroll tax filing and payment',
    manual: 'You pay each tax deposit and file each return yourself, then record the confirmation on the Payroll taxes desk.',
    connected: 'Your provider pays deposits and files returns from what payroll posts, under its penalty guarantee if your agreement has one.',
  },
  ORIGINATION: {
    title: 'Your bank (ACH)',
    manual: 'With payroll on your own ACH, deposits go out in a NACHA file you upload to your bank.',
    connected: 'Deposits and the funding debit go to your bank as ACH payment orders, and settlements and returns come back on their own.',
  },
  BANK_FEED: {
    title: 'Bank and card feeds',
    manual: 'Bank and card statements are uploaded to the books as CSV or OFX files and reconciled from there.',
    connected: 'Bank and card transactions arrive in the books on their own every few hours, ready to match and reconcile.',
  },
};

/** A kind's title mid-sentence ("Set up tax filing"), names kept as written ("E-Verify", "ACH"). */
export function titleInSentence(title: string): string {
  return /^[A-Z][a-z]/.test(title) ? title.charAt(0).toLowerCase() + title.slice(1) : title;
}

/**
 * The icon and words for a kind — a kind the server knows and this screen
 * doesn't yet (a newer API) reads as a plain connection instead of
 * breaking the page.
 */
export function kindLook(kind: string): { Icon: LucideIcon; copy: { title: string; manual: string; connected: string } } {
  const k = kind as ProviderKind;
  return {
    Icon: KIND_ICON[k] ?? Plug,
    copy: KIND_COPY[k] ?? { title: kind.charAt(0) + kind.slice(1).toLowerCase().replace(/_/g, ' '), manual: 'Recorded here by hand until a provider is connected.', connected: 'Connected.' },
  };
}

/**
 * One status vocabulary for every connection on Integrations (F500 G4):
 * Working · Needs attention · Failing · Not connected. A connection saved
 * but never tested, or paused, needs someone; one whose provider refuses
 * it is failing. The line under it (healthLine) says which.
 */
export type ConnectionWord = 'Working' | 'Needs attention' | 'Failing' | 'Not connected';
export const CONNECTION_BADGE: Record<ConnectionWord, 'success' | 'destructive' | 'outline' | 'pending'> = {
  Working: 'success',
  'Needs attention': 'pending',
  Failing: 'destructive',
  'Not connected': 'outline',
};
export const HEALTH_WORD: Record<ProviderHealth, ConnectionWord> = {
  healthy: 'Working',
  failing: 'Failing',
  not_tested: 'Needs attention',
  paused: 'Needs attention',
};
export const HEALTH_BADGE: Record<ProviderHealth, { label: ConnectionWord; variant: 'success' | 'destructive' | 'outline' | 'pending' }> = {
  healthy: { label: HEALTH_WORD.healthy, variant: CONNECTION_BADGE[HEALTH_WORD.healthy] },
  failing: { label: HEALTH_WORD.failing, variant: CONNECTION_BADGE[HEALTH_WORD.failing] },
  not_tested: { label: HEALTH_WORD.not_tested, variant: CONNECTION_BADGE[HEALTH_WORD.not_tested] },
  paused: { label: HEALTH_WORD.paused, variant: CONNECTION_BADGE[HEALTH_WORD.paused] },
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
      // The plain sentence first; the provider's own words sit behind "Technical details" (TechnicalDetail).
      return `${c.lastError ?? 'The last call failed.'} Failing since ${fmtDateTime(c.lastErrorAt)}.`;
    case 'paused':
      return 'Paused — nothing is sent. Manual entry still works.';
    default:
      return 'Saved, but not tested. Test it before relying on it.';
  }
}

/**
 * The provider's own words behind a failure ("Wise refused the token (HTTP
 * 401): Invalid token") — what support needs, not what the card leads with
 * (F500 2026-10-26). Folded; nothing when there is no detail.
 */
export function TechnicalDetail({ detail, className }: { detail: string | null | undefined; className?: string }) {
  if (!detail) return null;
  return (
    <details className={cn('group text-xs text-ink-muted', className)} data-testid="provider-error-detail">
      <summary className="inline-flex min-h-8 cursor-pointer list-none items-center underline-offset-2 hover:text-ink hover:underline [&::-webkit-details-marker]:hidden">
        Technical details
      </summary>
      <code className="mt-1 block break-words rounded-md bg-surface-raised px-2 py-1.5 font-mono text-2xs text-ink">{detail}</code>
    </details>
  );
}

/** The provider's own words on a failed call (a 502's `details.detail`), or null. */
export function apiErrorDetail(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  const d = e.details as { detail?: unknown } | null | undefined;
  return d && typeof d.detail === 'string' && d.detail.trim() ? d.detail : null;
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
