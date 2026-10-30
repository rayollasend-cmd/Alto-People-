import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { HUGO_RECURRING_WHATS, type HugoRecurringWhat, type HugoTaskView } from '@alto-people/shared';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Input';
import type { HugoMe } from '@/lib/hugoApi';
import { startHugoTask } from '@/lib/hugoApi';
import { useI18n } from '@/lib/i18n';
import '@/lib/i18n/en/hugoWork';
import { HugoScheduleFields, type ScheduleValue } from './HugoUpcoming';

/**
 * "Repeat something": what (one of the answers this person can have —
 * what the assistant offers them, their hours, or a question of their own
 * while a model is on), how often, what time. Start is the tap that sets
 * it up (lib/hugoRecurring); it then sits under Upcoming.
 */

/** What this person can have on a schedule: the answers GET /hugo offers them, their hours, their own question. */
export function repeatableWhats(me: Pick<HugoMe, 'can' | 'model'> | null, hasOwnHours: boolean): HugoRecurringWhat[] {
  const keys = new Set((me?.can ?? []).map((c) => c.key));
  return HUGO_RECURRING_WHATS.filter((w) => (w === 'ASK' ? Boolean(me?.model) : w === 'MY_HOURS' ? hasOwnHours : keys.has(w)));
}

export function HugoUpcomingForm({ whats, onStarted, onCancel, onError }: { whats: HugoRecurringWhat[]; onStarted: (task: HugoTaskView) => void; onCancel: () => void; onError: (err: unknown) => void }) {
  const { t } = useI18n();
  const [what, setWhat] = useState<HugoRecurringWhat>(whats[0] ?? 'SCHEDULE');
  const [question, setQuestion] = useState('');
  const [when, setWhen] = useState<ScheduleValue>({ cadence: 'DAILY', weekday: 5, time: '07:00' });
  const start = useMutation({
    mutationFn: () =>
      startHugoTask(
        {
          kind: 'RECURRING',
          what,
          cadence: when.cadence,
          time: when.time,
          ...(when.cadence === 'WEEKLY' ? { weekday: when.weekday } : {}),
          ...(what === 'ASK' ? { question: question.trim() } : {}),
        },
        'panel',
      ),
    onSuccess: (r) => onStarted(r.task),
    onError,
  });
  const ready = /^\d{2}:\d{2}$/.test(when.time) && (what !== 'ASK' || question.trim().length >= 3);

  return (
    <form
      className="space-y-3 rounded-xl border border-line bg-surface-raised p-3"
      data-testid="hugo-repeat-form"
      aria-labelledby="hugo-repeat-title"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) start.mutate();
      }}
    >
      <h4 id="hugo-repeat-title" className="text-sm font-medium text-ink">
        {t('hugoWork.repeat.title')}
      </h4>
      <Field label={t('hugoWork.repeat.what')}>
        {(p) => (
          <Select {...p} value={what} disabled={start.isPending} onChange={(e) => setWhat(e.target.value as HugoRecurringWhat)}>
            {whats.map((w) => (
              <option key={w} value={w}>
                {t(`hugoWork.what.${w}`)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {what === 'ASK' && (
        <Field label={t('hugoWork.what.ASK')} hint={t('hugoWork.repeat.questionHint')} required>
          {(p) => <Textarea {...p} rows={2} maxLength={300} value={question} disabled={start.isPending} onChange={(e) => setQuestion(e.target.value)} />}
        </Field>
      )}
      <HugoScheduleFields value={when} onChange={setWhen} disabled={start.isPending} />
      <p className="text-xs leading-relaxed text-ink-muted">{t('hugoWork.does.RECURRING')}</p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" loading={start.isPending} disabled={!ready || start.isPending}>
          {t('hugoWork.repeat.start')}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={start.isPending} onClick={onCancel}>
          {t('hugoWork.repeat.cancel')}
        </Button>
      </div>
    </form>
  );
}
