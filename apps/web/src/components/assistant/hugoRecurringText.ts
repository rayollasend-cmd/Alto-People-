import type { HugoRecurringSchedule, HugoTaskEventView, HugoTaskSubject } from '@alto-people/shared';
import type { Lang, MessageKey, Translate } from '@/lib/i18n';
import '@/lib/i18n/en/hugoWork';

/**
 * The words of Hugo's recurring briefs, from the codes the API keeps
 * (packages/shared/src/hugoWork.ts — HugoRecurringSchedule): what a brief
 * is, when it comes ("Every Friday at 4:00 PM"), when the next one is, and
 * the lines on its trail. The reader's language and clock format; the
 * brief's own zone.
 */

const LOCALE: Record<Lang, string> = { en: 'en-US', es: 'es-US', tr: 'tr-TR', ht: 'fr-HT', pt: 'pt-BR', uk: 'uk-UA' };
/** Intl has no Haitian Creole: its weekdays, by hand. */
const HT_DAYS = ['dimanch', 'lendi', 'madi', 'mèkredi', 'jedi', 'vandredi', 'samdi'];

const fmt = (lang: Lang, opts: Intl.DateTimeFormatOptions) => {
  try {
    return new Intl.DateTimeFormat(LOCALE[lang], opts);
  } catch {
    return new Intl.DateTimeFormat('en-US', opts);
  }
};

/** "4:00 PM" / "16:00" for an HH:MM, as the reader's clock writes it. */
export function fmtClock(time: string, lang: Lang): string {
  const [h = 0, m = 0] = time.split(':').map(Number);
  return fmt(lang, { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' }).format(new Date(Date.UTC(2026, 0, 4, h, m)));
}

/** Friday… (0 = Sunday). 2026-01-04 was a Sunday. */
export function dayName(dow: number, lang: Lang): string {
  if (lang === 'ht') return HT_DAYS[dow] ?? '';
  return fmt(lang, { timeZone: 'UTC', weekday: 'long' }).format(new Date(Date.UTC(2026, 0, 4 + dow, 12)));
}

/** "Every Friday at 4:00 PM", "Every weekday at 7:00 AM". */
export function scheduleText(s: Pick<HugoRecurringSchedule, 'cadence' | 'weekday' | 'time'>, t: Translate, lang: Lang): string {
  return t(`hugoWork.cadence.${s.cadence}` as MessageKey, { time: fmtClock(s.time, lang), day: dayName(s.weekday ?? 5, lang) });
}

/** What the brief sends, as its name. A question is quoted. */
export function whatText(s: Pick<HugoRecurringSchedule, 'what' | 'question'>, t: Translate): string {
  if (s.what === 'ASK' && s.question) return t('hugoWork.what.ASKq', { question: s.question.length > 60 ? `${s.question.slice(0, 59).trimEnd()}…` : s.question });
  return t(`hugoWork.what.${s.what}` as MessageKey);
}

/** The task's title: "Your hours this week · Every Friday at 5:00 PM". */
export function recurringTitle(subject: HugoTaskSubject, t: Translate, lang: Lang): string {
  const s = subject.recurring;
  if (!s) return t('hugoWork.what.ASK');
  return t('hugoWork.title.RECURRING', { what: whatText(s, t), schedule: scheduleText(s, t, lang) });
}

/** "Fri, Nov 6" on the brief's own clock. */
export function fmtNext(iso: string, timeZone: string, lang: Lang): string {
  return fmt(lang, { timeZone, weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(iso));
}

const str = (v: string | number | null | undefined) => (v === null || v === undefined ? '' : String(v));

/** The trail lines only a recurring brief writes; null for the rest. */
export function recurringEventLine(e: HugoTaskEventView, t: Translate, lang: Lang): string | null {
  const d = e.data ?? {};
  switch (e.code) {
    case 'DELIVERED': {
      const text = str(d.text).replace(/\s+/g, ' ').trim();
      return t('hugoWork.ev.DELIVERED', { text: text.length > 140 ? `${text.slice(0, 139).trimEnd()}…` : text });
    }
    case 'RESCHEDULED':
      return t('hugoWork.ev.RESCHEDULED', {
        schedule: scheduleText({ cadence: (str(d.cadence) || 'DAILY') as HugoRecurringSchedule['cadence'], weekday: d.weekday === null || d.weekday === undefined ? null : Number(d.weekday), time: str(d.time) || '08:00' }, t, lang),
      });
    case 'DEFERRED':
      return t('hugoWork.ev.DEFERRED');
    case 'SKIPPED':
      return ['late', 'no_model', 'error', 'nothing'].includes(str(d.reason)) ? t(`hugoWork.ev.SKIPPED.${str(d.reason)}` as MessageKey) : t('hugoWork.ev.SKIPPED.error');
    default:
      return null;
  }
}

/** "This ends on Sun, Apr 25. Keep it coming?" */
export function keepGoingLine(task: { expiresAt: string; subject: HugoTaskSubject }, t: Translate, lang: Lang): string {
  return t('hugoWork.needs.KEEP_GOING', { date: fmtNext(task.expiresAt, task.subject.recurring?.timezone ?? 'America/New_York', lang) });
}

/** When the last one went: the time today, the day and time before. */
export function fmtStepTimeShort(iso: string, lang: Lang, now: Date = new Date()): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === now.toDateString();
  return fmt(lang, sameDay ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(d);
}
