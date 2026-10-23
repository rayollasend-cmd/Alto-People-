import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { Award, BadgeCheck, GraduationCap, IdCard, type LucideIcon } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { getPublicWallet, type WalletItem } from '@/lib/walletApi';
import { fmtDate } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Logo } from '@/components/Logo';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { LinkProblem } from '@/components/LinkProblem';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * A shared credential wallet, read by whoever holds the link: another
 * employer, a client's HR, a program sponsor. No login. The name and the
 * credentials, read live — a credential revoked after sharing is gone —
 * and the day the link stops working.
 */

const KIND_ICON: Record<WalletItem['kind'], LucideIcon> = { qualification: Award, training: GraduationCap, document: BadgeCheck };
const KIND_LABEL: Record<WalletItem['kind'], string> = { qualification: 'Qualification', training: 'Training', document: 'Verified document' };
const STATE_LABEL: Record<WalletItem['state'], string> = { valid: 'Valid', expiring: 'Expiring soon', expired: 'Expired' };

export function WalletVerifyPage() {
  const { token = '' } = useParams();
  const q = useQuery({ queryKey: ['wallet', 'public', token], queryFn: () => getPublicWallet(token), retry: false, enabled: token.length > 0 });
  // 410: a real link past its days; 404: not a link anyone shared (F500 G5).
  const expired = q.error instanceof ApiError && q.error.status === 410;
  const invalid = q.error instanceof ApiError && q.error.status === 404;

  return (
    <div className="min-h-screen bg-gradient-to-br from-midnight via-navy to-navy-secondary text-ink">
      <main className="mx-auto w-full max-w-xl px-4 py-10 sm:py-16">
        <div className="flex items-center gap-3">
          <Logo size="sm" />
          <span className="text-xs uppercase tracking-widest text-silver/70">Verified credentials</span>
        </div>
        {q.isError ? (
          <LinkProblem
            className="mt-8"
            kind={expired ? 'expired' : invalid ? 'invalid' : 'error'}
            title={expired ? 'This shared link has expired' : invalid ? 'This link isn’t valid' : 'Could not open this link'}
            reason={
              expired
                ? 'Shared credentials stop showing on the day the person chose. Ask them to share a new link from their credentials page.'
                : invalid
                  ? 'It may have been cut off when it was copied. Ask the person to send it again.'
                  : 'Try again in a moment.'
            }
          />
        ) : !q.data ? (
          <Skeleton className="mt-8 h-64" />
        ) : (
          <section className="mt-8 rounded-lg border border-navy-secondary bg-navy p-6" data-testid="wallet-public">
            <PageHeader
              title={q.data.person.name}
              subtitle={`${q.data.items.length} ${q.data.items.length === 1 ? 'credential' : 'credentials'} on record${q.data.expiresAt ? ` · this link works until ${fmtDate(q.data.expiresAt)}` : ''}`}
            />
            {q.data.items.length === 0 ? (
              <EmptyState icon={IdCard} title="No credentials on record" description="The employer has not recorded any for this person." className="mt-6" />
            ) : (
              <ul className="mt-5 divide-y divide-navy-secondary/60">
                {q.data.items.map((item) => {
                  const Icon = KIND_ICON[item.kind];
                  return (
                    <li key={`${item.kind}-${item.id}`} className="flex items-start gap-3 py-3">
                      <span className={cn('mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full', item.state === 'expired' ? 'bg-alert/10 text-alert' : 'bg-gold/10 text-gold')} aria-hidden="true">
                        <Icon className="h-4 w-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="text-sm font-medium">{item.title}</span>
                          <Badge variant={item.state === 'valid' ? 'success' : item.state === 'expiring' ? 'pending' : 'destructive'} size="sm">
                            {STATE_LABEL[item.state]}
                          </Badge>
                        </div>
                        <div className="mt-0.5 text-xs text-silver">
                          {KIND_LABEL[item.kind]}
                          {item.issuer ? ` · ${item.issuer}` : ''}
                        </div>
                        <div className="mt-0.5 text-xs text-silver/70 tabular-nums">
                          {item.earnedAt ? `Earned ${fmtDate(item.earnedAt)}` : ''}
                          {item.earnedAt && ' · '}
                          {item.expiresAt ? `Expires ${fmtDate(item.expiresAt)}` : 'No expiry'}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="mt-6 text-2xs text-silver/60">Read live from the employer’s records at the moment you opened this page.</p>
          </section>
        )}
      </main>
    </div>
  );
}
