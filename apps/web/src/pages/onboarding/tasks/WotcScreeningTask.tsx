import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { CheckCircle2 } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { ApiError } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import { WOTC_QUESTIONS, getWotcApplicant, submitWotcApplicant, type WotcAnswer, type WotcQuestion } from '@/lib/taxcompApi';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { QueryError } from '@/components/ui/QueryError';
import { cn } from '@/lib/cn';
import { Field, TaskShell, useNextTask } from './ProfileInfoTask';

/**
 * WOTC pre-screening — the Form 8850 / ETA 9061 applicant questions in
 * plain words. Optional: "I'd rather not answer" completes the task too.
 * The veteran follow-ups appear only after "yes" to the veteran question.
 */

const VETERAN_FOLLOW_UPS: WotcQuestion[] = ['vetDisability', 'vetDischargedLastYear', 'vetUnemployed6m', 'vetUnemployed4w'];
const ANSWERS: WotcAnswer[] = ['yes', 'no', 'unsure'];

export function WotcScreeningTask() {
  const { applicationId } = useParams<{ applicationId: string }>();
  const { user } = useAuth();
  const { t } = useI18n();
  const navigate = useNavigate();
  const isAssociate = user?.role === 'ASSOCIATE';
  const backTo = isAssociate ? `/onboarding/me/${applicationId}` : `/onboarding/applications/${applicationId}`;
  const next = useNextTask('WOTC_SCREENING');
  const q = useQuery({ queryKey: ['wotc', 'applicant', applicationId], queryFn: () => getWotcApplicant(applicationId!), enabled: !!applicationId });
  const [answers, setAnswers] = useState<Partial<Record<WotcQuestion, WotcAnswer>>>({});
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    const s = q.data?.screening;
    if (s) {
      setAnswers(s.answers ?? {});
      setName(s.signedName ?? '');
    }
  }, [q.data]);

  const visible = WOTC_QUESTIONS.filter((k) => !VETERAN_FOLLOW_UPS.includes(k) || answers.veteran === 'yes');
  const done = q.data?.screening && q.data.screening.status !== 'NOT_STARTED' ? q.data.screening : null;

  const submit = useMutation({
    mutationFn: (declined: boolean) =>
      submitWotcApplicant(applicationId!, declined ? { declined: true, signedName: name.trim() } : { declined: false, signedName: name.trim(), answers: Object.fromEntries(visible.map((k) => [k, answers[k]])) }),
    onSuccess: () => {
      void q.refetch();
      if (next) navigate(next.route);
      else navigate(backTo);
    },
    onError: (err) => setProblem(err instanceof ApiError ? err.message : t('ob.wotc.saveFailed')),
  });

  const send = (declined: boolean) => {
    setProblem(null);
    if (name.trim().length < 2) return setProblem(t('ob.wotc.nameRequired'));
    if (!declined && visible.some((k) => !answers[k])) return setProblem(t('ob.wotc.missing'));
    submit.mutate(declined);
  };

  return (
    <TaskShell title={t('ob.wotc.title')} backTo={backTo}>
      {q.isError ? (
        <QueryError what={t('ob.wotc.title')} query={q} />
      ) : q.isLoading ? (
        <SkeletonRows count={6} />
      ) : (
        <form
          className="space-y-6"
          onSubmit={(e) => {
            e.preventDefault();
            send(false);
          }}
        >
          <p className="text-sm text-ink">{t('ob.wotc.intro')}</p>
          {done && (
            <p role="status" className="flex items-center gap-2 rounded-md border border-success/40 bg-success/10 p-3 text-sm text-ink">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-success" aria-hidden="true" />
              {done.status === 'DECLINED' ? t('ob.wotc.doneDeclined') : t('ob.wotc.done')} {done.signedAt ? t('ob.wotc.signedOn', { date: fmtDate(done.signedAt) }) : ''}
            </p>
          )}
          <p className="text-xs text-ink-muted">{t('ob.wotc.answerEach')}</p>
          <ol className="space-y-5">
            {visible.map((k) => (
              <li key={k} className={cn(VETERAN_FOLLOW_UPS.includes(k) && 'border-l-2 border-line pl-4')}>
                <fieldset>
                  <legend className="mb-2 text-sm font-medium text-ink">{t(`ob.wotc.q.${k}` as MessageKey)}</legend>
                  <div className="flex flex-wrap gap-2" role="radiogroup">
                    {ANSWERS.map((a) => (
                      <label
                        key={a}
                        className={cn(
                          'inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border px-4 text-sm',
                          answers[k] === a ? 'border-accent bg-accent-fill/15 text-ink' : 'border-line text-ink hover:bg-surface-raised',
                        )}
                      >
                        <input type="radio" className="sr-only" name={k} value={a} checked={answers[k] === a} onChange={() => setAnswers({ ...answers, [k]: a })} />
                        {t(`ob.wotc.${a}` as MessageKey)}
                      </label>
                    ))}
                  </div>
                </fieldset>
              </li>
            ))}
          </ol>
          <Field label={t('ob.wotc.signLabel')} hint={t('ob.wotc.signHint')}>
            {(p) => <Input {...p} autoComplete="name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />}
          </Field>
          {problem && (
            <p role="alert" className="text-sm text-alert">
              {problem}
            </p>
          )}
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <Button type="button" variant="ghost" onClick={() => send(true)} disabled={submit.isPending}>
                {t('ob.wotc.decline')}
              </Button>
              <p className="mt-1 text-xs text-ink-muted">{t('ob.wotc.declineHint')}</p>
            </div>
            <Button type="submit" loading={submit.isPending && submit.variables === false}>
              {t('ob.wotc.submit')}
            </Button>
          </div>
        </form>
      )}
    </TaskShell>
  );
}
