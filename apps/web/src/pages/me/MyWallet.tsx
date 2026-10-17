import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Award, BadgeCheck, Copy, GraduationCap, IdCard, Share2, type LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { getMyWallet, shareMyWallet, type WalletItem } from '@/lib/walletApi';
import { fmtDate } from '@/lib/format';
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
import { ListTemplate } from '@/components/templates';

/**
 * The credential wallet — what this person has earned, carried with them:
 * qualifications, completed training, verified credential documents, each
 * with its expiry. "Share a link" makes a signed link another employer can
 * open for a while; it shows the name and these items and nothing else.
 */

const KIND_ICON: Record<WalletItem['kind'], LucideIcon> = { qualification: Award, training: GraduationCap, document: BadgeCheck };
const KIND_KEY: Record<WalletItem['kind'], MessageKey> = { qualification: 'wallet.kind.qualification', training: 'wallet.kind.training', document: 'wallet.kind.document' };
const STATE_KEY: Record<WalletItem['state'], MessageKey> = { valid: 'wallet.state.valid', expiring: 'wallet.state.expiring', expired: 'wallet.state.expired' };
const STATE_VARIANT: Record<WalletItem['state'], 'success' | 'pending' | 'destructive'> = { valid: 'success', expiring: 'pending', expired: 'destructive' };

export function WalletItemRow({ item }: { item: WalletItem }) {
  const { t } = useI18n();
  const Icon = KIND_ICON[item.kind];
  return (
    <li className="flex items-start gap-3 py-3">
      <span className={cn('mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full', item.state === 'expired' ? 'bg-alert/10 text-alert' : 'bg-gold/10 text-gold')} aria-hidden="true">
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium text-ink">{item.title}</span>
          <Badge variant={STATE_VARIANT[item.state]} size="sm">
            {t(STATE_KEY[item.state])}
          </Badge>
        </div>
        <div className="mt-0.5 text-xs text-silver">
          {t(KIND_KEY[item.kind])}
          {item.issuer ? ` · ${item.issuer}` : ''}
        </div>
        <div className="mt-0.5 text-xs text-silver/70 tabular-nums">
          {item.earnedAt ? t('wallet.earned', { date: fmtDate(item.earnedAt) }) : null}
          {item.earnedAt && ' · '}
          {item.expiresAt ? t('wallet.expires', { date: fmtDate(item.expiresAt) }) : t('wallet.noExpiry')}
        </div>
      </div>
    </li>
  );
}

export function MyWallet() {
  const { t } = useI18n();
  const q = useQuery({ queryKey: ['me', 'wallet'], queryFn: getMyWallet });
  const [shareOpen, setShareOpen] = useState(false);
  const items = q.data?.items ?? [];

  return (
    <ListTemplate
      className="space-y-5"
      title={t('wallet.title')}
      subtitle={t('wallet.subtitle')}
      breadcrumbs={[{ label: t('wallet.crumb'), to: '/me' }, { label: t('wallet.title') }]}
      primaryAction={
        <Button onClick={() => setShareOpen(true)} disabled={!q.data || items.length === 0}>
          <Share2 className="mr-2 h-4 w-4" aria-hidden="true" />
          {t('wallet.share')}
        </Button>
      }
    >
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
            <ul className="divide-y divide-navy-secondary/60">
              {items.map((i) => (
                <WalletItemRow key={`${i.kind}-${i.id}`} item={i} />
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
      <ShareDialog open={shareOpen} onOpenChange={setShareOpen} />
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
            <p className="text-xs text-silver">{t('wallet.linkExpires', { date: fmtDate(link.expiresAt) })}</p>
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
                className={cn('rounded-md border px-3 py-2.5 text-sm coarse:min-h-11', days === d ? 'border-gold bg-gold/[0.08] text-ink' : 'border-navy-secondary text-silver')}
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
