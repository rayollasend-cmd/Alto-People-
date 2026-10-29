import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  BadgeCheck,
  CalendarDays,
  Clock,
  ExternalLink,
  LifeBuoy,
  Mail,
  MessageSquare,
  MessageSquareText,
  Phone,
} from '@/components/ui/icons';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/cn';
import { useCrewCard, type CrewCard } from '@/lib/crewApi';
import { personPhotoUrl } from '@/lib/photoUrl';
import {
  fmtDateOnly,
  fmtDateOnlyRange,
  fmtPhone,
  fmtRelativeDayTz,
  fmtShiftRangeTz,
  fmtShiftTz,
  fmtWeekday,
  phoneHref,
} from '@/lib/format';
import { fmtClockMinute } from '@alto-people/shared';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Drawer, DrawerBody, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from '@/components/ui/Drawer';
import { QueryError } from '@/components/ui/QueryError';
import { Skeleton } from '@/components/ui/Skeleton';
import '@/lib/i18n/en/crew';
import '@/lib/i18n/en/portal';

/**
 * The crew card (FLOOR-17): the shift supervisor's read-only view of one of
 * her people — how to reach them, when they can work, what they're
 * certified for, how reliable they've been, their next shifts and who to
 * call in an emergency. She leads a client's crew but holds no view:org, so
 * the full record answered "You don't have access" at the very moment she
 * was deciding who to call.
 *
 * Opens for anyone holding message:crew (the field leads); the API
 * (GET /crew/:id) clamps to the caller's reach. Never pay — the API doesn't
 * send it. A role without message:crew gets the plain name (or the
 * record link, when it can open People), exactly as before.
 */

/** The company week, Saturday first (lib/workweek): Sat, Sun, Mon … Fri. */
const WEEK_ORDER = [6, 0, 1, 2, 3, 4, 5];

/** "Mon" for a day-of-week index (0 = Sunday), in the reader's language. */
function dayName(dow: number): string {
  // Jan 4, 2026 is a Sunday; noon UTC is the same calendar day in every US zone.
  return fmtWeekday(new Date(Date.UTC(2026, 0, 4 + dow, 12)));
}

/** True when this viewer opens crew cards (the field leads). */
export function useCanOpenCrew(): boolean {
  const { can } = useAuth();
  return can('message:crew');
}

/** The card itself, in a right-hand drawer (full width on a phone). */
export function CrewCardDrawer({
  associateId,
  open,
  onOpenChange,
  name,
  photoUrl,
}: {
  associateId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Shown while the card loads. */
  name?: string | null;
  /** The row's photo answer, when it has one (null = none on file). */
  photoUrl?: string | null;
}) {
  const { t } = useI18n();
  const query = useCrewCard(open ? associateId : null);
  const card = query.data ?? null;
  return (
    <Drawer open={open} onOpenChange={onOpenChange} width="max-w-md">
      <DrawerHeader>
        <div className="flex items-center gap-3">
          <Avatar
            src={personPhotoUrl({ associateId, photoUrl, hasPhoto: card ? card.hasPhoto : undefined })}
            name={card?.name ?? name ?? ''}
            email=""
            size="lg"
          />
          <div className="min-w-0">
            <DrawerTitle className="truncate text-xl">{card?.name ?? name ?? '—'}</DrawerTitle>
            <DrawerDescription className="truncate">
              {card ? [card.position, card.sites.map((s) => s.name).join(', ')].filter(Boolean).join(' · ') : ' '}
            </DrawerDescription>
          </div>
        </div>
        {card && (
          <p className={cn('mt-2 flex items-center gap-1.5 text-xs', card.onClock ? 'text-success' : 'text-ink-muted')} data-testid="crew-clock">
            <Clock className="h-3.5 w-3.5" aria-hidden="true" />
            {card.onClock
              ? t('crew.onClockSince', { time: fmtShiftTz(card.onClock.since, card.onClock.timezone, { day: false }) })
              : t('crew.offClock')}
            {card.hireDate && <span className="text-ink-muted"> · {t('crew.since', { date: fmtDateOnly(card.hireDate, { year: true }) })}</span>}
          </p>
        )}
      </DrawerHeader>
      <DrawerBody className="space-y-5 pt-0">
        {query.isError ? (
          <QueryError what={t('crew.what')} query={query} />
        ) : !card ? (
          <div className="space-y-3" aria-busy="true">
            <Skeleton className="h-11" />
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
          </div>
        ) : (
          <CrewCardBody card={card} />
        )}
      </DrawerBody>
      {card && <CrewCardFooter card={card} />}
    </Drawer>
  );
}

function Section({ title, icon: Icon, children, testId }: { title: string; icon: typeof Clock; children: ReactNode; testId?: string }) {
  return (
    <section data-testid={testId}>
      <h3 className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-ink-muted">
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        {title}
      </h3>
      {children}
    </section>
  );
}

const ACTION =
  'flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg border border-line px-2 py-1.5 text-xs text-ink transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright';

function CrewCardBody({ card }: { card: CrewCard }) {
  const { t } = useI18n();
  const tel = phoneHref(card.contact.phone);
  const first = card.firstName || card.name;
  const weekly = WEEK_ORDER.map((dow) => ({
    dow,
    spans: card.availability.weekly.filter((w) => w.dayOfWeek === dow),
  })).filter((d) => d.spans.length > 0);
  const a = card.attendance;
  const tallies = [
    a.late > 0 && t('crew.late', { count: a.late }),
    a.earlyOut > 0 && t('crew.earlyOut', { count: a.earlyOut }),
    a.callOuts > 0 && t('crew.callOuts', { count: a.callOuts }),
    a.noShows > 0 && t('crew.noShows', { count: a.noShows }),
  ].filter(Boolean);
  const ec = card.emergencyContact;
  const ecTel = phoneHref(ec?.phone);

  return (
    <>
      {/* ---- Reach them: call, text, message, email ---------------------- */}
      <div className="flex gap-2" data-testid="crew-contact">
        {tel ? (
          <>
            <a href={tel} className={ACTION} aria-label={t('crew.callX', { name: first })}>
              <Phone className="h-4 w-4" aria-hidden="true" />
              {t('crew.call')}
            </a>
            <a href={`sms:${card.contact.phone}`} className={ACTION} aria-label={t('crew.textX', { name: first })}>
              <MessageSquareText className="h-4 w-4" aria-hidden="true" />
              {t('crew.text')}
            </a>
          </>
        ) : null}
        {card.contact.messageUserId && (
          <Link to={`/messages?to=${card.contact.messageUserId}`} className={ACTION} aria-label={t('crew.messageX', { name: first })}>
            <MessageSquare className="h-4 w-4" aria-hidden="true" />
            {t('crew.message')}
          </Link>
        )}
        <a href={`mailto:${card.contact.email}`} className={ACTION} aria-label={t('crew.emailX', { name: first })}>
          <Mail className="h-4 w-4" aria-hidden="true" />
          {t('crew.email')}
        </a>
      </div>
      <p className="-mt-3 text-xs text-ink-muted tabular-nums">
        {card.contact.phone ? fmtPhone(card.contact.phone) : t('crew.noPhone')} · <span className="break-all">{card.contact.email}</span>
      </p>

      {/* ---- Next shifts ------------------------------------------------- */}
      <Section title={t('crew.nextShifts')} icon={CalendarDays} testId="crew-shifts">
        {card.nextShifts.length === 0 ? (
          <p className="text-sm text-ink-muted">{t('crew.noShifts')}</p>
        ) : (
          <ul className="space-y-2">
            {card.nextShifts.map((s) => (
              <li key={s.id} className="text-sm">
                <div className="text-ink tabular-nums">
                  {fmtRelativeDayTz(s.startsAt, s.timezone)} · {fmtShiftRangeTz(s.startsAt, s.endsAt, s.timezone)}
                </div>
                <div className="text-xs text-ink-muted">{[s.position, s.siteName].filter(Boolean).join(' · ')}</div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* ---- Availability ------------------------------------------------ */}
      <Section title={t('crew.availability')} icon={Clock} testId="crew-availability">
        {weekly.length === 0 ? (
          <p className="text-sm text-ink-muted">{t('crew.noAvailability')}</p>
        ) : (
          <dl className="grid grid-cols-[3.5rem_1fr] gap-x-2 gap-y-1 text-sm">
            {weekly.map((d) => (
              <div key={d.dow} className="contents">
                <dt className="text-ink-muted">{dayName(d.dow)}</dt>
                <dd className="text-ink tabular-nums">
                  {d.spans.map((w) => `${fmtClockMinute(w.startMinute)} – ${fmtClockMinute(w.endMinute)}`).join(', ')}
                </dd>
              </div>
            ))}
          </dl>
        )}
        {card.availability.unavailableDates.length > 0 && (
          <p className="mt-2 text-sm text-warning">
            {t('crew.cantWork', { dates: card.availability.unavailableDates.map((d) => fmtDateOnly(d, { year: 'auto' })).join(', ') })}
          </p>
        )}
        {card.availability.timeOff.map((r) => (
          <p key={`${r.from}-${r.to}`} className="mt-1 text-sm text-ink">
            {t('crew.timeOff', { range: fmtDateOnlyRange(r.from, r.to) })}
          </p>
        ))}
      </Section>

      {/* ---- Certifications ---------------------------------------------- */}
      <Section title={t('crew.credentials')} icon={BadgeCheck} testId="crew-credentials">
        {card.credentials.length === 0 ? (
          <p className="text-sm text-ink-muted">{t('crew.noCredentials')}</p>
        ) : (
          <ul className="divide-y divide-line">
            {card.credentials.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 py-1.5 text-sm">
                <span className="min-w-0 truncate text-ink">{c.name}</span>
                {c.status === 'expired' ? (
                  <Badge variant="destructive" size="sm">{t('crew.expired', { date: fmtDateOnly(c.expiresOn, { year: 'auto' }) })}</Badge>
                ) : c.status === 'expiring' ? (
                  <Badge variant="pending" size="sm">{t('crew.expires', { date: fmtDateOnly(c.expiresOn, { year: 'auto' }) })}</Badge>
                ) : (
                  <span className="shrink-0 text-xs text-ink-muted">
                    {c.expiresOn ? t('crew.expires', { date: fmtDateOnly(c.expiresOn, { year: 'auto' }) }) : t('crew.noExpiry')}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* ---- Attendance ---------------------------------------------------- */}
      <Section title={t('crew.attendance')} icon={CalendarDays} testId="crew-attendance">
        {a.recent.length === 0 && a.points === 0 ? (
          <p className="text-sm text-ink-muted">{t('crew.attendanceClean', { days: a.windowDays })}</p>
        ) : (
          <>
            <p className={cn('text-sm tabular-nums', a.points >= 3 ? 'text-warning' : 'text-ink')}>
              {t('crew.points', { count: a.points, days: a.windowDays })}
              {tallies.length > 0 && <span className="text-ink-muted"> · {tallies.join(' · ')}</span>}
            </p>
            <ul className="mt-1 space-y-0.5 text-xs text-ink-muted">
              {a.recent.map((e) => (
                <li key={e.id}>
                  {t(`crew.kind.${e.kind}` as const)} · {fmtDateOnly(e.on, { weekday: true, year: 'auto' })}
                  {e.excused && <span> · {t('crew.excused')}</span>}
                </li>
              ))}
            </ul>
          </>
        )}
      </Section>

      {/* ---- Emergency contact -------------------------------------------- */}
      <Section title={t('crew.emergency')} icon={LifeBuoy} testId="crew-emergency">
        {!ec ? (
          <p className="text-sm text-ink-muted">{t('crew.noEmergency')}</p>
        ) : (
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1 text-sm">
              <div className="truncate text-ink">
                {ec.name} <span className="text-ink-muted">· {t(`crew.rel.${ec.relation}` as const)}</span>
              </div>
              <div className="text-xs text-ink-muted tabular-nums">{fmtPhone(ec.phone)}</div>
            </div>
            {ecTel && (
              <a
                href={ecTel}
                className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-line text-ink hover:bg-surface-raised"
                aria-label={t('crew.callX', { name: ec.name })}
              >
                <Phone className="h-4 w-4" aria-hidden="true" />
              </a>
            )}
          </div>
        )}
      </Section>
    </>
  );
}

function CrewCardFooter({ card }: { card: CrewCard }) {
  const { t } = useI18n();
  const { can } = useAuth();
  return (
    <DrawerFooter className="items-center justify-between">
      <p className="text-xs text-ink-muted">{t('crew.readOnly')}</p>
      {can('view:org') && (
        <Link
          to={`/people/${card.id}`}
          className="flex min-h-11 shrink-0 items-center gap-1 text-sm text-accent underline-offset-2 hover:underline"
        >
          {t('crew.fullRecord')}
          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
      )}
    </DrawerFooter>
  );
}

/**
 * A person's name (or a whole row) that opens their crew card. For a role
 * without crew cards it renders the same children in a plain element, so
 * nothing about that page changes.
 */
export function CrewLink({
  associateId,
  name,
  children,
  className,
  block = false,
}: {
  associateId: string | null | undefined;
  name: string | null | undefined;
  children: ReactNode;
  className?: string;
  /** A block (a row's avatar + text) rather than an inline name. */
  block?: boolean;
}) {
  const { t } = useI18n();
  const canOpen = useCanOpenCrew();
  const [open, setOpen] = useState(false);
  if (!associateId || !canOpen) {
    return block ? <div className={className}>{children}</div> : <span className={className}>{children}</span>;
  }
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t('crew.openCard', { name: name ?? '' })}
        aria-haspopup="dialog"
        className={cn(
          block
            ? '-my-1 rounded-md py-1 text-left transition-colors hover:bg-navy-secondary/30'
            : 'rounded-sm text-left hover:text-gold hover:underline',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
          className,
        )}
        data-testid="crew-link"
      >
        {children}
      </button>
      <CrewCardDrawer associateId={associateId} name={name} open={open} onOpenChange={setOpen} />
    </>
  );
}

/**
 * The faces on the floor (the supervisor's Home hero): each one opens that
 * person's crew card; "+N" opens the whole floor. Without crew cards the
 * stack is one link to the floor, as it always was. On a touch screen the
 * faces stop overlapping and each gets a 44 px target (six fit at 390).
 */
export function CrewFaces({
  people,
  moreTo,
  className,
}: {
  people: Array<{ associateId: string; name: string; photoUrl?: string | null }>;
  moreTo: string;
  className?: string;
}) {
  const { t } = useI18n();
  const canOpen = useCanOpenCrew();
  const [openId, setOpenId] = useState<string | null>(null);
  if (people.length === 0) return null;
  if (!canOpen) {
    return (
      <Link to={moreTo} className={cn('flex items-center -space-x-2', className)} aria-label={t('portal.todayOpen')}>
        {people.slice(0, 8).map((p) => (
          <Avatar key={p.associateId} src={personPhotoUrl(p)} name={p.name} email="" size="md" ringed />
        ))}
        {people.length > 8 && <span className="pl-4 text-sm text-silver tabular-nums">+{people.length - 8}</span>}
      </Link>
    );
  }
  const opened = openId ? people.find((p) => p.associateId === openId) ?? null : null;
  const moreFine = people.length - 8;
  const moreCoarse = people.length - 6;
  return (
    <div className={cn('flex items-center', className)} data-testid="crew-faces">
      {people.slice(0, 8).map((p, i) => (
        <button
          key={p.associateId}
          type="button"
          onClick={() => setOpenId(p.associateId)}
          aria-label={t('crew.openCard', { name: p.name })}
          aria-haspopup="dialog"
          className={cn(
            'grid shrink-0 place-items-center rounded-full transition-transform hover:z-10 hover:-translate-y-0.5 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
            i > 0 && '-ml-2 coarse:ml-1',
            'coarse:h-11 coarse:w-11',
            i >= 6 && 'coarse:hidden',
          )}
        >
          <Avatar src={personPhotoUrl(p)} name={p.name} email="" size="md" ringed />
        </button>
      ))}
      {(moreFine > 0 || moreCoarse > 0) && (
        <Link
          to={moreTo}
          aria-label={t('crew.moreOnFloor')}
          className={cn(
            'min-h-11 items-center pl-3 text-sm text-silver tabular-nums hover:text-ink',
            // Seven faces: all fit with a pointer, one is over on a touch screen.
            moreFine > 0 ? 'flex' : 'hidden coarse:flex',
          )}
        >
          {moreFine > 0 && <span className={cn(moreCoarse > 0 && 'coarse:hidden')}>+{moreFine}</span>}
          {moreCoarse > 0 && <span className="hidden coarse:inline">+{moreCoarse}</span>}
        </Link>
      )}
      {opened && (
        <CrewCardDrawer
          associateId={opened.associateId}
          name={opened.name}
          photoUrl={opened.photoUrl}
          open
          onOpenChange={(o) => {
            if (!o) setOpenId(null);
          }}
        />
      )}
    </div>
  );
}
