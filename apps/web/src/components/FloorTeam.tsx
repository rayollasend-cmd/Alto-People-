import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, MessageSquare, UserRound, Users } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { fmtDate, fmtShiftTz, parseYmd } from '@/lib/format';
import { cn } from '@/lib/cn';
import { useI18n } from '@/lib/i18n';
import {
  cancelShiftCover,
  createShiftCover,
  getMyFloorTeam,
  type FloorSupervisorTeam,
  type FloorTeamWindow,
  type LeadFloorTeam,
} from '@/lib/shiftWindowsApi';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { Input, Textarea } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { toast } from '@/components/ui/Toaster';

/**
 * The floor team, from each side.
 *
 *   shift supervisor → "My floor supervisors": who reports to them, who's
 *                      on the clock, and "Hand over my shift" — the days a
 *                      floor supervisor runs their shift, SOP included
 *   floor supervisor → "Your shift supervisor": who's in charge of them,
 *                      whether they're on, one tap to message them, and the
 *                      days they're covering
 *
 * No money anywhere — these are store supervisors.
 */

// Supervisors are staff logins: the API sends their associate headshot, else
// their account photo. The bare associate path is the fallback for an API
// that predates the field (photoUrl undefined) — an API `null` means "no
// photo on file", so no guessed URL that 404s (F1 SH-1's rule).
const photoUrl = (p: { photoUrl?: string | null; associateId: string | null }) =>
  p.photoUrl !== undefined ? (p.photoUrl ?? undefined) : p.associateId ? `/api/associates/${p.associateId}/photo` : undefined;

export function useFloorTeam() {
  return useQuery({
    queryKey: ['floor', 'team'],
    queryFn: getMyFloorTeam,
    refetchInterval: 60_000,
  });
}

function span(from: string, to: string): string {
  const f = fmtDate(parseYmd(from));
  return from === to ? f : `${f} – ${fmtDate(parseYmd(to))}`;
}

function shiftNames(windows: FloorTeamWindow[]): string {
  return [...new Set(windows.map((w) => w.label))].join(' & ');
}

function Presence({ since, tz }: { since: string | null; tz?: string | null }) {
  const { t } = useI18n();
  return since ? (
    <span className="inline-flex items-center gap-1.5 text-xs text-success">
      <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden="true" />
      {t('floorUi.onClockSince', { time: fmtShiftTz(since, tz, { day: false }) })}
    </span>
  ) : (
    <span className="text-xs text-silver/70">{t('floorUi.offClock')}</span>
  );
}

function MessageButton({ userId, name }: { userId: string; name: string }) {
  const { t } = useI18n();
  return (
    <Button size="sm" variant="ghost" asChild>
      <Link to={`/messages?to=${userId}`} aria-label={t('floorUi.messageName', { name })}>
        <MessageSquare className="h-4 w-4 sm:mr-1.5" aria-hidden="true" />
        <span className="hidden sm:inline">{t('portal.message')}</span>
      </Link>
    </Button>
  );
}

/* ===== Shift supervisor: My floor supervisors ============================ */

export function FloorTeamStrip({ className }: { className?: string }) {
  const { t } = useI18n();
  const q = useFloorTeam();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [handOver, setHandOver] = useState<{ from?: string; to?: string } | null>(null);
  const [takingBack, setTakingBack] = useState<string | null>(null);
  const team = q.data;
  const data: LeadFloorTeam | null = team && team.role === 'lead' ? team : null;

  // "Who covers your SOP on Sep 20–22?" lands here: /?handover=FROM..TO.
  const handoverParam = searchParams.get('handover');
  useEffect(() => {
    if (!handoverParam || !data) return;
    const [from, to] = handoverParam.split('..');
    setHandOver({ from, to: to ?? from });
    const next = new URLSearchParams(searchParams);
    next.delete('handover');
    setSearchParams(next, { replace: true });
  }, [handoverParam, data, searchParams, setSearchParams]);

  if (!data || (data.team.length === 0 && data.covers.length === 0)) return null;

  const takeBack = async (id: string) => {
    setTakingBack(id);
    try {
      await cancelShiftCover(id);
      toast.success(t('floorUi.takenBack'));
      await queryClient.invalidateQueries({ queryKey: ['floor', 'team'] });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('floorUi.takeBackFailed'));
    } finally {
      setTakingBack(null);
    }
  };

  return (
    <Card className={cn('animate-enter', className)}>
      <CardContent className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-1.5 text-sm font-medium text-white">
            <Users className="h-4 w-4 text-gold" aria-hidden="true" />
            {t('floorUi.myFloorSupervisors')}
          </h2>
          {data.team.length > 0 && (
            <Button size="sm" variant="outline" onClick={() => setHandOver({})}>
              <ArrowRightLeft className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              {t('floorUi.handOverMyShift')}
            </Button>
          )}
        </div>
        {data.team.length === 0 ? (
          <p className="mt-3 text-sm text-silver/70">{t('floorUi.nobodyReports')}</p>
        ) : (
          <ul className="mt-3 divide-y divide-navy-secondary/60">
            {data.team.map((m) => (
              <li key={m.userId} className="flex items-center gap-3 py-2.5">
                <Avatar src={photoUrl(m)} name={m.name} email="" size="md" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="truncate text-sm font-medium text-white">{m.name}</span>
                    {m.windows.length > 0 && (
                      <span className="text-xs text-silver/70">{shiftNames(m.windows)}</span>
                    )}
                    {m.coveringToday && (
                      <Badge variant="accent" size="sm">
                        {t('floorUi.runningYourShiftToday')}
                      </Badge>
                    )}
                  </div>
                  <Presence since={m.onClockSince} tz={m.onClockTimezone} />
                </div>
                <MessageButton userId={m.userId} name={m.name} />
              </li>
            ))}
          </ul>
        )}
        {data.covers.length > 0 && (
          <div className="mt-3 rounded-md border border-gold/30 bg-gold/[0.05] p-3">
            <div className="text-2xs font-medium uppercase tracking-wider text-gold">{t('floorUi.handedOver')}</div>
            <ul className="mt-1.5 space-y-1.5">
              {data.covers.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                  <span className="min-w-0 flex-1 text-white">
                    {t('floorUi.coverRunsYourShift', { name: c.coverName })} · <span className="text-silver">{span(c.fromDate, c.toDate)}</span>
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={takingBack === c.id}
                    onClick={() => void takeBack(c.id)}
                  >
                    {t('floorUi.takeBack')}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
      {handOver && (
        <HandOverDialog
          open
          onOpenChange={(o) => !o && setHandOver(null)}
          team={data.team}
          today={data.today}
          initialFrom={handOver.from}
          initialTo={handOver.to}
          onSaved={() => void queryClient.invalidateQueries({ queryKey: ['floor', 'team'] })}
        />
      )}
    </Card>
  );
}

/**
 * Hand a shift to a floor supervisor for a day or days. The shift
 * supervisor's own (their team), or HR / Workforce for them (`lead`).
 */
export function HandOverDialog({
  open,
  onOpenChange,
  team,
  today,
  lead,
  initialFrom,
  initialTo,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  team: LeadFloorTeam['team'];
  /** YYYY-MM-DD on the store's clock. */
  today: string;
  /** HR / Workforce handing over for this shift supervisor. */
  lead?: { userId: string; name: string };
  initialFrom?: string;
  initialTo?: string;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [coverId, setCoverId] = useState<string>(team.length === 1 ? team[0]!.userId : '');
  const [from, setFrom] = useState(initialFrom && initialFrom >= today ? initialFrom : today);
  const [to, setTo] = useState(initialTo && initialTo >= (initialFrom ?? today) ? initialTo : (initialFrom ?? today));
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const backwards = to < from;
  const leadFirst = lead ? (lead.name.split(' ')[0] ?? '') : null;
  const picked = team.find((m) => m.userId === coverId);

  const save = async () => {
    setSaving(true);
    try {
      await createShiftCover({
        coverUserId: coverId,
        fromDate: from,
        toDate: to,
        note: note.trim() || undefined,
        ...(lead ? { leadUserId: lead.userId } : {}),
      });
      const name = picked?.name ?? t('floorUi.coverFallback');
      const dates = span(from, to);
      toast.success(
        leadFirst !== null
          ? t(from === to ? 'floorUi.handedLeadOn' : 'floorUi.handedLeadFrom', { name, lead: leadFirst, dates })
          : t(from === to ? 'floorUi.handedYoursOn' : 'floorUi.handedYoursFrom', { name, dates }),
      );
      onSaved();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('floorUi.handOverFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {leadFirst !== null ? t('floorUi.handOverLeadTitle', { name: leadFirst }) : t('floorUi.handOverYourTitle')}
          </DialogTitle>
          <DialogDescription>
            {leadFirst !== null ? t('floorUi.handOverDescLead', { name: leadFirst }) : t('floorUi.handOverDescYours')}
          </DialogDescription>
        </DialogHeader>

        {team.length === 0 ? (
          <p className="text-sm text-silver">
            {lead ? t('floorUi.noFloorSupLead', { name: lead.name }) : t('floorUi.noFloorSupYou')}
          </p>
        ) : (
          <div className="space-y-4">
            <fieldset>
              <legend className="mb-1.5 text-xs uppercase tracking-wide text-silver/80">{t('floorUi.whoRunsIt')}</legend>
              <div className="space-y-1.5">
                {team.map((m) => {
                  const on = coverId === m.userId;
                  return (
                    <label
                      key={m.userId}
                      className={cn(
                        'flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2.5 transition',
                        on ? 'border-gold/50 bg-gold/10' : 'border-navy-secondary bg-navy-secondary/30 hover:border-silver/30',
                      )}
                    >
                      <input
                        type="radio"
                        name="cover"
                        checked={on}
                        onChange={() => setCoverId(m.userId)}
                        className="h-4 w-4 accent-gold"
                      />
                      <Avatar src={photoUrl(m)} name={m.name} email="" size="sm" />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-white">{m.name}</div>
                        <div className="text-xs2 text-silver/80">
                          {m.windows.length > 0 ? shiftNames(m.windows) : t('floorUi.noShiftAssigned')}
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>
            </fieldset>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="handover-from" className="text-xs text-silver">
                  {t('floorUi.firstDay')}
                </Label>
                <Input
                  id="handover-from"
                  type="date"
                  min={today}
                  value={from}
                  onChange={(e) => {
                    setFrom(e.target.value);
                    if (to < e.target.value) setTo(e.target.value);
                  }}
                />
              </div>
              <div>
                <Label htmlFor="handover-to" className="text-xs text-silver">
                  {t('floorUi.lastDay')}
                </Label>
                <Input
                  id="handover-to"
                  type="date"
                  min={from}
                  value={to}
                  invalid={backwards}
                  onChange={(e) => setTo(e.target.value)}
                />
              </div>
            </div>
            <div>
              <Label htmlFor="handover-note" className="text-xs text-silver">
                {t('floorUi.noteForThem')} <span className="text-silver/60">{t('floorUi.optional')}</span>
              </Label>
              <Textarea
                id="handover-note"
                rows={2}
                maxLength={500}
                placeholder={t('floorUi.handOverNotePlaceholder')}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          {team.length > 0 && (
            <Button onClick={() => void save()} loading={saving} disabled={!coverId || !from || !to || backwards}>
              {t('floorUi.handOver')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ===== Floor supervisor: your shift supervisor =========================== */

export function MyLeadStrip({ className }: { className?: string }) {
  const { t } = useI18n();
  const q = useFloorTeam();
  const team = q.data;
  const data: FloorSupervisorTeam | null = team && team.role === 'floor' ? team : null;
  if (!data) return null;
  const lead = data.lead;
  const upcoming = data.covers.filter((c) => !c.today);

  return (
    <Card className={cn('animate-enter', className)}>
      <CardContent className="p-5">
        <h2 className="flex items-center gap-1.5 text-sm font-medium text-white">
          <UserRound className="h-4 w-4 text-gold" aria-hidden="true" />
          {t('floorUi.yourShiftSupervisor')}
        </h2>
        {lead ? (
          <div className="mt-3 flex items-center gap-3">
            <Avatar src={photoUrl(lead)} name={lead.name} email="" size="lg" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="truncate text-base font-medium text-white">{lead.name}</span>
                {lead.windows.length > 0 && (
                  <span className="text-xs text-silver/70">{shiftNames(lead.windows)}</span>
                )}
              </div>
              <Presence since={lead.onClockSince} tz={lead.onClockTimezone} />
            </div>
            <MessageButton userId={lead.userId} name={lead.name} />
          </div>
        ) : (
          <p className="mt-3 text-sm text-warning">
            {t('floorUi.noLeadAssigned')}
          </p>
        )}
        {upcoming.length > 0 && (
          <ul className="mt-3 space-y-1 rounded-md border border-gold/30 bg-gold/[0.05] p-3 text-sm">
            {upcoming.map((c) => (
              <li key={c.id} className="text-white">
                {t('floorUi.youRunLeadShift', { name: c.leadName.split(' ')[0] ?? '' })} · <span className="text-silver">{span(c.fromDate, c.toDate)}</span>
                {c.note && <span className="block text-xs text-silver/80">“{c.note}”</span>}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
