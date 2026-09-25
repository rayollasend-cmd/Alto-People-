import { escapeText, fmtUtc, fold } from './calendarFeed.js';
import { send } from './notifications.js';
import { DEFAULT_TIMEZONE } from './timezone.js';

/**
 * Interview invites that land in a calendar.
 *
 * Scheduling an interview used to store a time and tell no one. Now the
 * candidate and the interviewer each get an email with a calendar invite
 * (.ics, METHOD:REQUEST) that Google, Outlook and Apple Calendar all add
 * with one tap — no account linking, no OAuth app to register.
 *
 * The UID is the interview's own id, and SEQUENCE is bumped on every
 * reschedule and on cancel (METHOD:CANCEL), so a calendar updates or
 * removes the invite it already holds instead of piling up copies.
 */

export interface InviteInterview {
  id: string;
  scheduledFor: Date;
  durationMinutes: number;
  location: string | null;
  inviteSequence: number;
}

export interface InvitePerson {
  name: string;
  email: string;
}

export interface InviteContext {
  interview: InviteInterview;
  candidate: InvitePerson & { position: string | null };
  interviewer: InvitePerson | null;
  /** Who scheduled it — the invite's ORGANIZER, where replies go. */
  organizer: InvitePerson;
}

function uidOf(interviewId: string): string {
  return `interview-${interviewId}@alto-people`;
}

/** "Fri, Sep 26, 10:00 AM EDT" — the email body's time, zone spelled out.
 *  The attachment itself carries UTC and each calendar shows local time. */
export function inviteWhen(d: Date, timeZone = DEFAULT_TIMEZONE): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(d);
}

function attendee(p: InvitePerson): string {
  return fold(
    `ATTENDEE;CN=${escapeText(p.name)};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${p.email}`,
  );
}

/** The .ics for one interview — a request (new or updated) or a cancel. */
export function buildInterviewIcs(
  ctx: InviteContext,
  method: 'REQUEST' | 'CANCEL',
  now: Date = new Date(),
): string {
  const { interview, candidate, interviewer, organizer } = ctx;
  const ends = new Date(interview.scheduledFor.getTime() + interview.durationMinutes * 60_000);
  const title = `Interview: ${candidate.name}${candidate.position ? ` (${candidate.position})` : ''} — Alto`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Alto People//Interviews//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${method}`,
    'BEGIN:VEVENT',
    fold(`UID:${uidOf(interview.id)}`),
    `SEQUENCE:${interview.inviteSequence}`,
    `DTSTAMP:${fmtUtc(now)}`,
    `DTSTART:${fmtUtc(interview.scheduledFor)}`,
    `DTEND:${fmtUtc(ends)}`,
    fold(`SUMMARY:${escapeText(title)}`),
    ...(interview.location ? [fold(`LOCATION:${escapeText(interview.location)}`)] : []),
    fold(`ORGANIZER;CN=${escapeText(organizer.name)}:mailto:${organizer.email}`),
    attendee(candidate),
    ...(interviewer ? [attendee(interviewer)] : []),
    `STATUS:${method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  // RFC 5545 mandates CRLF line endings.
  return lines.join('\r\n') + '\r\n';
}

/**
 * Email the invite (or the cancellation) to the candidate and the
 * interviewer, each in words meant for them. Fire-and-forget by design:
 * the interview is already saved, and a mail hiccup must not undo it.
 * Returns who it was addressed to, for the caller's response.
 */
export function sendInterviewInvites(
  ctx: InviteContext,
  method: 'REQUEST' | 'CANCEL',
  opts: { rescheduled?: boolean; only?: 'interviewer' } = {},
): { candidate: boolean; interviewer: boolean } {
  const ics = Buffer.from(buildInterviewIcs(ctx, method), 'utf8');
  const attachment = {
    filename: method === 'CANCEL' ? 'interview-cancelled.ics' : 'interview.ics',
    content: ics,
    contentType: `text/calendar; method=${method}; charset=UTF-8`,
  };
  const when = inviteWhen(ctx.interview.scheduledFor);
  const where = ctx.interview.location ? `\nWhere: ${ctx.interview.location}` : '';
  const length = `${ctx.interview.durationMinutes} minutes`;
  const verb = method === 'CANCEL' ? 'cancelled' : opts.rescheduled ? 'moved' : null;

  const mail = (to: string, subject: string, body: string[]) =>
    void send({
      channel: 'EMAIL',
      category: 'recruiting_interview',
      recipient: { userId: null, phone: null, email: to },
      subject,
      body: body.join('\n'),
      attachments: [attachment],
    }).catch(() => {
      /* fire-and-forget — the interview is already saved */
    });

  const toCandidate = opts.only !== 'interviewer';
  if (toCandidate) {
    mail(
      ctx.candidate.email,
      verb === 'cancelled'
        ? 'Your interview with Alto has been cancelled'
        : verb === 'moved'
          ? `Your interview with Alto has moved: ${when}`
          : `Your interview with Alto: ${when}`,
      [
        `Hi ${ctx.candidate.name.split(' ')[0]},`,
        '',
        verb === 'cancelled'
          ? `Your interview on ${when} has been cancelled. Your recruiter will be in touch.`
          : `${verb === 'moved' ? 'Your interview has a new time' : 'You have an interview with Alto'}${ctx.candidate.position ? ` for ${ctx.candidate.position}` : ''}.`,
        ...(verb === 'cancelled' ? [] : ['', `When: ${when} (${length})${where}`, '', 'The attached invite adds it to your calendar.']),
        '',
        `Questions? Reply to this email or contact ${ctx.organizer.name} at ${ctx.organizer.email}.`,
      ],
    );
  }
  if (ctx.interviewer) {
    mail(
      ctx.interviewer.email,
      `${verb === 'cancelled' ? 'Cancelled: ' : verb === 'moved' ? 'Moved: ' : ''}Interview with ${ctx.candidate.name} — ${when}`,
      [
        verb === 'cancelled'
          ? `The interview with ${ctx.candidate.name} on ${when} has been cancelled.`
          : `You're interviewing ${ctx.candidate.name}${ctx.candidate.position ? ` for ${ctx.candidate.position}` : ''}.`,
        ...(verb === 'cancelled' ? [] : ['', `When: ${when} (${length})${where}`, '', 'Score it in Alto People afterwards — the candidate\'s drawer has the kit.']),
      ],
    );
  }
  return { candidate: toCandidate, interviewer: Boolean(ctx.interviewer) };
}
