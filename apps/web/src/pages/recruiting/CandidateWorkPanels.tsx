import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { CalendarClock, MessageSquare } from 'lucide-react';
import { toast } from 'sonner';
import {
  InterviewScorecardSchema,
  SCORECARD_RATINGS,
  type Candidate,
  type CandidateEvent,
  type InterviewScorecard,
} from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { fmtDateTime, fmtRelativeDate } from '@/lib/format';
import {
  addCandidateNote,
  listCandidateEvents,
  submitToClient,
  updateCandidate,
} from '@/lib/recruitingApi';
import { listClientLocations } from '@/lib/clientsApi';
import { useClients } from '@/lib/useClients';
import {
  createInterview,
  listInterviewKits,
  listJobPostings,
  scoreInterview,
  updateInterview,
  type InterviewKit,
  type InterviewRecord,
} from '@/lib/recruiting90Api';
import {
  Badge,
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
import { EVENT_ICON, actorOf, eventDetail, eventText } from './candidateEventText';
import {
  CANDIDATE_SOURCES,
  RATING_OPTIONS,
  SOURCE_LABEL,
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
  const [jobPostingId, setJobPostingId] = useState(candidate.jobPostingId ?? '');
  const [saving, setSaving] = useState(false);
  // The posting a hire fills — for time to fill and each client's fill rate.
  const postings = useQuery({
    queryKey: ['recruiting', 'postings'],
    queryFn: () => listJobPostings(),
    enabled: open,
    staleTime: 60_000,
  });

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
    setJobPostingId(candidate.jobPostingId ?? '');
  }, [open, candidate]);

  const dirty =
    firstName !== candidate.firstName ||
    lastName !== candidate.lastName ||
    phone !== (candidate.phone ?? '') ||
    position !== (candidate.position ?? '') ||
    source !== (candidate.source ?? '') ||
    notes !== (candidate.notes ?? '') ||
    jobPostingId !== (candidate.jobPostingId ?? '');

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
        jobPostingId: jobPostingId || null,
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
            label="Job posting"
            hint="The opening they'd fill — hiring them counts toward its fill rate."
            className="sm:col-span-2"
          >
            {(p) => (
              <Select {...p} value={jobPostingId} onChange={(e) => setJobPostingId(e.target.value)}>
                <option value="">None</option>
                {(postings.data?.postings ?? [])
                  .filter((po) => po.status === 'OPEN' || po.id === jobPostingId)
                  .map((po) => (
                    <option key={po.id} value={po.id}>
                      {po.title}
                      {po.clientName ? ` · ${po.clientName}` : ''}
                      {` · ${Math.min(po.hired, po.openings)} of ${po.openings} filled`}
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

/* ===== Schedule (or move) an interview ==================================== */

/** Tomorrow at 10:00, local — the default slot, as "YYYY-MM-DDTHH:mm". */
function defaultSlot(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T10:00`;
}

/** An ISO instant as the datetime-local input's "YYYY-MM-DDTHH:mm", local. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const LENGTHS = [15, 30, 45, 60, 90];

/**
 * Schedule an interview — or, given one, move it. Either way the candidate
 * and the interviewer get a calendar invite by email (a moved one replaces
 * the invite they already have), unless the recruiter says not to.
 */
export function ScheduleInterviewDialog({
  candidate,
  interview = null,
  open,
  onOpenChange,
  onScheduled,
}: {
  candidate: Candidate;
  /** Set to reschedule this interview instead of booking a new one. */
  interview?: InterviewRecord | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onScheduled: () => void;
}) {
  const { user } = useAuth();
  const moving = interview !== null;
  const [when, setWhen] = useState(defaultSlot);
  const [length, setLength] = useState(30);
  const [where, setWhere] = useState('');
  const [kitId, setKitId] = useState('');
  const [mine, setMine] = useState(true);
  const [notify, setNotify] = useState(true);
  const [saving, setSaving] = useState(false);
  const kitsQuery = useQuery({
    queryKey: ['recruiting', 'interview-kits'],
    queryFn: listInterviewKits,
    enabled: open && !moving,
    staleTime: 5 * 60_000,
  });
  // A failed kit load still lets them schedule — just without a kit.
  const kits: InterviewKit[] | null = kitsQuery.isError ? [] : (kitsQuery.data?.kits ?? null);

  useEffect(() => {
    if (!open) return;
    setWhen(interview ? toLocalInput(interview.scheduledFor) : defaultSlot());
    setLength(interview?.durationMinutes ?? 30);
    setWhere(interview?.location ?? '');
    setMine(true);
    setNotify(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, interview?.id]);

  const save = async () => {
    const at = new Date(when);
    if (!when || Number.isNaN(at.getTime())) {
      toast.error('Pick a date and time.');
      return;
    }
    setSaving(true);
    try {
      const res = interview
        ? await updateInterview(interview.id, {
            scheduledFor: at.toISOString(),
            durationMinutes: length,
            location: where.trim() || null,
            notify,
          })
        : await createInterview({
            candidateId: candidate.id,
            scheduledFor: at.toISOString(),
            durationMinutes: length,
            location: where.trim() || null,
            kitId: kitId || null,
            interviewerUserId: mine && user ? user.id : null,
            notify,
          });
      const who = [res.invited.candidate && candidate.firstName, res.invited.interviewer && 'the interviewer']
        .filter(Boolean)
        .join(' and ');
      toast.success(
        `Interview ${moving ? 'moved to' : 'scheduled for'} ${fmtDateTime(at)}.`,
        who ? { description: `Calendar invite emailed to ${who}.` } : undefined,
      );
      onScheduled();
      onOpenChange(false);
    } catch (err) {
      toast.error(why(err, moving ? 'Could not move the interview.' : 'Could not schedule the interview.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {moving ? 'Reschedule' : 'Schedule'} an interview with {candidate.firstName} {candidate.lastName}
          </DialogTitle>
          <DialogDescription>
            {moving
              ? 'The invite already in their calendars is replaced with the new time.'
              : 'It shows on their timeline and on your dashboard the day it happens.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
            <Field label="When" required>
              {(p) => <Input {...p} type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />}
            </Field>
            <Field label="Length">
              {(p) => (
                <Select {...p} value={String(length)} onChange={(e) => setLength(Number(e.target.value))}>
                  {LENGTHS.map((m) => (
                    <option key={m} value={m}>
                      {m} min
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          <Field label="Where" hint="A store and its address, a phone number, or a video link — it goes in the invite.">
            {(p) => (
              <Input
                {...p}
                value={where}
                maxLength={300}
                placeholder="Destin #1234, 15017 Emerald Coast Pkwy"
                onChange={(e) => setWhere(e.target.value)}
              />
            )}
          </Field>
          {!moving && (
            <>
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
                <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} className="h-4 w-4 accent-gold" />
                I'm doing this interview
              </label>
            </>
          )}
          <label className="flex items-center gap-2 text-sm text-white coarse:min-h-11">
            <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} className="h-4 w-4 accent-gold" />
            Email {candidate.firstName} and the interviewer a calendar invite
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void save()} loading={saving} disabled={saving}>
            <CalendarClock className="h-4 w-4" />
            {moving ? 'Move it' : 'Schedule'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ===== Score an interview ================================================= */

/** Rated chips for one scale — a radio group, however it looks. */
function RatingChips<T extends number>({
  label,
  options,
  value,
  onChange,
  tone,
}: {
  label: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T | null;
  onChange: (v: T) => void;
  tone: (v: T) => 'good' | 'bad' | 'neutral';
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">
      {options.map((o) => {
        const on = value === o.value;
        const t = tone(o.value);
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={cn(
              'rounded-full border px-3 py-1.5 text-sm transition-colors coarse:min-h-11',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
              on
                ? t === 'good'
                  ? 'border-success bg-success/10 text-success'
                  : t === 'bad'
                    ? 'border-alert bg-alert/10 text-alert'
                    : 'border-silver bg-navy-secondary text-white'
                : 'border-navy-secondary text-silver hover:border-silver/40 hover:text-white',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Rendered all the time and opened by `interview` — never mounted already
 * open. A dialog mounted open parks its Back-button history entry in the
 * same tick as another overlay's cleanup, and closing it then walked Back
 * one entry too far: saving a scorecard closed the whole candidate drawer.
 *
 * Structured: each of the kit's questions rated on one four-point scale,
 * with notes, then an overall recommendation. The same scale on every
 * scorecard is what lets several interviewers be read side by side.
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
  const [answers, setAnswers] = useState<Array<{ rating: number | null; notes: string }>>(() =>
    questions.map(() => ({ rating: null, notes: '' })),
  );
  const [summary, setSummary] = useState('');
  const [rating, setRating] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setAnswers(questions.map(() => ({ rating: null, notes: '' })));
    setSummary('');
    setRating(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, interview?.id]);

  const dirty =
    rating !== null || summary.trim() !== '' || answers.some((a) => a.rating !== null || a.notes.trim());
  const setAnswer = (i: number, patch: Partial<{ rating: number | null; notes: string }>) =>
    setAnswers((prev) => prev.map((a, j) => (j === i ? { ...a, ...patch } : a)));

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
          answers: questions.map((q, i) => ({
            prompt: q.prompt,
            rating: answers[i]?.rating ?? null,
            notes: answers[i]?.notes.trim() ?? '',
          })),
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
        <div className="space-y-5">
          {questions.map((q, i) => (
            <fieldset key={i} className="space-y-2">
              <legend className="text-sm text-white">{q.prompt}</legend>
              {q.hint && <p className="text-xs text-silver">{q.hint}</p>}
              <RatingChips
                label={q.prompt}
                options={SCORECARD_RATINGS}
                value={answers[i]?.rating ?? null}
                onChange={(v) => setAnswer(i, { rating: v })}
                tone={(v) => (v >= 3 ? 'good' : v <= 1 ? 'bad' : 'neutral')}
              />
              <Textarea
                aria-label={`Notes: ${q.prompt}`}
                rows={2}
                placeholder="What they said, what you saw"
                value={answers[i]?.notes ?? ''}
                onChange={(e) => setAnswer(i, { notes: e.target.value })}
              />
            </fieldset>
          ))}
          <Field label="Overall notes">
            {(p) => <Textarea {...p} rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} />}
          </Field>
          <fieldset>
            <legend className="mb-1.5 text-sm text-silver">
              Recommendation <span className="text-alert">*</span>
            </legend>
            <RatingChips
              label="Recommendation"
              options={RATING_OPTIONS}
              value={rating}
              onChange={setRating}
              tone={(v) => (v > 0 ? 'good' : v < 0 ? 'bad' : 'neutral')}
            />
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

/* ===== Scorecards, side by side =========================================== */

const RATING_WORD = Object.fromEntries(SCORECARD_RATINGS.map((r) => [r.value, r.label])) as Record<number, string>;

/** A stored scorecard, if it is the structured kind — older ones were free-form. */
function readScorecard(raw: unknown): InterviewScorecard | null {
  const parsed = InterviewScorecardSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Every interviewer's scorecard for this candidate, read together: how the
 * recommendations fall, and each question's average rating across everyone
 * who asked it. One interviewer's "Strong yes" reads differently next to
 * two "No"s — which is the point of asking more than one person.
 */
export function ScorecardSummary({ interviews }: { interviews: InterviewRecord[] }) {
  const scored = interviews.filter((i) => i.rating !== null);
  if (scored.length === 0) return null;

  const tally = RATING_OPTIONS.map((o) => ({
    ...o,
    count: scored.filter((i) => i.rating === o.value).length,
  })).filter((o) => o.count > 0);

  const byPrompt = new Map<string, number[]>();
  for (const i of scored) {
    for (const a of readScorecard(i.scorecard)?.answers ?? []) {
      if (a.rating === null) continue;
      byPrompt.set(a.prompt, [...(byPrompt.get(a.prompt) ?? []), a.rating]);
    }
  }

  return (
    <div className="space-y-3 rounded-md border border-navy-secondary bg-navy/60 p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-silver">
          {scored.length} scorecard{scored.length === 1 ? '' : 's'}:
        </span>
        {tally.map((t) => (
          <Badge key={t.value} variant={t.value > 0 ? 'success' : t.value < 0 ? 'destructive' : 'outline'}>
            {t.count} × {t.label}
          </Badge>
        ))}
      </div>
      {byPrompt.size > 0 && (
        <ul className="space-y-1.5" aria-label="Average rating by question">
          {[...byPrompt.entries()].map(([prompt, ratings]) => {
            const avg = ratings.reduce((n, r) => n + r, 0) / ratings.length;
            return (
              <li key={prompt} className="flex items-start justify-between gap-3 text-sm">
                <span className="min-w-0 text-silver">{prompt}</span>
                <span className="shrink-0 tabular-nums text-white" title={`${ratings.length} rating${ratings.length === 1 ? '' : 's'}`}>
                  {avg.toFixed(1)} / 4 · {RATING_WORD[Math.round(avg)]}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {scored.map((i) => {
        const card = readScorecard(i.scorecard);
        if (!card?.summary) return null;
        return (
          <p key={i.id} className="whitespace-pre-wrap text-sm text-silver">
            <span className="text-white">{i.interviewerEmail ?? 'Interviewer'}:</span> {card.summary}
          </p>
        );
      })}
    </div>
  );
}

/* ===== Put forward to a client =========================================== */

/**
 * Put the candidate in front of a client — optionally for one store — with
 * a pitch. The client's portal accounts get a Candidates page to approve
 * or pass, and their answer lands on this timeline. They see the name,
 * the position, this pitch and how Alto's interviewers recommended them;
 * never the candidate's contact details.
 */
export function SubmitToClientDialog({
  candidate,
  open,
  onOpenChange,
  onSubmitted,
}: {
  candidate: Candidate;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmitted: () => void;
}) {
  const { clients } = useClients({ enabled: open });
  const [clientId, setClientId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [pitch, setPitch] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setClientId('');
    setLocationId('');
    setPitch('');
  }, [open]);

  const stores = useQuery({
    queryKey: ['clients', clientId, 'locations'],
    queryFn: () => listClientLocations(clientId),
    enabled: open && Boolean(clientId),
    staleTime: 5 * 60_000,
  });
  const storeList = stores.data?.locations ?? [];

  const submit = async () => {
    if (!clientId) {
      toast.error('Pick a client.');
      return;
    }
    setBusy(true);
    try {
      const r = await submitToClient(candidate.id, {
        clientId,
        ...(locationId ? { locationId } : {}),
        ...(pitch.trim() ? { pitch: pitch.trim() } : {}),
      });
      toast.success(`Sent to ${r.clientName} to review — you'll hear when they answer.`);
      onSubmitted();
      onOpenChange(false);
    } catch (err) {
      toast.error(why(err, 'Could not send the candidate.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)} confirmDiscard={() => pitch.trim().length > 0}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Put {candidate.firstName} forward</DialogTitle>
          <DialogDescription>
            The client approves or passes from their portal. They see {candidate.firstName}&rsquo;s name, position,
            your pitch and the interview recommendations — not their email, phone or résumé.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Client" required>
            {(p) => (
              <Select
                {...p}
                value={clientId}
                onChange={(e) => {
                  setClientId(e.target.value);
                  setLocationId('');
                }}
              >
                <option value="">Pick a client…</option>
                {(clients ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Store" hint={storeList.length > 1 ? 'Leave as any store to ask the whole client.' : undefined}>
            {(p) => (
              <Select
                {...p}
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
                disabled={!clientId || storeList.length < 2}
              >
                <option value="">Any store</option>
                {storeList.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field
            label="Pitch"
            hint="Why them, in a few lines: experience, shifts they can work, how the interview went."
            className="sm:col-span-2"
          >
            {(p) => (
              <Textarea {...p} rows={4} maxLength={2000} value={pitch} onChange={(e) => setPitch(e.target.value)} />
            )}
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={busy} disabled={busy || !clientId}>
            Send to client
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ===== The timeline ======================================================= */

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
