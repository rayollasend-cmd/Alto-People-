import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, MessageSquare } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { PortalRequests, type ReqKind, type RequestPrefill } from './PortalRequests';

/**
 * Requests as a destination of its own — the fourth tab on a phone and a
 * sidebar entry on the web. Deep link: `?new=STAFFING&subject=…` opens
 * the dialog pre-filled (the morning digest's "request cover" action),
 * consumed once so a refresh doesn't reopen it.
 */
const KINDS: ReqKind[] = ['STAFFING', 'FEEDBACK', 'ISSUE', 'BILLING'];

export function PortalRequestsPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [prefill, setPrefill] = useState<RequestPrefill | null>(null);

  useEffect(() => {
    const raw = searchParams.get('new');
    if (!raw) return;
    const kind = KINDS.includes(raw as ReqKind) ? (raw as ReqKind) : 'STAFFING';
    setPrefill({
      kind,
      subject: searchParams.get('subject') ?? '',
      body: searchParams.get('body') ?? '',
      nonce: Date.now(),
    });
    const next = new URLSearchParams(searchParams);
    next.delete('new');
    next.delete('subject');
    next.delete('body');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  if (user?.role !== 'CLIENT_PORTAL') {
    return <EmptyState icon={MessageSquare} title={t('portal.noAccess')} description="" />;
  }
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader
        title={t('portal.reqTitle')}
        subtitle={t('portal.reqDialogHint')}
        breadcrumbs={[{ label: t('portal.title'), to: '/portal' }]}
        secondaryActions={
          <Button size="sm" variant="ghost" asChild>
            <Link to="/portal">
              <ArrowLeft className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              {t('portal.backHome')}
            </Link>
          </Button>
        }
      />
      <PortalRequests prefill={prefill} />
    </div>
  );
}
