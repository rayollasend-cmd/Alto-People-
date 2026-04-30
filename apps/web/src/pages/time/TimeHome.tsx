import { ScanLine } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { PageHeader } from '@/components/ui/PageHeader';
import { AssociateTimeView } from './AssociateTimeView';
import { AdminTimeView } from './AdminTimeView';

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
  return (
    <div className="max-w-3xl mx-auto">
      <PageHeader
        title="Time & Attendance"
        subtitle="Clock in at the worksite kiosk."
      />
      <div className="rounded-lg border border-navy-secondary bg-navy/40 p-8 text-center">
        <ScanLine className="mx-auto h-10 w-10 text-gold mb-4" />
        <h2 className="text-white text-lg font-medium mb-2">
          Use the time-clock tablet at your worksite
        </h2>
        <p className="text-silver text-sm leading-relaxed max-w-md mx-auto">
          Hourly associates clock in and out using the kiosk tablet
          installed at your site, not from a personal phone. Tap your
          4-digit PIN, take the selfie, and you're punched in. Ask your
          manager if you don't know your PIN yet.
        </p>
      </div>
    </div>
  );
}
