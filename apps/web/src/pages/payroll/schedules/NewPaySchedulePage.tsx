import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Check, Star } from 'lucide-react';
import type { PayFrequencyKind } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useTenant } from '@/lib/auth';
import { createPaySchedule, listScheduleCandidates, previewPattern } from '@/lib/paySchedulesApi';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import { workweekStart } from '@/lib/workweek';
import { ymdLocal } from '@/lib/format';
import { ListTemplate } from '@/components/templates';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { Stepper } from '@/components/ui/Stepper';
import { toast } from '@/components/ui/Toaster';
import { cn } from '@/lib/cn';
import { PeoplePicker, SelectionSummary, emptySelection, selectionCount, toMembershipInput, type BuilderSelection } from './AddPeopleBuilder';
import { FREQUENCY_WORDS, PERIODS_PER_YEAR, PayCalendar, WEEKDAYS, addDays, patternSentence, payDay } from './scheduleKit';

const STEPS = [{ label: 'How you pay' }, { label: 'The calendar' }, { label: 'Who’s on it' }, { label: 'Review' }] as const;

const FREQ_HELP: Record<PayFrequencyKind, string> = {
  WEEKLY: '52 paydays a year. Common for hourly staff.',
  BIWEEKLY: '26 paydays a year. The most common US schedule.',
  SEMIMONTHLY: '24 paydays: the 1st–15th and the 16th–end of month.',
  MONTHLY: '12 paydays, one per month.',
  DAILY: 'Paid each night for the day’s approved time; a weekly check trues it up.',
};

const SHORT_DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Biweekly · Sat–Fri · paid the Friday after" — the house naming, editable. */
function suggestName(f: PayFrequencyKind, anchorDate: string, offset: number): string {
  const d = new Date(`${anchorDate}T12:00:00`);
  const kind = { WEEKLY: 'Weekly', BIWEEKLY: 'Biweekly', SEMIMONTHLY: 'Semi-monthly', MONTHLY: 'Monthly', DAILY: 'Daily' }[f];
  if (f !== 'WEEKLY' && f !== 'BIWEEKLY') return kind;
  const s = d.getDay();
  const e = (s + 6) % 7;
  return `${kind} · ${SHORT_DAY[s]}–${SHORT_DAY[e]} · paid the ${WEEKDAYS[(e + offset) % 7]} after`;
}

/** The next few dates that fall on a weekday, for "the first period starts…". */
function nextDatesOn(weekday: number, count = 8): string[] {
  const out: string[] = [];
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - 14);
  while (d.getDay() !== weekday) d.setDate(d.getDate() + 1);
  for (let i = 0; i < count; i++) {
    out.push(ymdLocal(d));
    d.setDate(d.getDate() + 7);
  }
  return out;
}

/**
 * Setting up a pay schedule the way a payroll lead describes one — "every
 * other week, Saturday to Friday, paid the next Friday" — then seeing the
 * year of paydays (holiday moves included), choosing who's on it, and
 * reviewing before anything is saved.
 */
export function NewPaySchedulePage() {
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const hasClients = useTenant().moduleOn('clientPortal');
  const [frequency, setFrequency] = useState<PayFrequencyKind>('BIWEEKLY');
  const [startDay, setStartDay] = useState(6); // the company workweek starts Saturday
  const [anchorDate, setAnchorDate] = useState(() => ymdLocal(workweekStart()));
  const [offset, setOffset] = useState(7);
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [notes, setNotes] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [sel, setSel] = useState<BuilderSelection>(() => emptySelection(''));
  const weekly = frequency === 'WEEKLY' || frequency === 'BIWEEKLY';
  const suggested = suggestName(frequency, anchorDate, offset);
  const finalName = nameTouched && name.trim() ? name.trim() : suggested;
  const sentence = patternSentence(frequency, anchorDate, offset);

  const params = useDebouncedValue({ frequency, anchorDate, payDateOffsetDays: offset }, 200);
  const calendar = useQuery({ queryKey: ['paySchedules', 'previewPattern', params], queryFn: () => previewPattern({ ...params, months: 12 }) });
  // The first period that hasn't started: people can join a schedule from today on, never back-dated.
  const first = calendar.data?.periods.find((p) => p.periodStart >= ymdLocal()) ?? calendar.data?.periods[0];
  const facets = useQuery({ queryKey: ['paySchedules', 'candidates', 'facets'], queryFn: () => listScheduleCandidates({}), enabled: step >= 3 });
  const names = useMemo(() => {
    const f = facets.data?.facets;
    return {
      client: (id: string) => f?.clients.find((c) => c.id === id)?.name ?? 'a client',
      site: (id: string) => f?.sites.find((c) => c.id === id)?.name ?? 'a',
      department: (id: string) => f?.departments.find((c) => c.id === id)?.name ?? 'a',
    };
  }, [facets.data]);
  const chosen = selectionCount(sel);

  const create = useMutation({
    mutationFn: () =>
      createPaySchedule({
        name: finalName,
        frequency,
        anchorDate,
        payDateOffsetDays: offset,
        notes: notes.trim() || null,
        isDefault,
        ...(chosen > 0 ? { membership: toMembershipInput({ ...sel, effectiveFrom: sel.effectiveFrom || first?.periodStart || anchorDate }) } : {}),
      }),
    onSuccess: (r) => {
      toast.success(`${r.schedule.name} is set up.${chosen > 0 ? ' Payroll was told who joins it.' : ''}`);
      navigate(`/payroll/schedules/${r.schedule.id}`);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not create the schedule.'),
  });

  const changeFrequency = (f: PayFrequencyKind) => {
    setFrequency(f);
    if (f === 'WEEKLY' || f === 'BIWEEKLY') {
      setOffset(f === 'WEEKLY' ? 6 : 7);
    } else if (f === 'DAILY') {
      setAnchorDate(ymdLocal());
      setOffset(1);
    } else {
      // Twice-monthly / monthly periods are fixed to the calendar; the anchor is the 1st.
      const d = new Date();
      setAnchorDate(ymdLocal(new Date(d.getFullYear(), d.getMonth() + 1, 1)));
      setOffset(f === 'MONTHLY' ? 0 : 5);
    }
  };
  const changeStartDay = (day: number) => {
    setStartDay(day);
    setAnchorDate(nextDatesOn(day)[2] ?? anchorDate);
  };

  return (
    <ListTemplate
      title="New pay schedule"
      subtitle="Describe how you pay. You’ll see every payday for the year before anything is saved."
      breadcrumbs={[{ label: 'Payroll', to: '/payroll' }, { label: 'Pay schedules', to: '/payroll/schedules' }, { label: 'New' }]}
    >
      <Stepper current={step} steps={STEPS} onStepClick={setStep} className="max-w-3xl" />

      {step === 1 && (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <Card>
            <CardHeader>
              <CardTitle>How often do you pay?</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <div role="radiogroup" aria-label="How often" className="grid gap-2 sm:grid-cols-2">
                {(['WEEKLY', 'BIWEEKLY', 'SEMIMONTHLY', 'MONTHLY', 'DAILY'] as PayFrequencyKind[]).map((f) => (
                  <button
                    key={f}
                    type="button"
                    role="radio"
                    aria-checked={frequency === f}
                    onClick={() => changeFrequency(f)}
                    className={cn(
                      'rounded-lg border p-3 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                      frequency === f ? 'border-accent bg-accent-fill/10' : 'border-line hover:border-accent/40',
                    )}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="font-medium text-ink">{FREQUENCY_WORDS[f]}</span>
                      {frequency === f && <Check className="h-4 w-4 text-accent" aria-hidden="true" />}
                    </span>
                    <span className="mt-0.5 block text-xs text-ink-muted">{FREQ_HELP[f]}</span>
                  </button>
                ))}
              </div>

              {weekly && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Each pay period runs" hint={`${WEEKDAYS[startDay]} to ${WEEKDAYS[(startDay + 6) % 7]}${frequency === 'BIWEEKLY' ? ', two weeks' : ''}`}>
                    {(p) => (
                      <Select value={String(startDay)} onChange={(e) => changeStartDay(Number(e.target.value))} {...p}>
                        {WEEKDAYS.map((d, i) => (
                          <option key={d} value={i}>
                            {d} to {WEEKDAYS[(i + 6) % 7]}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  <Field label="A pay period starts on" hint="Every period is counted from this one.">
                    {(p) => (
                      <Select value={anchorDate} onChange={(e) => setAnchorDate(e.target.value)} {...p}>
                        {nextDatesOn(startDay).map((d) => (
                          <option key={d} value={d}>
                            {payDay(d)}
                          </option>
                        ))}
                        {!nextDatesOn(startDay).includes(anchorDate) && <option value={anchorDate}>{payDay(anchorDate)}</option>}
                      </Select>
                    )}
                  </Field>
                </div>
              )}

              <Field label="Payday" hint={offset === 0 ? 'The period’s last day.' : `${offset} ${offset === 1 ? 'day' : 'days'} after the period ends — moved earlier when it lands on a weekend or bank holiday.`}>
                {(p) => (
                  <Select value={String(offset)} onChange={(e) => setOffset(Number(e.target.value))} {...p}>
                    {Array.from({ length: weekly ? 15 : 16 }, (_, i) => i).map((n) => {
                      const endDay = (startDay + 6) % 7;
                      const label = weekly
                        ? n === 0
                          ? `The last day of the period (${WEEKDAYS[endDay]})`
                          : `${n <= 7 ? 'The' : 'The second'} ${WEEKDAYS[(endDay + n) % 7]} after (${n} ${n === 1 ? 'day' : 'days'})`
                        : n === 0
                          ? 'The last day of the period'
                          : `${n} ${n === 1 ? 'day' : 'days'} after the period ends`;
                      return (
                        <option key={n} value={n}>
                          {label}
                        </option>
                      );
                    })}
                  </Select>
                )}
              </Field>

              <Field label="Name" hint={nameTouched ? undefined : 'Suggested from the pattern — change it if you like.'}>
                {(p) => (
                  <Input
                    value={nameTouched ? name : suggested}
                    maxLength={120}
                    onChange={(e) => {
                      setNameTouched(true);
                      setName(e.target.value);
                    }}
                    {...p}
                  />
                )}
              </Field>
            </CardContent>
          </Card>
          <Card className="h-fit lg:sticky lg:top-4">
            <CardHeader>
              <CardTitle>In plain words</CardTitle>
              <CardDescription>{sentence}.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <p className="text-ink-muted">{PERIODS_PER_YEAR[frequency]} paydays a year.</p>
              {calendar.isLoading ? (
                <Skeleton className="h-20" />
              ) : first ? (
                <div className="rounded-lg border border-line p-3">
                  <p className="text-xs uppercase tracking-widest text-ink-muted">First payday</p>
                  <p className="mt-1 text-lg font-semibold text-ink">{payDay(first.payDate)}</p>
                  <p className="text-xs text-ink-muted">For {payDay(first.periodStart, false)} – {payDay(first.periodEnd, false)}</p>
                  {first.adjustedFor && <p className="mt-1 text-xs text-warning">{first.adjustedFor} — moved from {payDay(first.unadjustedPayDate, false)}</p>}
                </div>
              ) : null}
            </CardContent>
          </Card>
        </div>
      )}

      {step === 2 && (
        <Card>
          <CardHeader>
            <CardTitle>Every payday for the next 12 months</CardTitle>
            <CardDescription>{sentence}. A payday on a weekend or bank holiday is paid the banking day before.</CardDescription>
          </CardHeader>
          <CardContent>{calendar.isLoading ? <Skeleton className="h-64" /> : <PayCalendar periods={calendar.data?.periods ?? []} />}</CardContent>
        </Card>
      )}

      {step === 3 && (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Who’s on it?</CardTitle>
              <CardDescription>{hasClients ? 'Optional — you can add people later. Choose whole clients and everyone hired there later is paid on this schedule too.' : 'Optional — you can add people later. Choose a site and everyone hired there later is paid on this schedule too.'}</CardDescription>
            </CardHeader>
            <CardContent>
              <PeoplePicker
                value={{ ...sel, effectiveFrom: sel.effectiveFrom || first?.periodStart || anchorDate }}
                onChange={setSel}
                schedule={{ id: null, name: finalName, nextPeriodStart: first?.periodStart ?? anchorDate, nextPayDate: first?.payDate ?? addDays(anchorDate, 13 + offset) }}
              />
            </CardContent>
          </Card>
          <Card>
            <CardContent>
              <label className="flex cursor-pointer items-start gap-3">
                <input type="checkbox" className="mt-1 h-4 w-4 accent-gold" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
                <span>
                  <span className="flex items-center gap-1.5 font-medium text-ink">
                    <Star className="h-4 w-4 text-accent" aria-hidden="true" /> Make this the company default
                  </span>
                  <span className="block text-sm text-ink-muted">Anyone no other rule covers — including new hires — is paid on this schedule, so nobody is ever left off a payroll.</span>
                </span>
              </label>
            </CardContent>
          </Card>
        </div>
      )}

      {step === 4 && (
        <Card className="max-w-3xl">
          <CardHeader>
            <CardTitle>{finalName}</CardTitle>
            <CardDescription>{sentence}.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <dl className="grid gap-4 sm:grid-cols-3">
              <div>
                <dt className="text-xs uppercase tracking-widest text-ink-muted">First payday</dt>
                <dd className="mt-1 font-medium text-ink">{first ? payDay(first.payDate) : '—'}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-widest text-ink-muted">Paydays a year</dt>
                <dd className="mt-1 font-medium text-ink">{PERIODS_PER_YEAR[frequency]}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-widest text-ink-muted">Company default</dt>
                <dd className="mt-1 font-medium text-ink">{isDefault ? 'Yes' : 'No'}</dd>
              </div>
            </dl>
            <div>
              <p className="text-xs uppercase tracking-widest text-ink-muted">Who’s on it</p>
              <div className="mt-2">
                <SelectionSummary value={sel} clientName={names.client} siteName={names.site} departmentName={names.department} />
              </div>
              {chosen > 0 && <p className="mt-2 text-xs text-ink-muted">From {payDay(sel.effectiveFrom || first?.periodStart || anchorDate)}. You’ll see everyone who moves on the schedule after it’s created; payroll is told.</p>}
            </div>
            <Field label="Notes (optional)">{(p) => <Textarea rows={2} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} {...p} />}</Field>
          </CardContent>
        </Card>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
        {step === 1 ? (
          <Button asChild variant="ghost">
            <Link to="/payroll/schedules">Cancel</Link>
          </Button>
        ) : (
          <Button variant="secondary" onClick={() => setStep(step - 1)}>
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Back
          </Button>
        )}
        {step < 4 ? (
          <Button onClick={() => setStep(step + 1)} disabled={step === 1 && !finalName}>
            {step === 3 && chosen === 0 ? 'Skip for now' : 'Continue'}
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Button>
        ) : (
          <Button onClick={() => create.mutate()} loading={create.isPending} disabled={create.isPending}>
            <Check className="h-4 w-4" aria-hidden="true" />
            Create schedule
          </Button>
        )}
      </div>
    </ListTemplate>
  );
}
