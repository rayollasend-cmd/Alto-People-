import type { ReactNode } from 'react';
import { ArrowLeft, ScanLine } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@/lib/cn';
import { fmtTime } from '@/lib/format';
import { getActiveTimeEntry } from '@/lib/timeApi';
import { Button } from '@/components/ui/Button';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { PageHeader } from '@/components/ui/PageHeader';
import { AssociateTimeView } from './AssociateTimeView';
import { AdminTimeView } from './AdminTimeView';
import { MyTimesheet } from './MyTimesheet';
import { MyWeekHours } from './MyWeekHours';

export function TimeHome() {
  const { user, can } = useAuth();
  const isAssociate = user?.role === 'ASSOCIATE';
  const canManage = can('manage:time');
  const hasAssociateRecord = !!user?.associateId;
  const [searchParams] = useSearchParams();

  // Hourly associates use the kiosk PIN at the worksite, not their phone.
  // Show an explainer; the API would return 403 either way.
  if (isAssociate) {
    return <AssociateKioskOnlyView />;
  }

  // FLOOR_SUPERVISOR: watch-only. The live board — no approval queue, no
  // add-entry, no walk-in decisions. They punch at the store tablet only
  // (the API refuses app punches), so their own clock is a read-only row
  // under the title, and "My time" is their timesheet.
  if (user?.role === 'FLOOR_SUPERVISOR') {
    if (hasAssociateRecord && searchParams.get('mine') === '1') {
      return (
        <AssociateKioskOnlyView
          title="My time"
          body="Floor supervisors clock in and out at the store tablet with their 4-digit PIN — not in the app. Your punches land here."
          headerActions={
            <Button size="sm" variant="ghost" asChild>
              <Link to="/time-attendance">
                <ArrowLeft className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                The floor
              </Link>
            </Button>
          }
        />
      );
    }
    return (
      <AdminTimeView
        canManage={false}
        liveOnly
        personal={hasAssociateRecord ? <TabletClockStrip /> : undefined}
      />
    );
  }

  // People who run the floor AND punch themselves (manage:time + an
  // associate record — supervisors, managers): ONE page, the floor, with
  // their own clock as a slim row under the title (still one tap to clock
  // in from the phone). Their history and attendance are "My time" —
  // ?mine=1 — with the way back in its header. It used to stack both full
  // pages, two "Time & attendance" titles deep.
  if (canManage && hasAssociateRecord) {
    if (searchParams.get('mine') === '1') {
      return (
        <AssociateTimeView
          headerActions={
            <Button size="sm" variant="ghost" asChild>
              <Link to="/time-attendance">
                <ArrowLeft className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                The floor
              </Link>
            </Button>
          }
        />
      );
    }
    return <AdminTimeView canManage={canManage} personal={<AssociateTimeView variant="strip" />} />;
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

/** The viewer's own clock, read-only — for someone who punches at the
 *  store tablet only (a floor supervisor). */
function TabletClockStrip() {
  const q = useQuery({ queryKey: ['time', 'active'], queryFn: getActiveTimeEntry, staleTime: 30_000 });
  const active = q.data?.active ?? null;
  return (
    <section
      aria-label="Your own clock"
      className={cn(
        'mb-5 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border px-4 py-3',
        active ? 'border-gold/40 bg-gold/[0.06]' : 'border-navy-secondary bg-navy-secondary/20',
      )}
    >
      <ScanLine className={cn('h-5 w-5 shrink-0', active ? 'text-gold' : 'text-silver')} aria-hidden="true" />
      <div className="min-w-[11rem] flex-1">
        <div className="text-2xs font-medium uppercase tracking-wider text-silver/60">Your clock</div>
        <div className="text-sm text-white">
          {q.data === undefined
            ? '…'
            : active
              ? `On the clock since ${fmtTime(active.clockInAt)}`
              : 'Not clocked in'}
        </div>
        <div className="text-xs text-silver">Punch in and out at the store tablet with your PIN.</div>
      </div>
      <Link to="/time-attendance?mine=1" className="text-xs text-gold underline-offset-2 hover:underline">
        My time →
      </Link>
    </section>
  );
}

function AssociateKioskOnlyView({
  title,
  body,
  headerActions,
}: { title?: string; body?: string; headerActions?: ReactNode } = {}) {
  const { t } = useI18n();
  return (
    <div className="mx-auto">
      <PageHeader
        title={title ?? t('time.title')}
        subtitle={t('time.subtitle')}
        secondaryActions={headerActions}
      />
      {/* The week first: worked against scheduled, and the 40h line. */}
      <MyWeekHours />
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
            {body ?? t('time.kioskBody')}
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
