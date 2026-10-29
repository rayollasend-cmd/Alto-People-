import { useEffect, useId, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { FleetVan, TransportException, TransportExceptionSeverity } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { ackSos } from '@/lib/transportApi';
import { useTransportOps } from '@/lib/transportOpsApi';
import { rideAlert, useNewKeys } from '@/lib/rideAlerts';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { QueryError } from '@/components/ui/QueryError';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { CheckCircle2, MapPin, Phone, Siren } from '@/components/ui/icons';
import '@/lib/i18n/en/fleetOps';
import { agoText, useFleetT, type FleetT } from './fleetT';
import { minutesSince, orderExceptions, telHref } from './fleetModel';

/**
 * What needs the desk now, highest severity first, each with its one-click
 * fix (shared TransportException, GET /transport/ops). An SOS is a red
 * banner pinned on top that chimes once when it arrives; everything else is
 * a row — how urgent, what happened (with its number), what fixes it, how
 * long ago, and the fix. `compact` (the Today tab) shows the top three and
 * "See all".
 */
export interface ExceptionsQueueProps {
  date: string | null;
  /** A tighter list for the Today tab's top. */
  compact?: boolean;
  onOpenRun?: (runId: string) => void;
  onOpenRide?: (rideIds: string[]) => void;
  /** Hide the "Needs you" heading (a host that titles the section itself). */
  headless?: boolean;
  /** Full rows, but only this many until "Show N more" (the Live map's panel, so the vans stay in view). */
  max?: number;
  /** The heading's level: h2 on a tab's top (the default when compact), h3 inside a titled panel. */
  headingLevel?: 'h2' | 'h3';
  className?: string;
}

const COMPACT_ROWS = 3;

const SEVERITY_VARIANT: Record<TransportExceptionSeverity, 'destructive' | 'pending' | 'info'> = {
  high: 'destructive',
  medium: 'pending',
  low: 'info',
};

/** A clock that moves every 30 s, so "6 min ago" stays true between polls. */
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(id);
  }, [everyMs]);
  return now;
}

/** Where to dial the driver an exception is about: the action's own number, else the van's run. */
export function driverPhoneFor(e: TransportException, vans: FleetVan[]): string | null {
  const target = e.action.target;
  if (target && telHref(target)) return target;
  const van = vans.find((v) => v.run && ((e.runId && v.run.runId === e.runId) || (e.driverUserId && v.run.driverUserId === e.driverUserId) || (e.vanId && v.vanId === e.vanId)));
  return van?.run?.driverPhone ?? null;
}

export function ExceptionsQueue({ date, compact = false, onOpenRun, onOpenRide, headless = false, max, headingLevel, className }: ExceptionsQueueProps) {
  const t = useFleetT();
  const ops = useTransportOps(date);
  const { can } = useAuth();
  const manage = can('manage:transport');
  const queryClient = useQueryClient();
  const [, setParams] = useSearchParams();
  const now = useNow();
  const headingId = useId();
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const all = orderExceptions(ops.data?.exceptions ?? []);
  const sos = all.filter((e) => e.kind === 'sos');
  const rest = all.filter((e) => e.kind !== 'sos');
  const vans = ops.data?.vans ?? [];

  // A new SOS chimes once (the first look is silent; the sound switch mutes it).
  useNewKeys(ops.data ? sos.map((e) => e.id) : null, () => rideAlert('attention'));

  const goTab = (tab: string, extra: Record<string, string> = {}) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (tab === 'today') next.delete('tab');
        else next.set('tab', tab);
        for (const [k, v] of Object.entries(extra)) next.set(k, v);
        return next;
      },
      { replace: true },
    );

  const openRun = (runId: string) => (onOpenRun ? onOpenRun(runId) : goTab('live', { run: runId }));
  const openRides = (rideIds: string[]) => (onOpenRide ? onOpenRide(rideIds) : goTab('today'));

  const ack = async (e: TransportException) => {
    if (!e.runId) return;
    setBusy(e.id);
    try {
      await ackSos(e.runId);
      toast.success(t('fleetOps.sosAcked'));
      await Promise.all([ops.refetch(), queryClient.invalidateQueries({ queryKey: ['transport'] })]);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('fleetOps.sosAckFailed'));
    } finally {
      setBusy(null);
    }
  };

  const heading = !headless && (
    <SectionTitle
      as={headingLevel ?? (compact ? 'h2' : 'h3')}
      id={headingId}
      size="sm"
      className="mb-0"
      title={
        <>
          {t('fleetOps.needsYou')}
          {all.length > 0 && <span className="ml-2 font-normal tabular-nums text-ink-muted">{all.length}</span>}
        </>
      }
    />
  );

  if (ops.isLoading) {
    return (
      <section aria-labelledby={headless ? undefined : headingId} aria-label={headless ? t('fleetOps.needsYou') : undefined} aria-busy="true" className={cn('space-y-2', className)}>
        {heading}
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
      </section>
    );
  }
  if (ops.isError) {
    return (
      <section aria-labelledby={headless ? undefined : headingId} aria-label={headless ? t('fleetOps.needsYou') : undefined} className={cn('space-y-2', className)}>
        {heading}
        <QueryError what={t('fleetOps.whatNeedsYou')} query={ops} />
      </section>
    );
  }

  const limit = compact ? COMPACT_ROWS : !expanded && max ? max : rest.length;
  const shown = rest.slice(0, limit);
  const anyOnRoad = vans.some((v) => v.state === 'on_road' || v.state === 'no_signal');

  return (
    <section
      aria-labelledby={headless ? undefined : headingId}
      aria-label={headless ? t('fleetOps.needsYou') : undefined}
      className={cn('space-y-2', className)}
      data-testid="exceptions-queue"
    >
      {heading}
      {sos.length > 0 && (
        <div className="sticky top-0 z-10 space-y-2">
          {sos.map((e) => (
            <SosBanner key={e.id} e={e} t={t} now={now} phone={driverPhoneFor(e, vans)} van={vans.find((v) => v.run?.runId === e.runId) ?? null} manage={manage} busy={busy === e.id} onAck={() => void ack(e)} />
          ))}
        </div>
      )}
      {rest.length === 0 && sos.length === 0 ? (
        <div role="status" className="flex items-start gap-2 rounded-md border border-positive-200 bg-positive-50 px-3 py-2.5 text-sm text-positive-800">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{anyOnRoad ? t('fleetOps.allClear') : t('fleetOps.allClearQuiet')}</span>
        </div>
      ) : (
        shown.length > 0 && (
          <ul className="divide-y divide-line-subtle rounded-md border border-line bg-surface">
            {shown.map((e) => (
              <ExceptionRow
                key={e.id}
                e={e}
                t={t}
                now={now}
                compact={compact}
                phone={driverPhoneFor(e, vans)}
                manage={manage}
                busy={busy === e.id}
                onAck={() => void ack(e)}
                onOpenRun={openRun}
                onOpenRides={openRides}
                onIssue={(id) => goTab('issues', id ? { issue: id } : {})}
                onSetup={(target) => goTab(target === 'drivers' ? 'drivers' : 'vans')}
                onRider={(associateId) => setParams((p) => {
                  const next = new URLSearchParams(p);
                  next.set('rider', associateId);
                  return next;
                }, { replace: true })}
              />
            ))}
          </ul>
        )
      )}
      {!compact && rest.length > limit && (
        <Button variant="ghost" size="sm" className="w-full" aria-expanded={false} onClick={() => setExpanded(true)}>
          {t('fleetOps.showMore', { n: rest.length - limit })}
        </Button>
      )}
      {!compact && expanded && max && rest.length > max && (
        <Button variant="ghost" size="sm" className="w-full" aria-expanded onClick={() => setExpanded(false)}>
          {t('fleetOps.showFewer')}
        </Button>
      )}
      {compact && rest.length > COMPACT_ROWS && (
        <Button variant="link" size="sm" className="text-sm" onClick={() => goTab('live')}>
          {t('fleetOps.seeAll', { n: all.length })}
        </Button>
      )}
    </section>
  );
}

function SosBanner({
  e,
  t,
  now,
  phone,
  van,
  manage,
  busy,
  onAck,
}: {
  e: TransportException;
  t: FleetT;
  now: number;
  phone: string | null;
  van: FleetVan | null;
  manage: boolean;
  busy: boolean;
  onAck: () => void;
}) {
  const tel = telHref(phone);
  const pos = van?.position;
  return (
    <div role="alert" className="rounded-lg border border-negative-300 bg-negative-50 p-3 elev-2" data-testid="sos-banner">
      <div className="flex items-start gap-2.5">
        <Siren className="mt-0.5 h-5 w-5 shrink-0 text-negative-800" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-negative-800">{e.title}</p>
          <p className="text-xs2 text-ink">{e.detail}</p>
          <p className="mt-0.5 text-xs2 text-ink-muted">{agoText(t, minutesSince(e.at, now))}</p>
        </div>
      </div>
      <div className="mt-2.5 flex flex-wrap gap-2">
        {manage && (
          <Button size="sm" variant="destructive" loading={busy} disabled={busy} onClick={onAck}>
            {e.action.kind === 'ack_sos' ? e.action.label : t('fleetOps.acknowledge')}
          </Button>
        )}
        {tel && (
          <Button size="sm" variant="secondary" asChild>
            <a href={tel}>
              <Phone className="h-3.5 w-3.5" aria-hidden="true" />
              {t('fleetOps.callDriver')}
            </a>
          </Button>
        )}
        {pos && (
          <Button size="sm" variant="ghost" asChild>
            <a href={`https://www.google.com/maps?q=${pos.lat},${pos.lng}`} target="_blank" rel="noreferrer">
              <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
              {t('fleetOps.openInMaps')}
            </a>
          </Button>
        )}
      </div>
    </div>
  );
}

function ExceptionRow({
  e,
  t,
  now,
  compact,
  phone,
  manage,
  busy,
  onAck,
  onOpenRun,
  onOpenRides,
  onIssue,
  onSetup,
  onRider,
}: {
  e: TransportException;
  t: FleetT;
  now: number;
  compact: boolean;
  phone: string | null;
  manage: boolean;
  busy: boolean;
  onAck: () => void;
  onOpenRun: (runId: string) => void;
  onOpenRides: (rideIds: string[]) => void;
  onIssue: (id: string | undefined) => void;
  onSetup: (target: string | undefined) => void;
  onRider: (associateId: string) => void;
}) {
  const sev = { high: t('fleetOps.sev.high'), medium: t('fleetOps.sev.medium'), low: t('fleetOps.sev.low') }[e.severity];
  const label = e.action.label;
  const button = (onClick: () => void) => (
    <Button size="xs" variant="secondary" onClick={onClick} aria-label={`${label}: ${e.title}`}>
      {label}
    </Button>
  );
  let action: ReactNode = null;
  switch (e.action.kind) {
    case 'open_run':
      if (e.runId ?? e.action.target) action = button(() => onOpenRun((e.runId ?? e.action.target)!));
      break;
    case 'call_driver': {
      const tel = telHref(phone);
      if (tel)
        action = (
          <Button size="xs" variant="secondary" asChild>
            <a href={tel} aria-label={`${label}: ${e.title}`}>
              <Phone className="h-3.5 w-3.5" aria-hidden="true" />
              {label}
            </a>
          </Button>
        );
      else if (e.runId) action = button(() => onOpenRun(e.runId!));
      break;
    }
    case 'ack_sos':
      if (manage && e.runId)
        action = (
          <Button size="xs" variant="destructive" loading={busy} disabled={busy} onClick={onAck}>
            {label}
          </Button>
        );
      break;
    case 'assign_van':
      action = button(() => onOpenRides(e.rideIds ?? []));
      break;
    case 'open_issue':
      action = button(() => onIssue(e.action.target));
      break;
    case 'open_setup':
      action = button(() => onSetup(e.action.target));
      break;
    case 'open_ride':
      action = button(() => (e.action.target ? onRider(e.action.target) : onOpenRides(e.rideIds ?? [])));
      break;
  }
  return (
    <li className={cn('px-3', compact ? 'py-2.5 sm:flex sm:items-center sm:gap-4' : 'py-3')} data-testid={`exception-${e.id}`}>
      <div className="min-w-0 sm:flex-1">
        <div className="flex items-center gap-2">
          <Badge size="sm" variant={SEVERITY_VARIANT[e.severity]}>
            {sev}
          </Badge>
          <span className="ml-auto shrink-0 text-xs2 text-ink-muted">{agoText(t, minutesSince(e.at, now))}</span>
        </div>
        <p className="mt-1.5 text-sm font-medium text-ink">{e.title}</p>
        <p className={cn('mt-0.5 text-xs2 text-ink-muted', compact && 'line-clamp-1')}>{e.detail}</p>
      </div>
      {action && <div className={cn('mt-2', compact && 'sm:mt-0 sm:shrink-0')}>{action}</div>}
    </li>
  );
}
