import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Expand, Eye, EyeOff, IdCard, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { getAppleWalletLink, getGoogleWalletLink, getWorkerBadge, type WorkerBadge } from '@/lib/walletApi';
import { useI18n } from '@/lib/i18n';
import { isNative, nativePlatform } from '@/lib/native/platform';
import { openInSystemBrowser } from '@/lib/native/shell';
import { hapticConfirm } from '@/lib/haptics';
import { cn } from '@/lib/cn';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Skeleton } from '@/components/ui/Skeleton';
import { SectionTitle } from '@/components/ui/SectionTitle';

/**
 * The worker's badge — the same design the Apple and Google Wallet passes
 * carry (lib/appleWallet.ts): brand navy, gold labels, the emblem, the
 * photo, name, role and site, the clock-in number, and the QR the kiosk
 * reads in place of the number. "Show badge" puts it full screen for the
 * kiosk camera; "Add to Apple Wallet" / "Save to Google Wallet" keep it on
 * the lock screen.
 *
 * Fixed colours, not theme tokens: a badge looks the same in light and
 * dark, exactly like the pass in Wallet.
 */

export const PASS = {
  bg: 'rgb(15 24 39)',
  label: 'rgb(217 185 103)',
  value: 'rgb(255 255 255)',
  muted: 'rgb(192 208 224)',
} as const;

function useQr(value: string | undefined, size: number): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (typeof value !== 'string' || !value) return;
    let live = true;
    // A value the encoder refuses draws no code; it never becomes an unhandled rejection.
    void import('qrcode')
      .then(({ default: QRCode }) => QRCode.toDataURL(value, { margin: 1, width: size, errorCorrectionLevel: 'M' }))
      .then((u) => {
        if (live) setUrl(u);
      })
      .catch(() => {
        if (live) setUrl(null);
      });
    return () => {
      live = false;
    };
  }, [value, size]);
  return url;
}

/**
 * The pass, drawn. `large` is the full-screen kiosk version. `masked`: the
 * clock-in number shows as •••• behind a tap, like Home and My profile —
 * a glance over a shoulder shouldn't leak the key to someone's punches
 * (F500 G5). The full-screen badge (held up at the kiosk) shows it.
 */
export function BadgeVisual({ badge, large = false, masked = false }: { badge: WorkerBadge; large?: boolean; masked?: boolean }) {
  const { t } = useI18n();
  const qr = useQr(badge.badgeToken, large ? 560 : 320);
  const [revealed, setRevealed] = useState(false);
  const hidden = masked && !revealed;
  return (
    <div
      className={cn('mx-auto w-full overflow-hidden rounded-2xl shadow-xl ring-1 ring-black/10', large ? 'max-w-sm' : 'max-w-[22rem]')}
      style={{ background: PASS.bg, color: PASS.value }}
      role="group"
      aria-label={t('badge.aria', { name: badge.workerName })}
    >
      <div className="flex items-center gap-3 px-5 pt-5">
        <img src="/brand/wallet-logo.png" alt="" className="h-9 w-9 rounded-full" />
        <div className="min-w-0 flex-1 truncate text-base font-semibold">{badge.employerName}</div>
        <div className="text-2xs font-semibold uppercase tracking-[0.14em]" style={{ color: PASS.label }}>
          {t('badge.kind')}
        </div>
      </div>
      <div className="flex items-center gap-4 px-5 pt-5">
        <div className="min-w-0 flex-1">
          <div className="text-2xs font-semibold uppercase tracking-[0.14em]" style={{ color: PASS.label }}>
            {t('badge.worker')}
          </div>
          <div className={cn('mt-0.5 font-display leading-tight', large ? 'text-3xl' : 'text-2xl')}>{badge.workerName}</div>
        </div>
        <Avatar src={badge.photoUrl} name={badge.workerName} size={large ? 'xl' : 'lg'} className="ring-2 ring-white/15" />
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 px-5 pt-4 text-sm">
        {badge.title && (
          <div className="min-w-0">
            <dt className="text-2xs font-semibold uppercase tracking-[0.14em]" style={{ color: PASS.label }}>
              {t('badge.role')}
            </dt>
            <dd className="truncate">{badge.title}</dd>
          </div>
        )}
        {badge.siteName && (
          <div className="min-w-0">
            <dt className="text-2xs font-semibold uppercase tracking-[0.14em]" style={{ color: PASS.label }}>
              {t('badge.site')}
            </dt>
            <dd className="truncate">{badge.siteName}</dd>
          </div>
        )}
        {badge.workerNumber && (
          <div className="min-w-0">
            <dt className="text-2xs font-semibold uppercase tracking-[0.14em]" style={{ color: PASS.label }}>
              {t('badge.number')}
            </dt>
            <dd className="flex items-center gap-1.5 font-mono text-base tracking-widest">
              <span data-testid="badge-number">{hidden ? '••••' : badge.workerNumber}</span>
              {masked && (
                <button
                  type="button"
                  onClick={() => setRevealed((v) => !v)}
                  className="inline-flex items-center rounded p-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent coarse:min-h-11 coarse:min-w-11 coarse:justify-center"
                  style={{ color: PASS.label }}
                  aria-label={revealed ? t('dash.hideNumber') : t('dash.showNumber')}
                  aria-pressed={revealed}
                >
                  {revealed ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
                </button>
              )}
            </dd>
          </div>
        )}
      </dl>
      <div className="flex flex-col items-center px-5 pb-5 pt-5">
        <div className="rounded-xl bg-white p-2.5">
          {qr ? (
            <img src={qr} alt={t('badge.qrAlt')} className={large ? 'h-64 w-64' : 'h-36 w-36'} />
          ) : (
            <div className={cn('animate-pulse rounded bg-black/5', large ? 'h-64 w-64' : 'h-36 w-36')} />
          )}
        </div>
        <div className="mt-2 text-xs" style={{ color: PASS.muted }}>
          {badge.workerNumber && !hidden ? t('badge.qrCaptionNumber', { number: badge.workerNumber }) : t('badge.qrCaption')}
        </div>
      </div>
    </div>
  );
}

/** The wallet's own colours (black buttons, the platform's mark order). */
function WalletButton({ onClick, busy, children }: { onClick: () => void; busy: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      // The wallets' own button colours (black, white type) — fixed, like the pass.
      style={{ background: 'rgb(0 0 0)', color: PASS.value }}
      className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl px-4 text-sm font-medium shadow-sm transition hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60"
    >
      <Wallet className="h-4 w-4" aria-hidden="true" />
      {children}
    </button>
  );
}

/**
 * `fullOpen`/`onFullOpenChange`: the page's own "Show badge" (the header's
 * primary action on My credentials) opens the full-screen badge; the card
 * then drops its duplicate button.
 */
export function WorkerBadgeCard({ fullOpen, onFullOpenChange }: { fullOpen?: boolean; onFullOpenChange?: (open: boolean) => void } = {}) {
  const { t } = useI18n();
  const q = useQuery({ queryKey: ['me', 'wallet', 'badge'], queryFn: getWorkerBadge, retry: false });
  const [fullState, setFullState] = useState(false);
  const controlled = fullOpen !== undefined;
  const full = controlled ? fullOpen : fullState;
  const setFull = (open: boolean) => (onFullOpenChange ? onFullOpenChange(open) : setFullState(open));
  const [busy, setBusy] = useState<'apple' | 'google' | null>(null);

  const open = async (url: string) => {
    if (isNative()) await openInSystemBrowser(url);
    else window.location.assign(url);
  };

  const addApple = async () => {
    setBusy('apple');
    try {
      const { url } = await getAppleWalletLink();
      hapticConfirm();
      await open(url);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('badge.walletFailed'));
    } finally {
      setBusy(null);
    }
  };
  const addGoogle = async () => {
    setBusy('google');
    try {
      const { url } = await getGoogleWalletLink();
      hapticConfirm();
      await open(url);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('badge.walletFailed'));
    } finally {
      setBusy(null);
    }
  };

  if (q.isLoading) {
    return <Skeleton className="mx-auto h-[30rem] w-full max-w-[22rem] rounded-2xl" />;
  }
  if (q.isError) {
    const code = q.error instanceof ApiError ? q.error.code : null;
    if (code === 'no_badge') return null; // staff without a roster record: nothing to show
    if (code === 'no_clock_in_number') {
      return (
        <Card>
          <CardContent className="flex items-start gap-3 p-5">
            <IdCard className="mt-0.5 h-5 w-5 shrink-0 text-ink-muted" aria-hidden="true" />
            <div>
              <div className="text-sm font-medium text-ink">{t('badge.noNumberTitle')}</div>
              <p className="mt-1 text-sm text-ink-muted">{t('badge.noNumberBody')}</p>
            </div>
          </CardContent>
        </Card>
      );
    }
    return (
      <ErrorBanner
        action={
          <Button size="sm" variant="outline" onClick={() => void q.refetch()}>
            {t('common.retry')}
          </Button>
        }
      >
        {t('badge.loadFailed')}
      </ErrorBanner>
    );
  }
  const badge = q.data!;
  const platform = nativePlatform() ?? (/iPhone|iPad|Macintosh/.test(navigator.userAgent) ? 'ios' : /Android/.test(navigator.userAgent) ? 'android' : null);
  const appleBtn = badge.apple.available && platform !== 'android' && (
    <WalletButton key="apple" onClick={() => void addApple()} busy={busy === 'apple'}>
      {busy === 'apple' ? t('badge.adding') : t('badge.addApple')}
    </WalletButton>
  );
  const googleBtn = badge.google.available && platform !== 'ios' && (
    <WalletButton key="google" onClick={() => void addGoogle()} busy={busy === 'google'}>
      {busy === 'google' ? t('badge.adding') : t('badge.addGoogle')}
    </WalletButton>
  );
  const anyWallet = !!appleBtn || !!googleBtn;

  return (
    <section aria-labelledby="badge-heading" className="space-y-4">
      <SectionTitle
        id="badge-heading"
        title={t('badge.title')}
        description={t('badge.subtitle')}
        trailing={
          controlled ? undefined : (
            <Button variant="outline" size="sm" onClick={() => setFull(true)}>
              <Expand className="h-4 w-4" aria-hidden="true" />
              {t('badge.show')}
            </Button>
          )
        }
      />
      <BadgeVisual badge={badge} masked />
      {anyWallet ? (
        <div className="mx-auto flex max-w-[22rem] flex-col gap-2 sm:flex-row">{platform === 'android' ? [googleBtn, appleBtn] : [appleBtn, googleBtn]}</div>
      ) : (
        <p className="mx-auto max-w-[22rem] text-center text-xs text-ink-muted">{t('badge.walletOff')}</p>
      )}
      <Dialog open={full} onOpenChange={setFull}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('badge.fullTitle')}</DialogTitle>
            <DialogDescription>{t('badge.fullBody')}</DialogDescription>
          </DialogHeader>
          <BadgeVisual badge={badge} large />
        </DialogContent>
      </Dialog>
    </section>
  );
}
