import { useId, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { HUGO_GOAL_MAX_CHARS, findSensitiveNumbers } from '@alto-people/shared';
import { Target } from '@/components/ui/icons';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Input';
import { useAuth } from '@/lib/auth';
import { startHugoTask } from '@/lib/hugoApi';
import { useI18n, type MessageKey } from '@/lib/i18n';
import '@/lib/i18n/en/hugoWork';
import { goalStartError } from './hugoGoalText';
import { hugoWorkError } from './hugoWorkText';

const FOR_ASSOCIATE: MessageKey[] = ['hugoWork.goal.ex.hours', 'hugoWork.goal.ex.documents', 'hugoWork.goal.ex.dayOff'];
const FOR_DESK: MessageKey[] = ['hugoWork.goal.ex.staffed', 'hugoWork.goal.ex.confirmed', 'hugoWork.goal.ex.openShifts'];

/**
 * "Give Hugo a goal": an outcome in the person's own words, with two or three
 * examples for their role (tapping one fills the box — Start is still theirs).
 * He plans it, works on it in the background and asks before he changes
 * anything. Shown only while the model is on (the API says why otherwise).
 */
export function HugoGoalStart({ name, onStarted }: { name: string; onStarted: (taskId: string) => void }) {
  const { t } = useI18n();
  const { user, can } = useAuth();
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const start = useMutation({
    mutationFn: (goal: string) => startHugoTask({ kind: 'GOAL', goal }, 'panel'),
    onSuccess: (r) => {
      setText('');
      void queryClient.invalidateQueries({ queryKey: ['hugo', 'tasks'] });
      void queryClient.invalidateQueries({ queryKey: ['hugo', 'summary'] });
      onStarted(r.task.id);
    },
  });
  const examples = user?.associateId ? FOR_ASSOCIATE : can('manage:scheduling') && user?.role !== 'CLIENT_PORTAL' ? FOR_DESK : [];
  const goal = text.trim();
  const sensitive = findSensitiveNumbers(goal).length > 0;
  const tooLong = goal.length > HUGO_GOAL_MAX_CHARS;
  const ready = goal.length >= 3 && !sensitive && !tooLong && !start.isPending;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ready) start.mutate(goal);
  };
  const failed = start.error ? (goalStartError(start.error) ? t(goalStartError(start.error)!) : hugoWorkError(start.error, t)) : null;

  return (
    <form onSubmit={submit} className="rounded-xl border border-line bg-surface-raised p-3" data-testid="hugo-goal-start" aria-labelledby={`${id}-label`}>
      <div className="flex items-center gap-2">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent-fill/15 text-accent" aria-hidden="true">
          <Target className="h-4 w-4" />
        </span>
        <label id={`${id}-label`} htmlFor={`${id}-goal`} className="text-sm font-medium text-ink">
          {t('hugoWork.goal.give', { name })}
        </label>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-ink-muted" id={`${id}-hint`}>
        {t('hugoWork.goal.hint')}
      </p>
      <Textarea
        ref={box}
        id={`${id}-goal`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (ready) start.mutate(goal);
          }
        }}
        rows={2}
        maxLength={HUGO_GOAL_MAX_CHARS + 20}
        enterKeyHint="send"
        placeholder={t('hugoWork.goal.placeholder')}
        aria-describedby={`${id}-hint${sensitive || tooLong || failed ? ` ${id}-problem` : ''}`}
        invalid={sensitive || tooLong}
        className="mt-2 min-h-[64px] resize-none"
      />
      {(sensitive || tooLong || failed) && (
        <p id={`${id}-problem`} className="mt-1.5 text-xs text-negative" role="alert">
          {sensitive ? t('hugoWork.goal.sensitive') : tooLong ? t('hugoWork.goal.tooLong') : failed}
        </p>
      )}
      {examples.length > 0 && (
        <div className="mt-2">
          <p className="text-xs text-ink-muted">{t('hugoWork.goal.examples')}</p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {examples.map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => {
                  setText(t(key));
                  box.current?.focus();
                }}
                className="min-h-8 rounded-full border border-line bg-surface px-3 py-1 text-left text-xs text-ink transition-colors hover:border-accent/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright coarse:min-h-11"
              >
                {t(key)}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="mt-2.5 flex justify-end">
        <Button type="submit" size="sm" disabled={!ready} loading={start.isPending}>
          {t('hugoWork.goal.start')}
        </Button>
      </div>
    </form>
  );
}
