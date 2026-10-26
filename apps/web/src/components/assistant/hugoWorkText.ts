import type { HugoNoteView, HugoTaskEventView, HugoTaskKind, HugoTaskView } from '@alto-people/shared';
import type { Lang, MessageKey, Translate } from '@/lib/i18n';
import '@/lib/i18n/en/hugoWork';

/**
 * The words of Hugo's tasks and notes, built from the codes the API keeps
 * (packages/shared/src/hugoWork.ts) in the reader's language — a title, a
 * line per step on the trail, what a task needs from them, a note.
 */

const LOCALE: Record<Lang, string> = { en: 'en-US', es: 'es-US', tr: 'tr-TR', ht: 'fr-HT', pt: 'pt-BR', uk: 'uk-UA' };

const fmt = (lang: Lang, opts: Intl.DateTimeFormatOptions) => {
  try {
    return new Intl.DateTimeFormat(LOCALE[lang], opts);
  } catch {
    return new Intl.DateTimeFormat('en-US', opts);
  }
};

/** "Sat, Oct 31, 7:00 AM" on the store's clock. */
export function fmtWhen(iso: string, timeZone: string, lang: Lang): string {
  return fmt(lang, { timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}

/** "Sat, Oct 31" for a calendar day. */
export function fmtDay(ymd: string, lang: Lang): string {
  return fmt(lang, { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(`${ymd}T12:00:00Z`));
}

/** "Dec 1 – Dec 3", or one day. */
export function fmtRange(start: string, end: string, lang: Lang): string {
  const f = fmt(lang, { timeZone: 'UTC', month: 'short', day: 'numeric' });
  const a = f.format(new Date(`${start}T12:00:00Z`));
  return start === end ? a : `${a} – ${f.format(new Date(`${end}T12:00:00Z`))}`;
}

/** When a step happened: the time today, the day and time before. */
export function fmtStepTime(iso: string, lang: Lang, now: Date = new Date()): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === now.toDateString();
  return fmt(lang, sameDay ? { hour: 'numeric', minute: '2-digit' } : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d);
}

const more = (first: string, count: number, t: Translate) => (count > 0 ? t('hugoWork.more', { first, count }) : first);

export function taskTitle(task: Pick<HugoTaskView, 'kind' | 'subject'>, t: Translate, lang: Lang): string {
  const s = task.subject;
  switch (task.kind) {
    case 'WATCH_TIME_OFF': {
      const first = s.timeOff?.[0];
      return t('hugoWork.title.WATCH_TIME_OFF', { dates: first ? more(fmtRange(first.startDate, first.endDate, lang), (s.timeOff?.length ?? 1) - 1, t) : '' });
    }
    case 'WATCH_DOCUMENT':
      return t('hugoWork.title.WATCH_DOCUMENT', { document: more(s.documents?.[0]?.name ?? '', (s.documents?.length ?? 1) - 1, t) });
    case 'FIND_COVER':
      return t('hugoWork.title.FIND_COVER', { when: s.shift ? fmtWhen(s.shift.startsAt, s.shift.timezone, lang) : '' });
    case 'CHASE_CONFIRMATIONS':
      return t('hugoWork.title.CHASE_CONFIRMATIONS', { day: s.date ? fmtDay(s.date, lang) : '' });
    default:
      return t(`hugoWork.title.${task.kind}` as MessageKey);
  }
}

/** What Hugo will do — the promise on a Start card and under a running task. */
export function taskDoes(task: Pick<HugoTaskView, 'kind' | 'subject'>, t: Translate): string {
  return t(`hugoWork.does.${task.kind}` as MessageKey, { days: task.subject.days ?? 7 });
}

const str = (v: string | number | null | undefined) => (v === null || v === undefined ? '' : String(v));

/** One line of the trail. */
export function eventLine(e: HugoTaskEventView, kind: HugoTaskKind, t: Translate, lang: Lang): string {
  const d = e.data ?? {};
  switch (e.code) {
    case 'DECIDED':
      return t(`hugoWork.ev.DECIDED.${str(d.status) || 'APPROVED'}` as MessageKey, { dates: fmtRange(str(d.startDate), str(d.endDate) || str(d.startDate), lang) });
    case 'FOUND_SHIFTS':
      return t('hugoWork.ev.FOUND_SHIFTS', { count: str(d.count), when: d.startsAt ? fmtWhen(str(d.startsAt), str(d.timezone) || 'America/New_York', lang) : '' });
    case 'PAID':
      return t('hugoWork.ev.PAID', { period: fmtRange(str(d.periodStart), str(d.periodEnd), lang) });
    case 'NO_ONE_LEFT':
      return t('hugoWork.ev.NO_ONE_LEFT', { count: str(d.asked) });
    case 'CALLED_OFF':
      return t('hugoWork.ev.CALLED_OFF', { name: str(d.name), when: d.startsAt ? fmtWhen(str(d.startsAt), str(d.timezone) || 'America/New_York', lang) : '' });
    case 'PASSED_TO_SUPERVISOR':
      return d.who ? t('hugoWork.ev.PASSED_TO_SUPERVISOR', { who: str(d.who) }) : t('hugoWork.ev.PASSED_TO_SUPERVISOR.anon');
    case 'CANCELLED':
      return d.by === 'swap' ? t('hugoWork.ev.CANCELLED.swap') : t('hugoWork.ev.CANCELLED');
    case 'EXPIRED':
      if (kind === 'FIND_COVER') return d.waiting === 'manager' ? t('hugoWork.ev.EXPIRED.manager') : t('hugoWork.ev.EXPIRED.cover');
      if (kind === 'WATCH_OPEN_SHIFTS') return t('hugoWork.ev.EXPIRED.openShifts');
      return t('hugoWork.ev.EXPIRED');
    case 'FAILED':
      return d.reason === 'gone' || d.reason === 'no_access' || d.reason === 'error' ? t(`hugoWork.ev.FAILED.${d.reason}` as MessageKey) : t('hugoWork.ev.FAILED');
    default:
      return t(`hugoWork.ev.${e.code}` as MessageKey, { name: str(d.name), count: str(d.count), document: str(d.document) });
  }
}

/** The latest thing that happened, for the line under the title. */
export function latestLine(task: HugoTaskView, t: Translate, lang: Lang): string {
  const last = [...task.events].reverse().find((e) => e.code !== 'STARTED');
  return last ? eventLine(last, task.kind, t, lang) : taskDoes(task, t);
}

/** What a task waiting on the person needs from them. */
export function needsLine(task: HugoTaskView, t: Translate): string | null {
  if (task.status !== 'NEEDS_YOU' || !task.needs) return null;
  const r = task.result ?? {};
  switch (task.needs) {
    case 'REUPLOAD': {
      const doc = r.documents?.find((x) => x.status === 'REJECTED');
      return doc?.reason ? t('hugoWork.needs.REUPLOAD.reason', { document: doc.name, reason: doc.reason }) : t('hugoWork.needs.REUPLOAD', { document: doc?.name ?? '' });
    }
    case 'STILL_UNCONFIRMED':
      return t('hugoWork.needs.STILL_UNCONFIRMED', { names: (r.unconfirmed ?? []).map((x) => x.name).join(', ') });
    case 'CALLED_OFF': {
      const last = r.calledOff?.[r.calledOff.length - 1];
      return t('hugoWork.needs.CALLED_OFF', { name: last?.name ?? '' });
    }
    default:
      return t(`hugoWork.needs.${task.needs}` as MessageKey);
  }
}

export interface NoteText {
  title: string;
  body: string;
  action: string;
}

export function noteText(note: HugoNoteView, t: Translate, lang: Lang): NoteText {
  const d = note.data;
  switch (note.kind) {
    case 'CREDENTIAL_EXPIRING': {
      const c = d.credential;
      const wordKey = `hugoWork.cred.${c?.word ?? 'OTHER'}` as MessageKey;
      const credential = c?.word ? t(wordKey) : (c?.name ?? t('hugoWork.cred.OTHER'));
      const days = c?.days ?? 0;
      const title =
        days > 0
          ? t('hugoWork.note.CREDENTIAL_EXPIRING.soon', { credential, days })
          : days === 0
            ? t('hugoWork.note.CREDENTIAL_EXPIRING.today', { credential })
            : t('hugoWork.note.CREDENTIAL_EXPIRING.past', { credential, days: Math.abs(days) });
      return { title, body: t('hugoWork.note.CREDENTIAL_EXPIRING.body'), action: t('hugoWork.note.CREDENTIAL_EXPIRING.action') };
    }
    case 'OPEN_SHIFT_MATCH': {
      const when = d.shift ? fmtWhen(d.shift.startsAt, d.shift.timezone, lang) : '';
      const site = d.shift?.site ?? '';
      return {
        title: t('hugoWork.note.OPEN_SHIFT_MATCH.title'),
        body: d.more ? t('hugoWork.note.OPEN_SHIFT_MATCH.bodyMore', { when, site, count: d.more }) : t('hugoWork.note.OPEN_SHIFT_MATCH.body', { when, site }),
        action: t('hugoWork.note.OPEN_SHIFT_MATCH.action'),
      };
    }
    case 'DIRECT_DEPOSIT_MISSING':
      return {
        title: t('hugoWork.note.DIRECT_DEPOSIT_MISSING.title', { payday: d.payday ? fmtDay(d.payday, lang) : '' }),
        body: t('hugoWork.note.DIRECT_DEPOSIT_MISSING.body'),
        action: t('hugoWork.note.DIRECT_DEPOSIT_MISSING.action'),
      };
    case 'UNCONFIRMED_TOMORROW': {
      const u = d.unconfirmed;
      return {
        title: t('hugoWork.note.UNCONFIRMED_TOMORROW.title', { count: u?.count ?? 0, total: u?.total ?? 0, day: u?.date ? fmtDay(u.date, lang) : '' }),
        body: t('hugoWork.note.UNCONFIRMED_TOMORROW.body'),
        action: t('hugoWork.note.UNCONFIRMED_TOMORROW.action'),
      };
    }
  }
}

/** An API refusal in the reader's words, by its code. */
export function hugoWorkError(err: unknown, t: Translate): string {
  const code = (err as { code?: string } | null)?.code;
  const known = ['nothing_pending', 'nothing_in_review', 'too_soon', 'swap_in_flight', 'nothing_to_chase', 'too_many_tasks', 'task_busy', 'no_supervisor', 'hugo_off'];
  return code && known.includes(code) ? t(`hugoWork.error.${code}` as MessageKey) : t('hugoWork.error.generic');
}
