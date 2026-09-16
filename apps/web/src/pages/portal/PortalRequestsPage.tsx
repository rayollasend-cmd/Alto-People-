import { Link } from 'react-router-dom';
import { ArrowLeft, MessageSquare } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { PortalRequests } from './PortalRequests';

/**
 * Requests as a destination of its own — the third tab on a phone and a
 * sidebar entry on the web, so the client never has to scroll the home
 * page to find the loop. Same component the home page embeds; the two
 * never disagree.
 */
export function PortalRequestsPage() {
  const { t } = useI18n();
  const { user } = useAuth();
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
      <PortalRequests />
    </div>
  );
}
