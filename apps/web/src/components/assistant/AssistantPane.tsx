import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { ArrowUp, Check, Sparkles, X } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAssistant } from '@/lib/assistantContext';
import { askHugo, decideAssistantAction, handoffToPerson, type ActionResult, type AssistantActionCard, type AssistantTable, type AssistantTurn, type HugoAnswer } from '@/lib/hugoApi';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Input';
import { cn } from '@/lib/cn';

/**
 * The assistant's pane: a column at the right that stays open while the
 * person works, with one conversation that survives moving between pages
 * (and a reload — it is kept in this tab's session storage, per account).
 * Below md it is the full screen. Every question carries the page the
 * person is on and the last turns, so an answer can say "this person".
 *
 * It can not act. A hand-off to a person is offered as a button under the
 * answer and sent only when the person taps it.
 */

interface Turn {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  linkUrl?: string | null;
  handoff?: { summary: string; who: string | null } | null;
  handoffSent?: boolean;
  /** Actions the assistant set up; each runs only when the person confirms it. */
  actions?: AssistantActionCard[];
  /** What happened to each action, by id. */
  results?: Record<string, ActionResult>;
  tables?: AssistantTable[];
}

const KEY = (userId: string) => `alto:assistant:thread:${userId}`;
const MAX_TURNS = 40;

function readThread(userId: string): Turn[] {
  try {
    const raw = window.sessionStorage.getItem(KEY(userId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Turn[]) : [];
  } catch {
    return [];
  }
}

function writeThread(userId: string, turns: Turn[]): void {
  try {
    window.sessionStorage.setItem(KEY(userId), JSON.stringify(turns.slice(-MAX_TURNS)));
  } catch {
    /* session storage is a convenience */
  }
}

export function AssistantPane() {
  const { user } = useAuth();
  const { available, me, open, setOpen, takeQueued, page } = useAssistant();
  const userId = user?.id ?? '';
  const [turns, setTurns] = useState<Turn[]>(() => (userId ? readThread(userId) : []));
  const [text, setText] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (userId) writeThread(userId, turns);
  }, [userId, turns]);

  const ask = useMutation({
    mutationFn: (q: string) => {
      const history: AssistantTurn[] = turns.slice(-10).map((t) => ({ role: t.role, text: t.text }));
      return askHugo(q, { page, history });
    },
    onMutate: (q) => {
      setTurns((t) => [...t, { id: `${Date.now()}-u`, role: 'user', text: q }]);
      setText('');
    },
    onSuccess: (a: HugoAnswer) => {
      setTurns((t) => [...t, { id: `${Date.now()}-a`, role: 'assistant', text: a.reply, linkUrl: a.linkUrl, handoff: a.handoff ?? null, actions: a.actions ?? [], tables: a.tables ?? [] }]);
    },
    onError: (err) => {
      const msg = err instanceof ApiError ? err.message : "I couldn't answer that just now. Try again in a moment.";
      setTurns((t) => [...t, { id: `${Date.now()}-e`, role: 'assistant', text: msg }]);
    },
  });

  const handoff = useMutation({
    mutationFn: (summary: string) => handoffToPerson(summary),
    onSuccess: (r, _summary, _ctx) => {
      setTurns((t) => t.map((x) => (x.handoff && !x.handoffSent ? { ...x, handoffSent: true } : x)).concat({ id: `${Date.now()}-h`, role: 'assistant', text: r.reply, linkUrl: r.linkUrl }));
    },
  });

  const decide = useMutation({
    mutationFn: ({ card, decision }: { turnId: string; card: AssistantActionCard; decision: 'confirm' | 'cancel' }) => decideAssistantAction(card.token, decision),
    onSuccess: (r, v) => setTurns((t) => t.map((x) => (x.id === v.turnId ? { ...x, results: { ...(x.results ?? {}), [v.card.id]: r } } : x))),
    onError: (err, v) => {
      const message = err instanceof ApiError ? err.message : 'That didn’t go through. Try again.';
      setTurns((t) => t.map((x) => (x.id === v.turnId ? { ...x, results: { ...(x.results ?? {}), [v.card.id]: { status: 'failed', title: v.card.title, message, linkUrl: null } } } : x)));
    },
  });

  const send = (q: string) => {
    const trimmed = q.trim();
    if (!trimmed || ask.isPending) return;
    ask.mutate(trimmed);
  };

  // A question handed in from a seat, the palette or a chip.
  useEffect(() => {
    if (!open) return;
    const q = takeQueued();
    if (q) send(q);
    else inputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    listRef.current?.scrollTo?.({ top: listRef.current.scrollHeight });
  }, [turns, ask.isPending]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  if (!available || !open || !me) return null;
  const name = me.name;

  return (
    <aside
      role="complementary"
      aria-label={`${name}, the assistant`}
      data-testid="assistant-pane"
      className={cn(
        'fixed inset-0 z-40 flex flex-col bg-surface text-ink',
        'md:static md:inset-auto md:z-auto md:w-[22rem] lg:w-[24rem] md:shrink-0 md:border-l md:border-line',
      )}
    >
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4">
        <span className="grid h-8 w-8 place-items-center rounded-full bg-accent-fill/15 text-accent" aria-hidden="true">
          <Sparkles className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate text-sm font-medium">{name}</div>
          <div className="truncate text-2xs text-ink-muted">AI assistant · answers from your records · acts only when you confirm</div>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={() => setOpen(false)} aria-label="Close the assistant">
          <X className="h-4 w-4" aria-hidden="true" />
        </Button>
      </header>

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3" aria-live="polite">
        {turns.length === 0 && (
          <div className="space-y-3">
            <p className="text-sm text-ink-muted">{me.intro}</p>
            {page.record && (
              <p className="text-xs2 text-ink-muted">
                You&rsquo;re on {page.record.name}&rsquo;s record — ask about them as &ldquo;this {page.record.type}&rdquo;.
              </p>
            )}
            {me.can.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {me.can.map((c) => (
                  <Button key={c.key} size="sm" variant="secondary" onClick={() => send(c.example)} disabled={ask.isPending}>
                    {c.example}
                  </Button>
                ))}
              </div>
            )}
          </div>
        )}
        <ol className="space-y-3">
          {turns.map((t) => (
            <li key={t.id} className={cn('flex', t.role === 'user' ? 'justify-end' : 'justify-start')}>
              <div
                className={cn(
                  'max-w-[88%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed',
                  t.role === 'user' ? 'rounded-br-md bg-accent-fill/15 text-ink' : 'rounded-bl-md bg-surface-raised text-ink',
                )}
              >
                <p className="whitespace-pre-wrap">{t.text}</p>
                {t.linkUrl && (
                  <Button asChild size="sm" variant="link" className="mt-1 px-0">
                    <Link to={t.linkUrl} onClick={() => window.matchMedia('(max-width: 767px)').matches && setOpen(false)}>
                      Open
                    </Link>
                  </Button>
                )}
                {(t.tables ?? []).map((tb) => (
                  <AnswerTable key={tb.linkUrl} table={tb} onNavigate={() => window.matchMedia('(max-width: 767px)').matches && setOpen(false)} />
                ))}
                {(t.actions ?? []).map((card) => (
                  <ActionCard
                    key={card.id}
                    card={card}
                    result={t.results?.[card.id] ?? null}
                    busy={decide.isPending && decide.variables?.card.id === card.id}
                    onDecide={(decision) => decide.mutate({ turnId: t.id, card, decision })}
                    onNavigate={() => window.matchMedia('(max-width: 767px)').matches && setOpen(false)}
                  />
                ))}
                {t.handoff && !t.handoffSent && (
                  <div className="mt-2">
                    <Button size="sm" variant="outline" loading={handoff.isPending} onClick={() => handoff.mutate(t.handoff!.summary)}>
                      Send to {t.handoff.who ?? 'my supervisor'}
                    </Button>
                  </div>
                )}
              </div>
            </li>
          ))}
          {ask.isPending && (
            <li className="flex justify-start">
              <div className="rounded-2xl rounded-bl-md bg-surface-raised px-3.5 py-2 text-sm text-ink-muted">
                <span className="sr-only">{name} is thinking</span>
                <span aria-hidden="true">…</span>
              </div>
            </li>
          )}
        </ol>
      </div>

      <form
        className="shrink-0 border-t border-line p-3"
        onSubmit={(e) => {
          e.preventDefault();
          send(text);
        }}
      >
        <label htmlFor="assistant-ask" className="sr-only">
          Ask {name}
        </label>
        <div className="flex items-end gap-2">
          <Textarea
            ref={inputRef}
            id="assistant-ask"
            value={text}
            rows={1}
            maxLength={500}
            placeholder={`Ask ${name}`}
            className="min-h-11 max-h-40 flex-1 resize-none"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send(text);
              }
            }}
          />
          <Button type="submit" size="icon" aria-label="Send" disabled={!text.trim() || ask.isPending}>
            <ArrowUp className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
        {turns.length > 0 && (
          <button
            type="button"
            className="mt-2 text-2xs text-ink-muted underline-offset-2 hover:underline"
            onClick={() => setTurns([])}
          >
            Start over
          </button>
        )}
      </form>
    </aside>
  );
}

/**
 * One proposed action: what will happen, to whom, and the person's choice.
 * Nothing runs until they tap the first button; the result replaces the
 * buttons in place, calmly.
 */
function ActionCard({
  card,
  result,
  busy,
  onDecide,
  onNavigate,
}: {
  card: AssistantActionCard;
  result: ActionResult | null;
  busy: boolean;
  onDecide: (d: 'confirm' | 'cancel') => void;
  onNavigate: () => void;
}) {
  const expired = !result && new Date(card.expiresAt).getTime() < Date.now();
  return (
    <div className="mt-2 rounded-xl border border-line bg-surface p-3" role="group" aria-label={`Proposed: ${card.title}`}>
      <div className="text-sm font-medium text-ink">{card.title}</div>
      {card.detail && <div className="mt-0.5 text-xs text-ink-muted">{card.detail}</div>}
      {result ? (
        <div className={cn('mt-2 text-sm', result.status === 'failed' ? 'text-alert' : 'text-ink-muted')} role="status">
          {result.status === 'done' && <Check className="mr-1 inline h-3.5 w-3.5 align-[-2px] text-success" aria-hidden="true" />}
          {result.message}
          {result.linkUrl && (
            <Button asChild size="sm" variant="link" className="ml-1 h-auto px-0">
              <Link to={result.linkUrl} onClick={onNavigate}>
                Open
              </Link>
            </Button>
          )}
        </div>
      ) : expired ? (
        <div className="mt-2 text-xs text-ink-muted">This expired — ask again and I’ll set it up fresh.</div>
      ) : (
        <div className="mt-2.5 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => onDecide('confirm')} loading={busy}>
            {card.confirmLabel}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onDecide('cancel')} disabled={busy}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}

/** A numbers answer: the first rows, and the report builder one tap away. */
function AnswerTable({ table, onNavigate }: { table: AssistantTable; onNavigate: () => void }) {
  const cols = table.columns.slice(0, 5);
  const rows = table.rows.slice(0, 8);
  return (
    <div className="mt-2 rounded-xl border border-line bg-surface p-3">
      <div className="text-sm font-medium text-ink">{table.title}</div>
      {rows.length === 0 ? (
        <div className="mt-1 text-xs text-ink-muted">No rows match.</div>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">{table.title}</caption>
            <thead>
              <tr className="text-ink-muted">
                {cols.map((c) => (
                  <th key={c} scope="col" className="pb-1 pr-3 font-medium">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="text-ink">
              {rows.map((r, i) => (
                <tr key={i} className="border-t border-line/60">
                  {cols.map((c) => (
                    <td key={c} className="py-1 pr-3 tabular-nums">
                      {String(r[c] ?? '—')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Button asChild size="sm" variant="link" className="mt-1 h-auto px-0">
        <Link to={table.linkUrl} onClick={onNavigate}>
          Open in the report builder
        </Link>
      </Button>
    </div>
  );
}
