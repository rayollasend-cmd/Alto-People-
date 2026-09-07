import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { MessageSquare, Send } from 'lucide-react';
import { ApiError, apiFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDateTime } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Input';

/**
 * The thread on the work itself — staff notes attached to an associate
 * record, with desk @mentions that ring the other building. The
 * question, the answer, and the decision live where the work lives;
 * six months later the "why" is still sitting on the record.
 *
 * Staff-only surface (the People page is view:org-gated), console voice.
 */

type Desk = 'FINANCE' | 'HR' | 'WORKFORCE';

interface WorkNoteRow {
  id: string;
  body: string;
  mentions: string[];
  createdAt: string;
  authorEmail: string | null;
  authorName: string | null;
  decisionDesk: string | null;
  decisionStatus: 'PENDING' | 'APPROVED' | 'DECLINED' | null;
  decisionNote: string | null;
  decidedAt: string | null;
  decidedByEmail: string | null;
}

const DESKS: Array<{ key: Desk; label: string }> = [
  { key: 'HR', label: 'HR' },
  { key: 'FINANCE', label: 'Finance' },
  { key: 'WORKFORCE', label: 'Workforce' },
];

const DESK_CHIP: Record<string, string> = {
  HR: 'bg-steel/20 text-silver',
  FINANCE: 'bg-gold/15 text-gold',
  WORKFORCE: 'bg-success/15 text-success',
};

/** Which desk this user answers for when ruling on a decision. */
function deskOf(role: string | undefined): Desk | null {
  if (role === 'FINANCE_ACCOUNTANT') return 'FINANCE';
  if (role === 'WORKFORCE_MANAGER') return 'WORKFORCE';
  if (role === 'HR_ADMINISTRATOR' || role === 'OPERATIONS_MANAGER') return 'HR';
  return null;
}

export function WorkThreadPanel({ associateId }: { associateId: string }) {
  const { user } = useAuth();
  const myDesk = deskOf(user?.role);
  const [notes, setNotes] = useState<WorkNoteRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [mentions, setMentions] = useState<Desk[]>([]);
  const [decisionDesk, setDecisionDesk] = useState<Desk | ''>('');
  const [busy, setBusy] = useState(false);
  // Which pending decision has its ruling composer open, and its note.
  const [deciding, setDeciding] = useState<string | null>(null);
  const [decisionText, setDecisionText] = useState('');

  const load = (soft = false) => {
    if (!soft) setNotes(null);
    setError(null);
    apiFetch<{ notes: WorkNoteRow[] }>(
      `/work-notes?subjectType=ASSOCIATE&subjectKey=${associateId}`,
    )
      .then((r) => setNotes(r.notes))
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : 'Could not load the thread.'),
      );
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [associateId]);

  const post = async () => {
    const text = body.trim();
    if (!text) return;
    setBusy(true);
    try {
      await apiFetch('/work-notes', {
        method: 'POST',
        body: {
          subjectType: 'ASSOCIATE',
          subjectKey: associateId,
          body: text,
          mentionDesks: mentions,
          ...(decisionDesk ? { decisionDesk } : {}),
        },
      });
      setBody('');
      setMentions([]);
      setDecisionDesk('');
      load(true);
      if (mentions.length > 0) {
        toast.success(
          `Posted — ${mentions.map((m) => DESKS.find((d) => d.key === m)?.label).join(' and ')} notified.`,
        );
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not post the note.');
    } finally {
      setBusy(false);
    }
  };

  const decide = async (noteId: string, approve: boolean) => {
    try {
      await apiFetch(`/work-notes/${noteId}/decide`, {
        method: 'POST',
        body: { approve, note: decisionText.trim() },
      });
      setDeciding(null);
      setDecisionText('');
      load(true);
      toast.success(approve ? 'Approved — receipt recorded.' : 'Declined — receipt recorded.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not record the ruling.');
    }
  };

  return (
    <div className="space-y-3">
      {error ? (
        <div className="rounded border border-alert/40 bg-alert/10 p-3 text-sm text-alert">
          {error}{' '}
          <button
            type="button"
            className="underline underline-offset-2"
            onClick={() => load()}
          >
            Retry
          </button>
        </div>
      ) : notes === null ? (
        <p className="text-sm text-silver/60">Loading the thread…</p>
      ) : notes.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-silver/70">
          <MessageSquare className="h-4 w-4 text-silver/40" aria-hidden="true" />
          No notes yet. Write the first one — mention a desk and it rings their
          bell with this record attached.
        </p>
      ) : (
        <ul className="space-y-3">
          {notes.map((n) => (
            <li key={n.id} className="rounded border border-navy-secondary p-3">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
                <span className="font-medium text-white">
                  {n.authorName ?? n.authorEmail ?? 'Someone'}
                </span>
                <span className="tabular-nums text-silver/50">
                  {fmtDateTime(n.createdAt)}
                </span>
                {n.mentions.map((m) => (
                  <span
                    key={m}
                    className={cn(
                      'rounded-full px-1.5 py-0.5 text-2xs font-medium uppercase tracking-wider',
                      DESK_CHIP[m] ?? 'bg-navy-secondary text-silver',
                    )}
                  >
                    @{m.toLowerCase()}
                  </span>
                ))}
              </div>
              <p className="mt-1.5 whitespace-pre-wrap text-sm text-silver">{n.body}</p>

              {/* Decisions with receipts. */}
              {n.decisionStatus === 'PENDING' && (
                <div className="mt-2 rounded border border-warning/30 bg-warning/5 p-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-medium text-warning">
                      Decision pending — {n.decisionDesk?.toLowerCase()} desk
                    </span>
                    {myDesk === n.decisionDesk && deciding !== n.id && (
                      <Button
                        size="xs"
                        variant="secondary"
                        onClick={() => {
                          setDeciding(n.id);
                          setDecisionText('');
                        }}
                      >
                        Rule on it
                      </Button>
                    )}
                  </div>
                  {deciding === n.id && (
                    <div className="mt-2 space-y-2">
                      <Textarea
                        value={decisionText}
                        onChange={(e) => setDecisionText(e.target.value)}
                        placeholder="The reasoning that becomes the receipt…"
                        rows={2}
                        maxLength={2000}
                      />
                      <div className="flex gap-2">
                        <Button
                          size="xs"
                          disabled={!decisionText.trim()}
                          onClick={() => void decide(n.id, true)}
                        >
                          Approve
                        </Button>
                        <Button
                          size="xs"
                          variant="destructive"
                          disabled={!decisionText.trim()}
                          onClick={() => void decide(n.id, false)}
                        >
                          Decline
                        </Button>
                        <Button size="xs" variant="ghost" onClick={() => setDeciding(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}
              {(n.decisionStatus === 'APPROVED' || n.decisionStatus === 'DECLINED') && (
                <div
                  className={cn(
                    'mt-2 rounded border p-2.5',
                    n.decisionStatus === 'APPROVED'
                      ? 'border-success/30 bg-success/5'
                      : 'border-alert/30 bg-alert/5',
                  )}
                >
                  <div
                    className={cn(
                      'text-2xs font-medium uppercase tracking-wider',
                      n.decisionStatus === 'APPROVED' ? 'text-success' : 'text-alert',
                    )}
                  >
                    {n.decisionStatus === 'APPROVED' ? 'Approved' : 'Declined'}
                    {n.decidedByEmail && ` — ${n.decidedByEmail}`}
                    {n.decidedAt && ` · ${fmtDateTime(n.decidedAt)}`}
                  </div>
                  {n.decisionNote && (
                    <p className="mt-1 whitespace-pre-wrap text-sm text-silver">
                      {n.decisionNote}
                    </p>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Composer — desk chips toggle who gets rung. */}
      <div className="space-y-2 rounded border border-navy-secondary p-3">
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Write to the record — the answer lives here, not in a phone call."
          rows={3}
          maxLength={4000}
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-2xs uppercase tracking-wider text-silver/60">
              Ring:
            </span>
            <Select
              size="sm"
              aria-label="Needs a decision from"
              value={decisionDesk}
              onChange={(e) => setDecisionDesk(e.target.value as Desk | '')}
              className="w-auto"
            >
              <option value="">No decision needed</option>
              {DESKS.map((d) => (
                <option key={d.key} value={d.key}>
                  Decision: {d.label}
                </option>
              ))}
            </Select>
            {DESKS.map((d) => {
              const on = mentions.includes(d.key);
              return (
                <button
                  key={d.key}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    setMentions((prev) =>
                      on ? prev.filter((m) => m !== d.key) : [...prev, d.key],
                    )
                  }
                  className={cn(
                    'rounded-full border px-2.5 py-1 text-xs transition-colors coarse:min-h-9 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/40',
                    on
                      ? 'border-gold/50 bg-gold/15 text-gold'
                      : 'border-navy-secondary bg-navy-secondary/40 text-silver hover:text-white',
                  )}
                >
                  @{d.label}
                </button>
              );
            })}
          </div>
          <Button size="sm" onClick={() => void post()} loading={busy} disabled={!body.trim()}>
            <Send className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            Post
          </Button>
        </div>
      </div>
    </div>
  );
}
