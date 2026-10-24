import { useCallback, useRef, useState } from 'react';
import { Coffee } from '@/components/ui/icons';
import { useI18n } from '@/lib/i18n';
import { getBreakQuestions } from '@/lib/laborLiveApi';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Field, SegmentedControl, Textarea } from '@/components/ui';

/**
 * "Did you get your meal break?" — asked at clock-out where the state
 * requires breaks (and the shift is long enough to need one). The answer
 * goes with the clock-out: a "no" is paid as the premium where the labor
 * rules are live, and tells the lead everywhere else.
 *
 *   const breaks = useBreakAttestationPrompt();
 *   const answer = await breaks.ask();          // undefined: nothing to ask
 *   if (answer === 'cancel') return;
 *   await clockOut({ geo, breakAttestation: answer });
 *   …
 *   {breaks.element}
 */

export interface BreakAnswer {
  meal: 'YES' | 'NO' | 'WAIVED';
  rest?: 'YES' | 'NO' | null;
  note?: string | null;
}

export function useBreakAttestationPrompt() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [askRest, setAskRest] = useState(false);
  const [meal, setMeal] = useState<'YES' | 'NO' | 'WAIVED'>('YES');
  const [rest, setRest] = useState<'YES' | 'NO'>('YES');
  const [note, setNote] = useState('');
  const resolver = useRef<((a: BreakAnswer | 'cancel' | undefined) => void) | null>(null);

  const ask = useCallback(async (): Promise<BreakAnswer | 'cancel' | undefined> => {
    // The question is a courtesy the law requires; if it can't be fetched, clock-out still works.
    const q = await getBreakQuestions().catch(() => ({ meal: false, rest: false, mealAfterHours: null }));
    if (!q.meal && !q.rest) return undefined;
    setAskRest(q.rest);
    setMeal('YES');
    setRest('YES');
    setNote('');
    setOpen(true);
    return new Promise((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const finish = (a: BreakAnswer | 'cancel') => {
    setOpen(false);
    resolver.current?.(a);
    resolver.current = null;
  };

  const element = (
    <Dialog open={open} onOpenChange={(o) => !o && finish('cancel')}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Coffee className="h-4 w-4" aria-hidden="true" />
            {t('breakq.title')}
          </DialogTitle>
          <DialogDescription>{t('breakq.why')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-ink">{t('breakq.meal')}</legend>
            <SegmentedControl<'YES' | 'NO' | 'WAIVED'>
              ariaLabel={t('breakq.meal')}
              value={meal}
              onChange={setMeal}
              options={[
                { value: 'YES', label: t('breakq.mealYes') },
                { value: 'NO', label: t('breakq.mealNo') },
                { value: 'WAIVED', label: t('breakq.mealWaived') },
              ]}
            />
          </fieldset>
          {askRest && (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-ink">{t('breakq.rest')}</legend>
              <SegmentedControl<'YES' | 'NO'>
                ariaLabel={t('breakq.rest')}
                value={rest}
                onChange={setRest}
                options={[
                  { value: 'YES', label: t('breakq.mealYes') },
                  { value: 'NO', label: t('breakq.mealNo') },
                ]}
              />
            </fieldset>
          )}
          {(meal === 'NO' || (askRest && rest === 'NO')) && (
            <Field label={t('breakq.note')}>
              {(p) => <Textarea {...p} rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}
            </Field>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => finish('cancel')}>
            {t('timefix.cancel')}
          </Button>
          <Button onClick={() => finish({ meal, rest: askRest ? rest : null, note: note.trim() || null })}>{t('breakq.submit')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return { ask, element };
}
