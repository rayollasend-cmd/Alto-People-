import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuthIfMounted } from '@/lib/navTrail';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Award, BadgeCheck, Copy, Download, Expand, GraduationCap, IdCard, QrCode, Share2, UserRound, type LucideIcon } from '@/components/ui/icons';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { getMyWallet, getWorkerBadge, shareMyWallet, type WalletItem } from '@/lib/walletApi';
import { createCredentialOffer, getMyCredentials, saveCredentialFile } from '@/lib/credentialsApi';
import { calendarDay, fmtDate, fmtTime } from '@/lib/format';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { ListTemplate } from '@/components/templates';
import { WorkerBadgeCard } from './WorkerBadgeCard';
import '@/lib/i18n/en/badge';
import '@/lib/i18n/en/wallet';

/**
 * The credential wallet — what this person has earned, carried with them:
 * qualifications, completed training, verified credential documents, each
 * with its expiry. "Share a link" makes a signed link another employer can
 * open for a while; it shows the name and these items and nothing else.
 * Qualifications and trainings are also W3C Verifiable Credentials (Open
 * Badges 3.0): download one as a signed file, or add them all to a wallet
 * app from a QR code; anyone can check them at /verify.
 */

const KIND_ICON: Record<WalletItem['kind'], LucideIcon> = { qualification: Award, training: GraduationCap, document: BadgeCheck };
const KIND_KEY: Record<WalletItem['kind'], MessageKey> = { qualification: 'wallet.kind.qualification', training: 'wallet.kind.training', document: 'wallet.kind.document' };
const STATE_KEY: Record<WalletItem['state'], MessageKey> = { valid: 'wallet.state.valid', expiring: 'wallet.state.expiring', expired: 'wallet.state.expired' };
const STATE_VARIANT: Record<WalletItem['state'], 'success' | 'pending' | 'destructive'> = { valid: 'success', expiring: 'pending', expired: 'destructive' };

export function WalletItemRow({ item, onDownload, downloading }: { item: WalletItem; onDownload?: (item: WalletItem) => void; downloading?: boolean }) {
  const { t } = useI18n();
  const Icon = KIND_ICON[item.kind];
  return (
    <li className="flex items-start gap-3 py-3">
      <span className={cn('mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full', item.state === 'expired' ? 'bg-alert/10 text-alert' : 'bg-accent/10 text-accent')} aria-hidden="true">
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium text-ink">{item.title}</span>
          <Badge variant={STATE_VARIANT[item.state]} size="sm">
            {t(STATE_KEY[item.state])}
          </Badge>
        </div>
        <div className="mt-0.5 text-xs text-ink-muted">
          {t(KIND_KEY[item.kind])}
          {item.issuer ? ` · ${item.issuer}` : ''}
        </div>
        <div className="mt-0.5 text-xs text-ink-muted tabular-nums">
          {item.earnedAt ? t('wallet.earned', { date: fmtDate(calendarDay(item.earnedAt)) }) : null}
          {item.earnedAt && ' · '}
          {item.expiresAt ? t('wallet.expires', { date: fmtDate(calendarDay(item.expiresAt)) }) : t('wallet.noExpiry')}
        </div>
      </div>
      {onDownload && item.kind !== 'document' && (
        <Button size="icon-sm" variant="ghost" onClick={() => onDownload(item)} loading={downloading} aria-label={t('wallet.downloadAria', { title: item.title })} title={t('wallet.download')}>
          <Download className="h-4 w-4" aria-hidden="true" />
        </Button>
      )}
    </li>
  );
}

export function MyWallet() {
  const { t } = useI18n();
  // The wallet is an employee record's (the API refuses any other sign-in):
  // don't ask, and say so — not "Could not load your credentials. Retry"
  // for a request that can never succeed (CRAWL-15).
  const auth = useAuthIfMounted();
  const hasPerson = !auth?.user || !!auth.user.associateId;
  const q = useQuery({ queryKey: ['me', 'wallet'], queryFn: getMyWallet, enabled: hasPerson });
  const qc = useQueryClient();
  const [shareOpen, setShareOpen] = useState(false);
  const [appOpen, setAppOpen] = useState(false);
  // The badge is what a worker opens this page for: "Show badge" is the
  // page's primary action (F500 G5). Same query the card reads.
  const badgeQ = useQuery({ queryKey: ['me', 'wallet', 'badge'], queryFn: getWorkerBadge, retry: false, enabled: hasPerson });
  const [badgeFull, setBadgeFull] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const items = q.data?.items ?? [];
  const signable = items.some((i) => i.kind !== 'document');

  // The signed form of one credential, fetched when asked for (signing happens on the server).
  const download = async (item: WalletItem) => {
    setDownloading(item.id);
    try {
      const { credentials } = await qc.fetchQuery({ queryKey: ['me', 'wallet', 'credentials'], queryFn: getMyCredentials, staleTime: 60_000 });
      const found = credentials.find((c) => c.subjectId === item.id);
      if (!found) throw new Error('missing');
      saveCredentialFile(item.title, found.credential);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('wallet.offerFailed'));
    } finally {
      setDownloading(null);
    }
  };

  if (!hasPerson) {
    return (
      <ListTemplate title={t('wallet.title')}>
        <EmptyState
          icon={UserRound}
          title={t('wallet.noPersonTitle')}
          description={t('wallet.noPersonBody')}
          action={
            <Button asChild>
              <Link to="/settings">{t('wallet.noPersonCta')}</Link>
            </Button>
          }
        />
      </ListTemplate>
    );
  }

  return (
    <ListTemplate
      title={t('wallet.title')}
      subtitle={t('wallet.subtitle')}
      breadcrumbs={[{ label: t('wallet.crumb'), to: '/me' }, { label: t('wallet.title') }]}
      primaryAction={
        badgeQ.data ? (
          <Button onClick={() => setBadgeFull(true)} data-testid="wallet-show-badge">
            <Expand className="mr-2 h-4 w-4" aria-hidden="true" />
            {t('badge.show')}
          </Button>
        ) : undefined
      }
    >
      {/* The worker badge — kiosk QR / NFC and Apple / Google Wallet (WorkerBadgeCard). */}
      <WorkerBadgeCard fullOpen={badgeFull} onFullOpenChange={setBadgeFull} />
      {/* The credentials and their two ways out, together: a link for an employer,
          or W3C digital credentials. "Wallet" is only the Apple / Google pass above. */}
      <div className="space-y-2">
        <SectionTitle title={t('wallet.credTitle')} className="mb-0" />
        {/* Its own row: beside the heading on a phone, the two buttons squeezed the title to nothing. */}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => setShareOpen(true)} disabled={!q.data || items.length === 0}>
            <Share2 className="mr-1.5 h-4 w-4" aria-hidden="true" />
            {t('wallet.share')}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setAppOpen(true)} disabled={!q.data || !signable} data-testid="wallet-cred-share">
            <QrCode className="mr-1.5 h-4 w-4" aria-hidden="true" />
            {t('wallet.credShare')}
          </Button>
        </div>
      </div>
      {q.isError ? (
        <ErrorBanner
          action={
            <Button size="sm" variant="outline" onClick={() => void q.refetch()}>
              {t('common.retry')}
            </Button>
          }
        >
          {t('wallet.loadFailed')}
        </ErrorBanner>
      ) : !q.data ? (
        <Skeleton className="h-48" />
      ) : items.length === 0 ? (
        <EmptyState icon={IdCard} title={t('wallet.empty')} description={t('wallet.emptyDesc')} />
      ) : (
        <Card>
          <CardContent className="px-5 py-1">
            <ul className="divide-y divide-line">
              {items.map((i) => (
                <WalletItemRow key={`${i.kind}-${i.id}`} item={i} onDownload={(it) => void download(it)} downloading={downloading === i.id} />
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
      <ShareDialog open={shareOpen} onOpenChange={setShareOpen} />
      <AddToAppDialog open={appOpen} onOpenChange={setAppOpen} />
    </ListTemplate>
  );
}

function ShareDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useI18n();
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);

  const create = async () => {
    setBusy(true);
    try {
      const r = await shareMyWallet(days);
      setLink({ url: `${window.location.origin}${r.path}`, expiresAt: r.expiresAt });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('wallet.shareFailed'));
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      toast.success(t('wallet.copied'));
    } catch {
      toast.error(t('common.wentWrong'));
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (busy) return;
        onOpenChange(o);
        if (!o) setLink(null);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('wallet.shareTitle')}</DialogTitle>
          <DialogDescription>{t('wallet.shareBody')}</DialogDescription>
        </DialogHeader>
        {link ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Input readOnly value={link.url} aria-label={t('wallet.share')} onFocus={(e) => e.currentTarget.select()} />
              <Button variant="secondary" onClick={() => void copy()}>
                <Copy className="mr-1.5 h-4 w-4" aria-hidden="true" />
                {t('wallet.copy')}
              </Button>
            </div>
            <p className="text-xs text-ink-muted">{t('wallet.linkExpires', { date: fmtDate(link.expiresAt) })}</p>
          </div>
        ) : (
          <div role="radiogroup" aria-label={t('wallet.shareDays')} className="grid grid-cols-3 gap-2">
            {([7, 30, 90] as const).map((d) => (
              <button
                key={d}
                type="button"
                role="radio"
                aria-checked={days === d}
                onClick={() => setDays(d)}
                className={cn('rounded-md border px-3 py-2.5 text-sm coarse:min-h-11', days === d ? 'border-accent bg-accent/10 text-ink' : 'border-line text-ink-muted')}
              >
                {t(d === 7 ? 'wallet.days7' : d === 30 ? 'wallet.days30' : 'wallet.days90')}
              </button>
            ))}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('common.cancel')}
          </Button>
          {!link && (
            <Button onClick={() => void create()} loading={busy} disabled={busy}>
              {t('wallet.createLink')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Every signed credential, handed to a wallet app by a 15-minute link in a QR code — or saved as one file. */
function AddToAppDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useI18n();
  const [qr, setQr] = useState<string | null>(null);
  const offer = useMutation({ mutationFn: createCredentialOffer });
  const all = useQuery({ queryKey: ['me', 'wallet', 'credentials'], queryFn: getMyCredentials, enabled: open, staleTime: 60_000 });

  useEffect(() => {
    if (!open) {
      setQr(null);
      offer.reset();
      return;
    }
    offer.mutate(undefined, {
      onSuccess: async (o) => {
        try {
          const { default: QRCode } = await import('qrcode');
          setQr(await QRCode.toDataURL(o.url, { margin: 1, width: 240, errorCorrectionLevel: 'M' }));
        } catch {
          setQr(null); // an offer the encoder refuses shows the link alone
        }
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const verifyUrl = `${window.location.origin}/verify`;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('wallet.credShareTitle')}</DialogTitle>
          <DialogDescription>{t('wallet.credShareBody')}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col items-center gap-3">
          {offer.isError ? (
            <ErrorBanner
              action={
                <Button size="sm" variant="outline" onClick={() => offer.mutate()}>
                  {t('common.retry')}
                </Button>
              }
            >
              {t('wallet.offerFailed')}
            </ErrorBanner>
          ) : qr && offer.data ? (
            <>
              <img src={qr} alt={t('wallet.qrAlt')} width={240} height={240} className="rounded-lg border border-line bg-white p-2" />
              <p className="text-center text-xs text-ink-muted">{t('wallet.offerExpires', { time: fmtTime(offer.data.expiresAt) })}</p>
            </>
          ) : (
            <Skeleton className="h-[240px] w-[240px]" />
          )}
          <p className="text-center text-xs text-ink-muted">{t('wallet.verifyHint', { url: verifyUrl })}</p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="outline"
            disabled={!all.data?.credentials.length}
            loading={all.isLoading}
            onClick={() => all.data && saveCredentialFile('credentials', all.data.credentials.map((c) => c.credential))}
          >
            <Download className="mr-1.5 h-4 w-4" aria-hidden="true" />
            {t('wallet.downloadAll')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
