import type { ReactNode } from 'react';
import { PunchFixes } from './PunchFixes';
import { ArrowLeft, ScanLine } from '@/components/ui/icons';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@/lib/cn';
import { fmtPunchTime } from './punchFormat';
import { getActiveTimeEntry } from '@/lib/timeApi';
import { Button } from '@/components/ui/Button';
import { useAuth, useTerm } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { AssociateTimeView } from './AssociateTimeView';
import { AdminTimeView } from './AdminTimeView';
import { MyTimesheet } from './MyTimesheet';
import { ListTemplate } from '@/components/templates';
import { MyWeekHours } from './MyWeekHours';
import '@/lib/i18n/en/time';
import '@/lib/i18n/en/timeHome';
import '@/lib/i18n/en/timefix';

export function TimeHome() {
  const { user, can } = useAuth();
  const term = useTerm();
  const { t } = useI18n();
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
          title={t('time.myTime')}
          body={t('time.tabletOnlyBody', { role: term('role.floorSupervisor').toLowerCase() })}
          headerActions={
            <Button size="sm" variant="ghost" asChild>
              <Link to="/time-attendance">
                <ArrowLeft className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                {t('timeHome.theFloor')}
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
                {t('timeHome.theFloor')}
              </Link>
            </Button>
          }
        />
      );
    }
    return <AdminTimeView canManage={canManage} personal={<AssociateTimeView variant="strip" />} />;
  }

  // Staff without a person record (the bootstrap HR_ADMIN before one is
  // provisioned; a recruiter whose login was made in Users admin): the
  // queue, with a row that says their clock is not set up and what HR
  // must do. It used to be the queue alone — "I can't clock in" with
  // nothing on the screen saying why (2026-10-22).
  if (canManage) {
    return <AdminTimeView canManage={canManage} personal={<ClockNotSetUpStrip />} />;
  }

  // Non-associate, non-manager roles with view:time (e.g. EXECUTIVE_CHAIRMAN,
  // FINANCE_ACCOUNTANT) — read-only queue.
  if (hasAssociateRecord) {
    return <AssociateTimeView />;
  }
  return <AdminTimeView canManage={false} personal={<ClockNotSetUpStrip />} />;
}

/** A staff viewer who may clock in from the app but has no person record
 *  linked yet: the server would refuse with no_associate_record, so say so
 *  here, with the email HR must match. */
function ClockNotSetUpStrip() {
  const { t } = useI18n();
  const { user } = useAuth();
  return (
    <section
      aria-label={t('timeHome.ownClockAria')}
      className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-navy-secondary bg-navy-secondary/20 px-4 py-3"
    >
      <ScanLine className="h-5 w-5 shrink-0 text-silver" aria-hidden="true" />
      <div className="min-w-[11rem] flex-1">
        <div className="text-2xs font-medium uppercase tracking-wider text-silver/60">{t('timeHome.yourClock')}</div>
        <div className="text-sm text-ink">{t('timeHome.clockNotSetUp')}</div>
        <div className="text-xs text-silver">{t('timeHome.clockNotSetUpBody', { email: user?.email ?? '' })}</div>
      </div>
    </section>
  );
}

/** The viewer's own clock, read-only — for someone who punches at the
 *  store tablet only (a floor supervisor). */
function TabletClockStrip() {
  const { t } = useI18n();
  const q = useQuery({ queryKey: ['time', 'active'], queryFn: getActiveTimeEntry, staleTime: 30_000 });
  const active = q.data?.active ?? null;
  return (
    <section
      aria-label={t('timeHome.ownClockAria')}
      className={cn(
        'mb-5 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border px-4 py-3',
        active ? 'border-gold/40 bg-gold/[0.06]' : 'border-navy-secondary bg-navy-secondary/20',
      )}
    >
      <ScanLine className={cn('h-5 w-5 shrink-0', active ? 'text-gold' : 'text-silver')} aria-hidden="true" />
      <div className="min-w-[11rem] flex-1">
        <div className="text-2xs font-medium uppercase tracking-wider text-silver/60">{t('timeHome.yourClock')}</div>
        <div className="text-sm text-white">
          {q.data === undefined
            ? '…'
            : active
              ? t('timeHome.onClockSince', { time: fmtPunchTime(active.clockInAt, active.locationTimezone) })
              : t('timeHome.notClockedIn')}
        </div>
        <div className="text-xs text-silver">{t('time.tabletClockHint')}</div>
      </div>
      <Link to="/time-attendance?mine=1" className="text-xs text-gold underline-offset-2 hover:underline">
        {t('time.myTime')} →
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
  const [params, setParams] = useSearchParams();
  // "Fix a punch" is the page's action; PunchFixes opens its request on
  // ?fix=1 (the same link the inbox and MyWeekHours use).
  const openFix = () => {
    const next = new URLSearchParams(params);
    next.set('fix', '1');
    setParams(next);
  };
  return (
    // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
    <ListTemplate
        // The person's own view is "My time" — the same words as the home's
        // quick link and the floor's way back; "Time & attendance" is the
        // floor's title.
        title={title ?? t('time.myTime')}
        subtitle={t('time.subtitle')}
        actions={[{ key: 'fix', label: t('timefix.title'), onSelect: openFix }]}
        secondaryActions={headerActions}
    >
      {/* What needs them first — a shift they forgot to clock out of, extra
          hours offered, and their open requests (only when they have one;
          F500 G2: an empty "No requests yet" box led every visit). */}
      <PunchFixes quiet />
      {/* The week: worked against scheduled, and the 40h line. */}
      <MyWeekHours />
      {/* How punches happen, as one line; the explainer behind a disclosure
          instead of a 120px card on every visit. */}
      <details className="group mb-5 rounded-lg border border-navy-secondary bg-navy/40 px-4 py-2.5 text-sm">
        <summary className="flex cursor-pointer list-none items-center gap-2 text-silver marker:hidden [&::-webkit-details-marker]:hidden">
          <ScanLine className="h-4 w-4 shrink-0 text-gold" aria-hidden="true" />
          <span className="min-w-0 flex-1 text-white">{t('time.kioskHeading')}</span>
          <span className="shrink-0 text-xs text-gold underline-offset-2 group-open:hidden hover:underline">
            {t('time.howPunching')}
          </span>
        </summary>
        <p className="mt-2 text-xs leading-relaxed text-silver">{body ?? t('time.kioskBody')}</p>
      </details>
      {/* The receipt side: every kiosk punch with in/out times, net
          hours, and review status — the page the dashboard's
          "My timesheet" quick link promises. */}
      <MyTimesheet />
    </ListTemplate>
  );
}
