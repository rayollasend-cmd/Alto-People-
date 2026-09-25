import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  FileSignature,
  MessageSquare,
  Pencil,
  RotateCcw,
  Star,
  UserPlus,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import type { Candidate, CandidateEvent } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { fmtDateTime, fmtRelativeDate } from '@/lib/format';
import {
  addCandidateNote,
  listCandidateEvents,
  updateCandidate,
} from '@/lib/recruitingApi';
import {
  createInterview,
  listInterviewKits,
  scoreInterview,
  type InterviewKit,
  type InterviewRecord,
} from '@/lib/recruiting90Api';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ErrorBanner,
  Field,
  Input,
  Select,
  SkeletonRows,
  Textarea,
} from '@/components/ui';
import {
  CANDIDATE_SOURCES,
  RATING_OPTIONS,
  SOURCE_LABEL,
  STAGE_LABEL,
} from './recruitingLabels';

/**
 * The working parts of a candidate's record — editing them, scheduling and
 * scoring their interviews, and their timeline with notes.
 *
 * All of this existed in the API with no screen: a recruiter could see an
 * interview slot was empty but not fill it, could not fix a misspelled
 * name, and had one overwritable notes field instead of a history.
 */

function why(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/* ===== Edit =============================================================== */

export function EditCandidateDialog({
  candidate,
  open,
  onOpenChange,
  onSaved,
}: {
  candidate: Candidate;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [firstName, setFirstName] = useState(candidate.firstName);
  const [lastName, setLastName] = useState(candidate.lastName);
  const [phone, setPhone] = useState(candidate.phone ?? '');
  const [position, setPosition] = useState(candidate.position ?? '');
  const [source, setSource] = useState(candidate.source ?? '');
  const [notes, setNotes] = useState(candidate.notes ?? '');
  const [saving, setSaving] = useState(false);

  // Re-seed from the record each time it opens, so a cancelled edit or a
  // change made elsewhere never lingers in the form.
  useEffect(() => {
    if (!open) return;
    setFirstName(candidate.firstName);
    setLastName(candidate.lastName);
    setPhone(candidate.phone ?? '');
    setPosition(candidate.position ?? '');
    setSource(candidate.source ?? '');
    setNotes(candidate.notes ?? '');
  }, [open, candidate]);

  const dirty =
    firstName !== candidate.firstName ||
    lastName !== candidate.lastName ||
    phone !== (candidate.phone ?? '') ||
    position !== (candidate.position ?? '') ||
    source !== (candidate.source ?? '') ||
    notes !== (candidate.notes ?? '');

  const save = async () => {
    if (!firstName.trim() || !lastName.trim()) {
      toast.error('First and last name are required.');
      return;
    }
    setSaving(true);
    try {
      await updateCandidate(candidate.id, {
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        phone: phone.trim() || null,
        position: position.trim() || null,
        source: source || null,
        notes: notes.trim() || null,
      });
      toast.success('Candidate updated.');
      onSaved();
      onOpenChange(false);
    } catch (err) {
      toast.error(why(err, 'Could not save the candidate.'));
    } finally {
      setSaving(false);
    }
  };

  // A stored source the picker doesn't know (an old free-text value) stays
  // selectable rather than being silently cleared on save.
  const sources: string[] = [...CANDIDATE_SOURCES];
  if (candidate.source && !sources.includes(candidate.source)) sources.push(candidate.source);

  return (
    <Dialog open={open} onOpenChange={onOpenChange} confirmDiscard={dirty}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit candidate</DialogTitle>
          <DialogDescription>
            {candidate.email} — the email is how the careers page and onboarding recognise them, so it
            can't be changed here.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="First name" required>
            {(p) => <Input {...p} value={firstName} onChange={(e) => setFirstName(e.target.value)} />}
          </Field>
          <Field label="Last name" required>
            {(p) => <Input {...p} value={lastName} onChange={(e) => setLastName(e.target.value)} />}
          </Field>
          <Field label="Phone">
            {(p) => <Input {...p} type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />}
          </Field>
          <Field label="Position">
            {(p) => <Input {...p} value={position} onChange={(e) => setPosition(e.target.value)} />}
          </Field>
          <Field label="Source" className="sm:col-span-2">
            {(p) => (
              <Select {...p} value={source} onChange={(e) => setSource(e.target.value)}>
                <option value="">—</option>
                {sources.map((s) => (
                  <option key={s} value={s}>
                    {SOURCE_LABEL[s] ?? s}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field
            label="About"
            hint="The standing summary. Day-to-day updates belong in a note on the timeline."
            className="sm:col-span-2"
          >
            {(p) => (
              <Textarea {...p} rows={3} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />
            )}
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void save()} loading={saving} disabled={saving || !dirty}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ===== Schedule an interview ============================================= */

/** Tomorrow at 10:00, local — the default slot, as "YYYY-MM-DDTHH:mm". */
function defaultSlot(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T10:00`;
}

export function ScheduleInterviewDialog({
  candidate,
  open,
  onOpenChange,
  onScheduled,
}: {
  candidate: Candidate;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onScheduled: () => void;
}) {
  const { user } = useAuth();
  const [when, setWhen] = useState(defaultSlot);
  const [kitId, setKitId] = useState('');
  const [mine, setMine] = useState(true);
  const [saving, setSaving] = useState(false);
  const kitsQuery = useQuery({
    queryKey: ['recruiting', 'interview-kits'],
    queryFn: listInterviewKits,
    enabled: open,
    staleTime: 5 * 60_000,
  });
  // A failed kit load still lets them schedule — just without a kit.
  const kits: InterviewKit[] | null = kitsQuery.isError ? [] : (kitsQuery.data?.kits ?? null);

  useEffect(() => {
    if (!open) return;
    setWhen(defaultSlot());
    setMine(true);
  }, [open]);

  const schedule = async () => {
    const at = new Date(when);
    if (!when || Number.isNaN(at.getTime())) {
      toast.error('Pick a date and time.');
      return;
    }
    setSaving(true);
    try {
      await createInterview({
        candidateId: candidate.id,
        scheduledFor: at.toISOString(),
        kitId: kitId || null,
        interviewerUserId: mine && user ? user.id : null,
      });
      toast.success(`Interview scheduled for ${fmtDateTime(at)}.`);
      onScheduled();
      onOpenChange(false);
    } catch (err) {
      toast.error(why(err, 'Could not schedule the interview.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Schedule an interview with {candidate.firstName} {candidate.lastName}
          </DialogTitle>
          <DialogDescription>
            It shows on their timeline and on your dashboard the day it happens.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="When" required>
            {(p) => (
              <Input {...p} type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
            )}
          </Field>
          <Field
            label="Interview kit"
            hint={kits?.length === 0 ? 'No kits yet — build one under Interviewing & offers.' : 'The questions to ask, scored after.'}
          >
            {(p) => (
              <Select {...p} value={kitId} onChange={(e) => setKitId(e.target.value)} disabled={!kits?.length}>
                <option value="">No kit</option>
                {kits?.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <label className="flex items-center gap-2 text-sm text-white coarse:min-h-11">
            <input
              type="checkbox"
              checked={mine}
              onChange={(e) => setMine(e.target.checked)}
              className="h-4 w-4 accent-gold"
            />
            I'm doing this interview
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void schedule()} loading={saving} disabled={saving}>
            <CalendarClock className="h-4 w-4" />
            Schedule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ===== Score an interview ================================================= */

/**
 * Rendered all the time and opened by `interview` — never mounted already
 * open. A dialog mounted open parks its Back-button history entry in the
 * same tick as another overlay's cleanup, and closing it then walked Back
 * one entry too far: saving a scorecard closed the whole candidate drawer.
 */
export function ScoreInterviewDialog({
  interview,
  kit,
  onOpenChange,
  onScored,
}: {
  /** The interview being scored; null keeps the dialog closed. */
  interview: InterviewRecord | null;
  /** The kit's questions to answer, when the interview used one. */
  kit: InterviewKit | null;
  onOpenChange: (open: boolean) => void;
  onScored: () => void;
}) {
  const open = interview !== null;
  const questions = kit?.questions ?? [];
  const [answers, setAnswers] = useState<string[]>(() => questions.map(() => ''));
  const [summary, setSummary] = useState('');
  const [rating, setRating] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setAnswers(questions.map(() => ''));
    setSummary('');
    setRating(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, interview?.id]);

  const dirty = rating !== null || summary.trim() !== '' || answers.some((a) => a.trim());

  const save = async () => {
    if (!interview) return;
    if (rating === null) {
      toast.error('Pick a recommendation.');
      return;
    }
    setSaving(true);
    try {
      await scoreInterview(interview.id, {
        rating,
        scorecard: {
          answers: questions.map((q, i) => ({ prompt: q.prompt, notes: answers[i]?.trim() ?? '' })),
          summary: summary.trim(),
        },
      });
      toast.success('Scorecard saved.');
      onScored();
      onOpenChange(false);
    } catch (err) {
      toast.error(why(err, 'Could not save the scorecard.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} confirmDiscard={dirty}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Score the interview</DialogTitle>
          <DialogDescription>
            {interview?.candidateName} · {interview ? fmtDateTime(interview.scheduledFor) : ''}
            {kit ? ` · ${kit.name}` : ''}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {questions.map((q, i) => (
            <Field key={i} label={q.prompt} hint={q.hint ?? undefined}>
              {(p) => (
                <Textarea
                  {...p}
                  rows={2}
                  value={answers[i] ?? ''}
                  onChange={(e) =>
                    setAnswers((prev) => prev.map((a, j) => (j === i ? e.target.value : a)))
                  }
                />
              )}
            </Field>
          ))}
          <Field label="Overall notes">
            {(p) => (
              <Textarea {...p} rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} />
            )}
          </Field>
          <fieldset>
            <legend className="mb-1.5 text-sm text-silver">
              Recommendation <span className="text-alert">*</span>
            </legend>
            <div role="radiogroup" aria-label="Recommendation" className="flex flex-wrap gap-2">
              {RATING_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  role="radio"
                  aria-checked={rating === o.value}
                  onClick={() => setRating(o.value)}
                  className={cn(
                    'rounded-full border px-3 py-1.5 text-sm transition-colors coarse:min-h-11',
                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
                    rating === o.value
                      ? o.value > 0
                        ? 'border-success bg-success/10 text-success'
                        : o.value < 0
                          ? 'border-alert bg-alert/10 text-alert'
                          : 'border-silver bg-navy-secondary text-white'
                      : 'border-navy-secondary text-silver hover:border-silver/40 hover:text-white',
                  )}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </fieldset>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void save()} loading={saving} disabled={saving}>
            Save scorecard
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ===== The timeline ======================================================= */

const EVENT_ICON: Record<CandidateEvent['kind'], LucideIcon> = {
  CREATED: UserPlus,
  APPLIED_AGAIN: RotateCcw,
  EDITED: Pencil,
  STAGE_CHANGED: ArrowRight,
  NOTE: MessageSquare,
  INTERVIEW_SCHEDULED: CalendarClock,
  INTERVIEW_SCORED: Star,
  INTERVIEW_CANCELLED: XCircle,
  OFFER_CREATED: FileSignature,
  OFFER_SENT: FileSignature,
  OFFER_DECIDED: FileSignature,
  HIRED: CheckCircle2,
};

/**
 * An interview event's instant, in the viewer's own time. Only a real ISO
 * timestamp is reformatted — Date.parse also "understands" free text like
 * "Sat, Sep 26, 1:00 PM" by quietly assuming the year 2001.
 */
function at(body: string | null): string {
  return body && /^\d{4}-\d{2}-\d{2}T/.test(body) ? fmtDateTime(body) : (body ?? '');
}

/** One line saying what happened. Notes and reasons render beneath it. */
function eventText(e: CandidateEvent): string {
  switch (e.kind) {
    case 'CREATED':
      return e.body?.startsWith('Applied on the careers page')
        ? e.body
        : `Added to the pipeline${e.body ? ` · ${SOURCE_LABEL[e.body] ?? e.body}` : ''}`;
    case 'APPLIED_AGAIN':
      return `Applied again on the careers page: ${e.body ?? ''}`;
    case 'EDITED':
      return e.body ?? 'Details updated';
    case 'STAGE_CHANGED':
      return `${e.fromStage ? STAGE_LABEL[e.fromStage] : '—'} → ${e.toStage ? STAGE_LABEL[e.toStage] : '—'}`;
    case 'NOTE':
      return 'Note';
    case 'INTERVIEW_SCHEDULED':
      return `Interview scheduled for ${at(e.body)}`;
    case 'INTERVIEW_SCORED':
      return `Interview scored · ${e.body ?? ''}`;
    case 'INTERVIEW_CANCELLED':
      return `Interview cancelled (${at(e.body)})`;
    case 'OFFER_CREATED':
      return `Offer drafted: ${e.body ?? ''}`;
    case 'OFFER_SENT':
      return `Offer sent: ${e.body ?? ''}`;
    case 'OFFER_DECIDED':
      return e.body ? `Offer ${e.body.charAt(0).toLowerCase()}${e.body.slice(1)}` : 'Offer decided';
    case 'HIRED':
      return 'Hired — invited to onboarding';
  }
}

/**
 * Who did it. No actor means the applicant themselves on the careers page —
 * or an entry backfilled from before the timeline existed, which has no
 * one to name, so it names no one.
 */
function actorOf(e: CandidateEvent): string | null {
  if (e.actorName) return e.actorName;
  if (e.kind === 'APPLIED_AGAIN') return 'Careers page';
  if (e.kind === 'CREATED' && e.body?.startsWith('Applied on the careers page')) return 'Careers page';
  return null;
}

/** The free text that belongs under the line: a note, or a stage's reason. */
function eventDetail(e: CandidateEvent): string | null {
  if (e.kind === 'NOTE') return e.body;
  if (e.kind === 'STAGE_CHANGED') return e.body;
  return null;
}

export function CandidateTimeline({
  candidateId,
  canManage,
  refreshKey,
}: {
  candidateId: string;
  canManage: boolean;
  /** Changes whenever something elsewhere in the drawer wrote an event. */
  refreshKey: string;
}) {
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  // refreshKey is part of the key: a write elsewhere in the drawer is a
  // new timeline to read. The previous one stays up meanwhile, so the list
  // doesn't blink to a skeleton on every change.
  const eventsQuery = useQuery({
    queryKey: ['recruiting', 'candidate', candidateId, 'events', refreshKey],
    queryFn: () => listCandidateEvents(candidateId),
    placeholderData: keepPreviousData,
  });
  const events: CandidateEvent[] | null = eventsQuery.data?.events ?? null;
  const error = eventsQuery.error ? why(eventsQuery.error, 'Could not load the timeline.') : null;

  const addNote = async () => {
    if (!note.trim()) return;
    setSaving(true);
    try {
      await addCandidateNote(candidateId, note.trim());
      setNote('');
      await eventsQuery.refetch();
    } catch (err) {
      toast.error(why(err, 'Could not save the note.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      {canManage && (
        <div className="space-y-2">
          <Textarea
            aria-label="Add a note"
            placeholder="Add a note — a call, an availability change, what they said…"
            rows={2}
            maxLength={4000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void addNote();
            }}
          />
          <div className="flex justify-end">
            <Button size="sm" onClick={() => void addNote()} loading={saving} disabled={saving || !note.trim()}>
              <MessageSquare className="h-3.5 w-3.5" />
              Add note
            </Button>
          </div>
        </div>
      )}
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {events === null && !error ? (
        <SkeletonRows count={3} />
      ) : events && events.length === 0 ? (
        <p className="text-sm text-silver/70">Nothing recorded yet.</p>
      ) : (
        <ol className="space-y-3" aria-label="Timeline">
          {events?.map((e) => {
            const Icon = EVENT_ICON[e.kind];
            const detail = eventDetail(e);
            return (
              <li key={e.id} className="flex gap-3">
                <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-navy-secondary text-silver">
                  <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-white">{eventText(e)}</div>
                  {detail && (
                    <p className="mt-1 whitespace-pre-wrap rounded-md bg-navy-secondary/40 px-2.5 py-1.5 text-sm text-silver">
                      {detail}
                    </p>
                  )}
                  <div className="mt-0.5 text-xs2 text-silver/70">
                    {actorOf(e) && <>{actorOf(e)} · </>}
                    <time dateTime={e.createdAt} title={fmtDateTime(e.createdAt)}>{fmtRelativeDate(e.createdAt)}</time>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
