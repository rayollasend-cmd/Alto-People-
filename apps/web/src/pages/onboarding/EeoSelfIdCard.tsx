import { useState } from 'react';
import { CheckCircle2, Scale } from '@/components/ui/icons';
import {
  EEO_DISABILITY_VALUES,
  EEO_ETHNICITY_VALUES,
  EEO_GENDER_VALUES,
  EEO_VETERAN_VALUES,
  type EeoSelfIdInput,
} from '@alto-people/shared';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';

/**
 * Voluntary EEO self-identification (2026-10-21 system audit, Tier 1 #14),
 * the same card on the applicant's own page and on the new hire's
 * checklist. Every question is optional, "I'd rather not say" is always an
 * answer, and declining the whole form keeps nothing. The answers are
 * stored apart from the application and only ever counted in totals.
 */

const OPTION_KEY = {
  gender: (v: string) => `ob.eeo.g.${v}`,
  ethnicity: (v: string) => `ob.eeo.e.${v}`,
  veteranStatus: (v: string) => `ob.eeo.v.${v}`,
  disabilityStatus: (v: string) => `ob.eeo.d.${v}`,
} as const;

type Question = keyof typeof OPTION_KEY;

const QUESTIONS: Array<{ key: Question; label: MessageKey; values: readonly string[] }> = [
  { key: 'gender', label: 'ob.eeo.gender', values: EEO_GENDER_VALUES },
  { key: 'ethnicity', label: 'ob.eeo.ethnicity', values: EEO_ETHNICITY_VALUES },
  { key: 'veteranStatus', label: 'ob.eeo.veteran', values: EEO_VETERAN_VALUES },
  { key: 'disabilityStatus', label: 'ob.eeo.disability', values: EEO_DISABILITY_VALUES },
];

export function EeoSelfIdCard({
  answered,
  onSubmit,
  className,
}: {
  /** Already answered (or declined) — the card just says thank you. */
  answered: boolean;
  onSubmit: (input: EeoSelfIdInput) => Promise<unknown>;
  className?: string;
}) {
  const { t } = useI18n();
  const [values, setValues] = useState<Partial<Record<Question, string>>>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(answered);
  const [error, setError] = useState<string | null>(null);

  const submit = async (declined: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(
        declined
          ? { declined: true }
          : ({
              gender: values.gender || null,
              ethnicity: values.ethnicity || null,
              veteranStatus: values.veteranStatus || null,
              disabilityStatus: values.disabilityStatus || null,
            } as EeoSelfIdInput),
      );
      setDone(true);
    } catch {
      setError(t('ob.eeo.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className={className}>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2 text-sm font-medium text-ink">
          <Scale className="h-4 w-4 text-ink-muted" aria-hidden="true" />
          {t('ob.eeo.title')}
        </div>
        {done ? (
          <p className="flex items-start gap-2 text-sm text-ink-muted" role="status">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
            {t('ob.eeo.thanks')}
          </p>
        ) : (
          <>
            <p className="text-sm text-ink-muted">{t('ob.eeo.body')}</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {QUESTIONS.map((q) => (
                <Field key={q.key} label={t(q.label)}>
                  {(p) => (
                    <Select {...p} value={values[q.key] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [q.key]: e.target.value }))}>
                      <option value="">{t('ob.eeo.choose')}</option>
                      {q.values.map((v) => (
                        <option key={v} value={v}>
                          {v === 'DECLINE' ? t('ob.eeo.optDecline') : t(OPTION_KEY[q.key](v) as MessageKey)}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              ))}
            </div>
            {error && (
              <p className="text-sm text-alert" role="alert">
                {error}
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => void submit(true)} disabled={busy}>
                {t('ob.eeo.decline')}
              </Button>
              <Button size="sm" onClick={() => void submit(false)} loading={busy}>
                {t('ob.eeo.save')}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
