import type { HugoGoalStepResult, HugoTaskEventView, HugoTaskView } from '@alto-people/shared';
import type { Lang, MessageKey, Translate } from '@/lib/i18n';
import '@/lib/i18n/en/hugoWork';
import { fmtStepTime } from './hugoWorkText';

/**
 * The words of a goal (lib/hugoGoals on the API), from the codes it keeps:
 * the trail, how an approved step went, when Hugo looks next — in the
 * reader's language. The plan, the proposal's title and his updates come
 * already in their language (he writes them; the product words the step).
 */

const LOCALE: Record<Lang, string> = { en: 'en-US', es: 'es-US', tr: 'tr-TR', ht: 'fr-HT', pt: 'pt-BR', uk: 'uk-UA' };
const str = (v: string | number | null | undefined) => (v === null || v === undefined ? '' : String(v));

/** Refusals the app words plainly; anything else reads as the general one. */
const REFUSALS = ['shift_not_available', 'already_requested', 'no_supervisor', 'texting_off', 'not_sent', 'associate_unavailable', 'forbidden', 'not_found', 'too_soon', 'swap_in_flight', 'approval_pending'] as const;

export function goalRefusal(code: string | null, t: Translate): string {
  return code && (REFUSALS as readonly string[]).includes(code) ? t(`hugoWork.goal.refused.${code}` as MessageKey) : t('hugoWork.goal.refused.other');
}

/** How an approved step went, in place: "Done", "Sent for approval", or why not. */
export function goalResult(last: HugoGoalStepResult, t: Translate): { word: string; why: string | null } {
  if (last.outcome === 'done') return { word: t('hugoWork.goal.result.done'), why: null };
  if (last.outcome === 'pending') return { word: t('hugoWork.goal.result.pending'), why: null };
  return { word: t('hugoWork.goal.result.refused'), why: goalRefusal(last.code, t) };
}

/** "today 3:40 PM", "tomorrow 9:00 AM", or the day and time. */
export function goalWhen(iso: string, lang: Lang, now: Date = new Date(), t?: Translate): string {
  const d = new Date(iso);
  let time: string;
  try {
    time = new Intl.DateTimeFormat(LOCALE[lang], { hour: 'numeric', minute: '2-digit' }).format(d);
  } catch {
    time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(d);
  }
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (t && d.toDateString() === now.toDateString()) return t('hugoWork.goal.at.today', { time });
  if (t && d.toDateString() === tomorrow.toDateString()) return t('hugoWork.goal.at.tomorrow', { time });
  try {
    return new Intl.DateTimeFormat(LOCALE[lang], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d);
  } catch {
    return fmtStepTime(iso, lang, now);
  }
}

/** "Oct 31" for a pause's end. */
function goalDay(iso: string, lang: Lang): string {
  try {
    return new Intl.DateTimeFormat(LOCALE[lang], { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

const WATCHES = ['WATCH_TIME_OFF', 'WATCH_OPEN_SHIFTS', 'WATCH_PAYCHECK', 'WATCH_DOCUMENT'];

/** One line of a goal's trail; null for what isn't shown (each step of thinking is counted, not listed). */
export function goalEventLine(e: HugoTaskEventView, t: Translate, lang: Lang): string | null {
  const d = e.data ?? {};
  switch (e.code) {
    case 'STEP':
      return null;
    case 'STARTED':
      return t('hugoWork.goal.ev.STARTED');
    case 'PLANNED':
      return t('hugoWork.goal.ev.PLANNED', { count: str(d.count) });
    case 'PROPOSED':
      return d.action === 'KEEP_GOING' ? null : t('hugoWork.goal.ev.PROPOSED', { title: str(d.title) });
    case 'STEP_DONE':
      return t(`hugoWork.goal.ev.STEP_DONE.${d.outcome === 'pending' || d.outcome === 'refused' ? d.outcome : 'done'}` as MessageKey, { title: str(d.title) });
    case 'STEP_DECLINED':
      return t('hugoWork.goal.ev.STEP_DECLINED', { title: str(d.title) });
    case 'UPDATE':
      return str(d.text);
    case 'WATCH_STARTED':
      return WATCHES.includes(str(d.kind)) ? t(`hugoWork.goal.watch.${str(d.kind)}` as MessageKey) : null;
    case 'PAUSED':
      if (d.why === 'allowance') return t('hugoWork.goal.paused.allowance', { date: goalDay(str(d.until), lang) });
      if (d.why === 'steps') return t('hugoWork.goal.ev.PAUSED.steps', { count: str(d.count) });
      return t('hugoWork.goal.paused.daily');
    case 'KEPT_GOING':
      return t('hugoWork.goal.ev.KEPT_GOING');
    case 'DONE':
      return d.summary ? t('hugoWork.goal.ev.DONE', { summary: str(d.summary) }) : t('hugoWork.status.DONE');
    case 'GAVE_UP':
      return t('hugoWork.goal.ev.GAVE_UP', { summary: str(d.summary) });
    case 'CANCELLED':
      return t('hugoWork.ev.CANCELLED');
    case 'EXPIRED':
      return t('hugoWork.goal.ev.EXPIRED');
    case 'FAILED':
      return d.reason === 'no_access' || d.reason === 'error' ? t(`hugoWork.ev.FAILED.${d.reason}` as MessageKey) : t('hugoWork.ev.FAILED');
    default:
      return null;
  }
}

/** The line under the goal: what Hugo is doing about it now. */
export function goalNowLine(task: HugoTaskView, t: Translate, lang: Lang, now: Date = new Date()): string {
  const g = task.goal;
  if (!g) return '';
  if (task.status === 'NEEDS_YOU') return g.pending?.action === 'KEEP_GOING' ? t('hugoWork.goal.keepGoingAsk', { count: g.steps.used }) : t('hugoWork.goal.waitsOnYou');
  if (task.status !== 'WORKING' && task.status !== 'WAITING') {
    // Closed with his summary: the card shows it, once.
    if (g.summary) return '';
    const last = [...task.events].reverse().map((e) => goalEventLine(e, t, lang)).find((x) => x);
    return last ?? t(`hugoWork.status.${task.status}` as MessageKey);
  }
  if (g.thinking) return g.plan.length ? t('hugoWork.goal.thinking') : t('hugoWork.goal.planning');
  if (g.paused) return g.paused.why === 'allowance' ? t('hugoWork.goal.paused.allowance', { date: goalDay(g.paused.until, lang) }) : t('hugoWork.goal.paused.daily');
  return g.nextCheckAt ? t('hugoWork.goal.nextCheck', { when: goalWhen(g.nextCheckAt, lang, now, t) }) : t('hugoWork.goal.planning');
}

/** A goal refusal from the API (starting one), by its code. */
export function goalStartError(err: unknown): MessageKey | null {
  const code = (err as { code?: string } | null)?.code;
  return code === 'hugo_no_model' || code === 'too_many_goals' || code === 'hugo_allowance' || code === 'invalid_goal' ? (`hugoWork.goal.error.${code}` as MessageKey) : null;
}
