import { ScanLine } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { PageHeader } from '@/components/ui/PageHeader';
import { AssociateTimeView } from './AssociateTimeView';
import { AdminTimeView } from './AdminTimeView';
import { MyTimesheet } from './MyTimesheet';

export function TimeHome() {
  const { user, can } = useAuth();
  const isAssociate = user?.role === 'ASSOCIATE';
  const canManage = can('manage:time');
  const hasAssociateRecord = !!user?.associateId;

  // Hourly associates use the kiosk PIN at the worksite, not their phone.
  // Show an explainer; the API would return 403 either way.
  if (isAssociate) {
    return <AssociateKioskOnlyView />;
  }

  // FLOOR_SUPERVISOR: watch-only. The live board and nothing else — no
  // approval queue, no add-entry, no walk-in decisions.
  if (user?.role === 'FLOOR_SUPERVISOR') {
    return <AdminTimeView canManage={false} liveOnly />;
  }

  // Managers (manage:time + an associate record) see BOTH: a personal
  // clock-in widget at the top (so they can punch their own time from
  // their phone) and the team approval queue below.
  if (canManage && hasAssociateRecord) {
    return (
      <div className="space-y-8">
        <AssociateTimeView />
        <AdminTimeView canManage={canManage} />
      </div>
    );
  }

  // Managers without an associate record (e.g. the bootstrap HR_ADMIN before
  // an Associate row has been provisioned for them) see only the queue.
  if (canManage) {
    return <AdminTimeView canManage={canManage} />;
  }

  // Non-associate, non-manager roles with view:time (e.g. EXECUTIVE_CHAIRMAN,
  // FINANCE_ACCOUNTANT) — read-only queue.
  if (hasAssociateRecord) {
    return <AssociateTimeView />;
  }
  return <AdminTimeView canManage={false} />;
}

function AssociateKioskOnlyView() {
  const { t } = useI18n();
  return (
    <div className="mx-auto">
      <PageHeader
        title={t('time.title')}
        subtitle={t('time.subtitle')}
      />
      {/* Compact kiosk note — the "how punches happen" explainer stays,
          but the timesheet below is the primary content of this page,
          not a dead end. */}
      <div className="rounded-lg border border-navy-secondary bg-navy/40 p-4 mb-6 flex items-start gap-3">
        <ScanLine className="h-5 w-5 text-gold shrink-0 mt-0.5" aria-hidden="true" />
        <div className="min-w-0">
          <h2 className="text-white text-sm font-medium">
            {t('time.kioskHeading')}
          </h2>
          <p className="text-silver text-xs leading-relaxed mt-0.5">
            {t('time.kioskBody')}
          </p>
        </div>
      </div>
      {/* The receipt side: every kiosk punch with in/out times, net
          hours, and review status — the page the dashboard's
          "My timesheet" quick link promises. */}
      <MyTimesheet />
    </div>
  );
}
