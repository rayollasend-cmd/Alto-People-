import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { ArrowUp, Sparkles, X } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAssistant } from '@/lib/assistantContext';
import { askHugo, handoffToPerson, type AssistantTurn, type HugoAnswer } from '@/lib/hugoApi';
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
      setTurns((t) => [...t, { id: `${Date.now()}-a`, role: 'assistant', text: a.reply, linkUrl: a.linkUrl, handoff: a.handoff ?? null }]);
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
          <div className="truncate text-2xs text-ink-muted">AI assistant · answers from your records · can&rsquo;t act for you</div>
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
