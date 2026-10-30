import { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { HugoRecurringCadence, HugoRecurringChange, HugoRecurringSchedule, HugoTaskView } from '@alto-people/shared';
import { Pause, Play, Repeat } from '@/components/ui/icons';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';
import { cancelHugoTask, changeHugoRecurring } from '@/lib/hugoApi';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/cn';
import '@/lib/i18n/en/hugoWork';
import { dayName, fmtNext, fmtStepTimeShort, scheduleText, whatText } from './hugoRecurringText';

/**
 * Upcoming: the person's recurring briefs (lib/hugoRecurring) — what each
 * sends, when ("Every Friday at 4:00 PM · next Fri, Nov 6"), the last one
 * sent, and their say over it: pause and resume, change the time, stop.
 * One that waits on "keep going?" is in Waiting for you instead.
 */

const CADENCES: readonly HugoRecurringCadence[] = ['DAILY', 'WEEKDAYS', 'WEEKLY'];
/** Monday first in the picker; the value is 0 = Sunday. */
const WEEK = [1, 2, 3, 4, 5, 6, 0];

export interface ScheduleValue {
  cadence: HugoRecurringCadence;
  weekday: number;
  time: string;
}

/** How often, which day, what time — shared by the row's "Change time" and "Repeat something". */
export function HugoScheduleFields({ value, onChange, disabled }: { value: ScheduleValue; onChange: (v: ScheduleValue) => void; disabled?: boolean }) {
  const { t, lang } = useI18n();
  return (
    <div className="space-y-3">
      <div>
        {/* Sentence case at body size, like every field label (ui/Label). */}
        <p className="mb-1.5 text-sm font-medium text-ink">{t('hugoWork.repeat.often')}</p>
        <SegmentedControl
          ariaLabel={t('hugoWork.repeat.often')}
          value={value.cadence}
          onChange={(cadence) => onChange({ ...value, cadence })}
          options={CADENCES.map((c) => ({ value: c, label: t(`hugoWork.repeat.often.${c}`) }))}
        />
      </div>
      <div className="flex flex-wrap items-end gap-3">
        {value.cadence === 'WEEKLY' && (
          <Field label={t('hugoWork.repeat.day')} className="min-w-[9rem] flex-1">
            {(p) => (
              <Select {...p} value={String(value.weekday)} disabled={disabled} onChange={(e) => onChange({ ...value, weekday: Number(e.target.value) })}>
                {WEEK.map((d) => (
                  <option key={d} value={d}>
                    {dayName(d, lang)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <Field label={t('hugoWork.repeat.time')} className="w-36">
          {(p) => <Input {...p} type="time" required value={value.time} disabled={disabled} onChange={(e) => onChange({ ...value, time: e.target.value })} />}
        </Field>
      </div>
    </div>
  );
}

const toValue = (s: HugoRecurringSchedule): ScheduleValue => ({ cadence: s.cadence, weekday: s.weekday ?? 5, time: s.time });

function HugoUpcomingRow({ task, focused, onChanged, onError }: { task: HugoTaskView; focused: boolean; onChanged: () => void; onError: (err: unknown) => void }) {
  const { t, lang } = useI18n();
  const s = task.subject.recurring!;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ScheduleValue>(() => toValue(s));
  const [confirmStop, setConfirmStop] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const change = useMutation({
    mutationFn: (c: HugoRecurringChange) => changeHugoRecurring(task.id, c),
    onSuccess: () => {
      setEditing(false);
      onChanged();
    },
    onError,
  });
  const stop = useMutation({ mutationFn: () => cancelHugoTask(task.id), onSuccess: onChanged, onError });
  const busy = change.isPending || stop.isPending;
  const title = whatText(s, t);
  const schedule = scheduleText(s, t, lang);
  const next = task.result?.recurring?.nextAt ?? null;
  const last = [...task.events].reverse().find((e) => e.code === 'DELIVERED');

  useEffect(() => {
    if (!focused) return;
    ref.current?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  }, [focused]);

  const save = () => {
    if (!/^\d{2}:\d{2}$/.test(draft.time)) return;
    change.mutate({ cadence: draft.cadence, time: draft.time, ...(draft.cadence === 'WEEKLY' ? { weekday: draft.weekday } : {}) });
  };

  return (
    <article
      ref={ref}
      id={`hugo-task-${task.id}`}
      aria-label={title}
      data-testid="hugo-upcoming"
      data-paused={s.paused ? 'true' : 'false'}
      className={cn('rounded-xl border border-line bg-surface-raised p-3', focused && 'ring-2 ring-gold-bright/70')}
    >
      <div className="flex gap-3">
        <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-lg', s.paused ? 'bg-surface-sunken text-ink-muted' : 'bg-accent-fill/15 text-accent')} aria-hidden="true">
          <Repeat className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <p className="min-w-0 break-words text-sm font-medium leading-snug text-ink">{title}</p>
            {s.paused && (
              <Badge variant="default" size="sm">
                {t('hugoWork.ev.PAUSED')}
              </Badge>
            )}
          </div>
          <p className="mt-0.5 text-xs leading-relaxed text-ink-muted" data-testid="hugo-upcoming-when">
            {schedule}
            {!s.paused && next ? ` · ${t('hugoWork.upcoming.next', { when: fmtNext(next, s.timezone, lang) })}` : ''}
          </p>
          {last && (
            <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-ink-muted">
              <span className="text-ink">{t('hugoWork.upcoming.last', { when: fmtStepTimeShort(last.at, lang) })}</span> {String(last.data.text ?? '')}
            </p>
          )}

          {editing ? (
            <form
              className="mt-3 space-y-3 rounded-lg border border-line bg-surface p-3"
              onSubmit={(e) => {
                e.preventDefault();
                save();
              }}
            >
              <HugoScheduleFields value={draft} onChange={setDraft} disabled={busy} />
              <div className="flex flex-wrap gap-2">
                <Button type="submit" size="sm" loading={change.isPending} disabled={busy}>
                  {t('hugoWork.upcoming.save')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setEditing(false);
                    setDraft(toValue(s));
                  }}
                >
                  {t('hugoWork.repeat.cancel')}
                </Button>
              </div>
            </form>
          ) : (
            <div className="mt-2 flex flex-wrap items-center gap-x-1 gap-y-1">
              <Button
                size="sm"
                variant="ghost"
                className="h-8 px-2"
                aria-label={t('hugoWork.upcoming.aria', { action: t(s.paused ? 'hugoWork.upcoming.resume' : 'hugoWork.upcoming.pause'), title })}
                loading={change.isPending}
                disabled={busy}
                onClick={() => change.mutate({ paused: !s.paused })}
              >
                {s.paused ? <Play className="h-3.5 w-3.5" aria-hidden="true" /> : <Pause className="h-3.5 w-3.5" aria-hidden="true" />}
                {t(s.paused ? 'hugoWork.upcoming.resume' : 'hugoWork.upcoming.pause')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 px-2"
                aria-label={t('hugoWork.upcoming.aria', { action: t('hugoWork.upcoming.change'), title })}
                disabled={busy}
                onClick={() => {
                  setDraft(toValue(s));
                  setEditing(true);
                }}
              >
                {t('hugoWork.upcoming.change')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto h-8 px-2 text-ink-muted"
                aria-label={t('hugoWork.stopAria', { title })}
                loading={stop.isPending}
                disabled={busy}
                onClick={() => setConfirmStop(true)}
              >
                {t('hugoWork.stop')}
              </Button>
            </div>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={confirmStop}
        onOpenChange={setConfirmStop}
        title={t('hugoWork.upcoming.stopTitle')}
        description={t('hugoWork.upcoming.stopBody')}
        confirmLabel={t('hugoWork.stopConfirm.yes')}
        cancelLabel={t('hugoWork.stopConfirm.no')}
        onConfirm={() => {
          setConfirmStop(false);
          stop.mutate();
        }}
      />
    </article>
  );
}

/** The Upcoming section of the Tasks tab. Nothing scheduled: nothing rendered. */
export function HugoUpcoming({
  tasks,
  focusTaskId,
  onChanged,
  onError,
}: {
  tasks: HugoTaskView[];
  focusTaskId: string | null;
  onChanged: () => void;
  onError: (err: unknown) => void;
}) {
  const { t } = useI18n();
  if (!tasks.length) return null;
  return (
    <section aria-labelledby="hugo-sec-upcoming" data-testid="hugo-sec-upcoming">
      <h3 id="hugo-sec-upcoming" className="mb-2 text-xs font-medium uppercase tracking-wider text-ink-muted">
        {t('hugoWork.sec.upcoming')}
      </h3>
      <ul className="space-y-2">
        {tasks.map((task) => (
          <li key={task.id}>
            <HugoUpcomingRow task={task} focused={task.id === focusTaskId} onChanged={onChanged} onError={onError} />
          </li>
        ))}
      </ul>
    </section>
  );
}
