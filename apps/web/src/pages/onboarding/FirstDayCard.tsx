import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarCheck, CheckCircle2, Circle } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { getFirstDay, patchFirstDay, type FirstDay } from '@/lib/onboardingApi';
import { assignKioskPin } from '@/lib/kiosk99Api';
import { assignShift, listShifts } from '@/lib/schedulingApi';
import { fmtDate, fmtShiftTz, parseYmd } from '@/lib/format';
import { cn } from '@/lib/cn';
import { AssociatePicker } from '@/components/ui/AssociatePicker';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { QueryError } from '@/components/ui/QueryError';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * "First day" (role walk HR 11): everything that has to be true before a
 * new hire's first shift, on one card, each line fixed where it is shown —
 * the start date, the store, the manager, the pay schedule, a clock-in
 * number that works at this client, the first shift booked, and the I-9
 * Section 2 date. It used to be ten clicks across the person record, a
 * scheduling page and the kiosk tools.
 */

const why = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

function Line({ done, label, children }: { done: boolean; label: string; children: ReactNode }) {
  const Icon = done ? CheckCircle2 : Circle;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5 first:pt-0 last:pb-0">
      <Icon className={cn('h-4 w-4 shrink-0', done ? 'text-success' : 'text-ink-muted')} aria-hidden="true" />
      <span className="w-36 shrink-0 text-sm text-ink-muted">{label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-sm text-ink">{children}</div>
    </li>
  );
}

export interface FirstDayCardProps {
  applicationId: string;
  associateId: string;
  /** '' for a direct employer's hire (no client). */
  clientId: string;
  status: string;
  /** The pay schedule the hire lands on, when the rules choose one. */
  payScheduleName: string | null;
  /** Inside the approval celebration: no card frame. */
  bare?: boolean;
}

export function FirstDayCard({ applicationId, associateId, clientId, status, payScheduleName, bare = false }: FirstDayCardProps) {
  const qc = useQueryClient();
  const key = ['application', applicationId, 'first-day'];
  const q = useQuery({ queryKey: key, queryFn: () => getFirstDay(applicationId) });
  const [saving, setSaving] = useState<string | null>(null);
  const [booking, setBooking] = useState(false);
  const fd = q.data;
  const approved = status === 'APPROVED';

  const patch = async (field: string, body: Parameters<typeof patchFirstDay>[1], done: string) => {
    setSaving(field);
    try {
      const next = await patchFirstDay(applicationId, body);
      qc.setQueryData<FirstDay>(key, next);
      void qc.invalidateQueries({ queryKey: ['application', applicationId], exact: true });
      toast.success(done);
    } catch (err) {
      toast.error(why(err, 'Could not save that.'));
    } finally {
      setSaving(null);
    }
  };

  // The number the desk just issued, shown on the line until the refetch
  // carries it (the toast alone disappeared, and HR went to People for it).
  const [justIssued, setJustIssued] = useState<string | null>(null);
  const copyNumber = async (n: string) => {
    try {
      await navigator.clipboard.writeText(n);
      toast.success('Clock-in number copied.');
    } catch {
      toast.error('Could not copy — read it from the line.');
    }
  };

  const issueNumber = async () => {
    setSaving('number');
    try {
      const r = await assignKioskPin({ associateId, clientId });
      setJustIssued(r.employeeNumber);
      toast.success(`Clock-in number ${r.employeeNumber} issued for this client.`);
      void q.refetch();
    } catch (err) {
      toast.error(why(err, 'Could not issue the number.'));
    } finally {
      setSaving(null);
    }
  };

  const body = (() => {
    if (q.isError) return <QueryError what="the first-day checklist" query={q} />;
    if (!fd) {
      return (
        <div className="space-y-2" aria-busy="true">
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-2/3" />
        </div>
      );
    }
    const numberOk = fd.employeeNumber.issued && fd.employeeNumber.validAtClient;
    const shownNumber = fd.employeeNumber.number ?? justIssued;
    return (
      <ul className="divide-y divide-line">
        <Line done={!!fd.startDate} label="Start date">
          <Input
            type="date"
            aria-label="Start date"
            className="h-8 w-auto"
            value={fd.startDate ?? ''}
            disabled={saving === 'start'}
            onChange={(e) => e.target.value && void patch('start', { startDate: e.target.value }, 'Start date saved.')}
          />
        </Line>
        <Line done={!!fd.store} label="Placed at">
          {fd.stores.length === 0 ? (
            <span className="text-ink-muted">This client has no stores set up.</span>
          ) : (
            <Select
              aria-label="Store"
              size="sm"
              className="w-auto"
              value={fd.store?.id ?? ''}
              disabled={saving === 'store'}
              onChange={(e) => void patch('store', { locationId: e.target.value || null }, 'Store saved.')}
            >
              <option value="">Pick a store…</option>
              {fd.stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          )}
        </Line>
        <Line done={!!fd.manager} label="Manager">
          <div className="w-64 max-w-full">
            <AssociatePicker
              value={fd.manager}
              placeholder="Find their manager…"
              className="h-8"
              onChange={(v) => void patch('manager', { managerId: v?.id ?? null }, v ? `${v.name} is their manager.` : 'Manager cleared.')}
            />
          </div>
        </Line>
        <Line done={!!payScheduleName} label="Pay schedule">
          {payScheduleName ?? <span className="text-ink-muted">None covers this hire — choose one at approval.</span>}
        </Line>
        <Line done={numberOk} label="Clock-in number">
          {numberOk ? (
            <>
              {/* The number itself, not just "issued": the desk reads it to the
                  hire. A toast alone vanished and sent HR to People to find it. */}
              <span>
                {shownNumber ? (
                  <>
                    <span className="font-mono text-base tabular-nums text-ink">{shownNumber}</span>
                    {' '}
                    <span className="text-ink-muted">· works at this client’s kiosks.</span>
                  </>
                ) : (
                  'Issued, and it works at this client’s kiosks.'
                )}
              </span>
              {shownNumber && (
                <Button size="sm" variant="ghost" onClick={() => void copyNumber(shownNumber)}>
                  Copy
                </Button>
              )}
            </>
          ) : !clientId ? (
            <span className="text-ink-muted">Issued from the kiosk tools for a direct hire.</span>
          ) : !approved ? (
            <span className="text-ink-muted">Issued once the application is approved.</span>
          ) : (
            <>
              <span className="text-ink-muted">
                {fd.employeeNumber.issued ? 'Filed under another client — this client’s kiosks reject it.' : 'Not issued yet.'}
              </span>
              <Button size="sm" variant="outline" onClick={() => void issueNumber()} loading={saving === 'number'}>
                {fd.employeeNumber.issued ? 'Re-issue for this client' : 'Issue'}
              </Button>
            </>
          )}
        </Line>
        <Line done={!!fd.firstShift} label="First shift">
          {fd.firstShift ? (
            <span>
              {fmtShiftTz(fd.firstShift.startsAt, fd.firstShift.timezone)}
              {fd.firstShift.locationName ? ` · ${fd.firstShift.locationName}` : ''}
            </span>
          ) : !fd.store ? (
            <span className="text-ink-muted">Place them at a store first.</span>
          ) : !approved ? (
            <span className="text-ink-muted">Booked once the application is approved.</span>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setBooking((b) => !b)} aria-expanded={booking}>
              {booking ? 'Hide open shifts' : 'Book one'}
            </Button>
          )}
        </Line>
        {booking && fd.store && !fd.firstShift && (
          <li className="py-2">
            <OpenShiftsPicker
              associateId={associateId}
              locationId={fd.store.id}
              from={fd.startDate}
              onBooked={() => {
                setBooking(false);
                void q.refetch();
              }}
            />
          </li>
        )}
        <Line done={!!fd.i9.section2CompletedAt} label="I-9 Section 2">
          {fd.i9.section2CompletedAt ? (
            <span>Done {fmtDate(fd.i9.section2CompletedAt)}</span>
          ) : fd.i9.section2DueBy ? (
            <span>Due {fmtDate(parseYmd(fd.i9.section2DueBy) ?? fd.i9.section2DueBy)} — 3 business days after the start.</span>
          ) : (
            <span className="text-ink-muted">Due 3 business days after the start date.</span>
          )}
          {!fd.i9.section2CompletedAt && (
            <Link to={`/compliance?tab=i9&associateId=${associateId}`} className="text-accent hover:underline">
              Open the I-9
            </Link>
          )}
        </Line>
      </ul>
    );
  })();

  if (bare) return <div aria-label="First day">{body}</div>;
  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <SectionTitle icon={CalendarCheck} title="First day" description="What has to be true before their first shift. Fix each line here." />
        {body}
      </CardContent>
    </Card>
  );
}

/** Open shifts at their store from the start date, each one tap to assign. */
function OpenShiftsPicker({
  associateId,
  locationId,
  from,
  onBooked,
}: {
  associateId: string;
  locationId: string;
  from: string | null;
  onBooked: () => void;
}) {
  const fromIso = from ? `${from}T00:00:00.000Z` : new Date().toISOString();
  const q = useQuery({
    queryKey: ['scheduling', 'shifts', 'open', locationId, fromIso],
    queryFn: () => listShifts({ status: 'OPEN', locationId, from: fromIso }),
  });
  const [busy, setBusy] = useState<string | null>(null);
  if (q.isError) return <QueryError what="the open shifts" query={q} />;
  if (!q.data) return <Skeleton className="h-16 w-full" />;
  const shifts = q.data.shifts.slice(0, 8);
  if (shifts.length === 0) {
    return (
      <EmptyState
        icon={CalendarCheck}
        title="Every shift at this store is taken"
        description="Nothing is open from their start date. Add one on the schedule."
        action={
          <Button asChild size="sm" variant="outline">
            <Link to={`/scheduling?view=week&locationId=${locationId}`}>Open the schedule</Link>
          </Button>
        }
      />
    );
  }
  return (
    <ul className="space-y-1.5" aria-label="Open shifts at their store">
      {shifts.map((s) => (
        <li key={s.id} className="flex items-center justify-between gap-2 rounded-md border border-line px-3 py-1.5 text-sm">
          <span className="min-w-0 truncate text-ink">
            {fmtShiftTz(s.startsAt, s.timezone)} · {s.position}
          </span>
          <Button
            size="sm"
            variant="outline"
            loading={busy === s.id}
            disabled={busy !== null}
            onClick={async () => {
              setBusy(s.id);
              try {
                await assignShift(s.id, { associateId });
                toast.success('First shift booked.');
                onBooked();
              } catch (err) {
                toast.error(why(err, 'Could not assign that shift.'));
              } finally {
                setBusy(null);
              }
            }}
          >
            Assign
          </Button>
        </li>
      ))}
    </ul>
  );
}
