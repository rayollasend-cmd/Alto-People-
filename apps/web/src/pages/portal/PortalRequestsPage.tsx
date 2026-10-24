import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { MessageSquare, MessageSquarePlus } from '@/components/ui/icons';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { EmptyState } from '@/components/ui/EmptyState';
import { ListTemplate } from '@/components/templates';
import { PortalRequests, type ReqKind, type RequestPrefill } from './PortalRequests';
import '@/lib/i18n/en/portal';

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
    // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
    <ListTemplate
        className="mx-auto max-w-3xl"
        title={t('portal.reqTitle')}
        subtitle={t('portal.reqDialogHint')}
        // The trail is the way back to the store (the phone's Back too); the
        // "← My store" button beside it was a third control for the same trip.
        breadcrumbs={[{ label: t('portal.title'), to: '/portal' }, { label: t('portal.reqTitle') }]}
        // "Make a request" is the page's action, in its header — it sat inside
        // a card titled "Requests" under a page titled "Requests" (F500 G5).
        actions={[
          {
            key: 'new',
            label: t('portal.reqNew'),
            icon: MessageSquarePlus,
            primary: true,
            onSelect: () => setPrefill({ kind: 'STAFFING', subject: '', body: '', nonce: Date.now() }),
          },
        ]}
    >
      <PortalRequests prefill={prefill} bare tabs />
    </ListTemplate>
  );
}
