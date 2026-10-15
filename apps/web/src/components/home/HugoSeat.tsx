import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Sparkles } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { askHugo, getHugo, type HugoAnswer } from '@/lib/hugoApi';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';

/**
 * Hugo's seat on a home (design system §4.1): the same place on every
 * role's first screen. He offers only what is switched on for this
 * organization and this person (the server's registry), takes a question,
 * and answers in place. Switched off, or nothing to offer: renders
 * nothing, so the home never shows an empty assistant.
 */
export function HugoSeat({ className }: { className?: string }) {
  const me = useQuery({ queryKey: ['hugo', 'me'], queryFn: getHugo, staleTime: 60_000, retry: false });
  const [text, setText] = useState('');
  const [turn, setTurn] = useState<{ question: string; answer: HugoAnswer } | null>(null);
  const ask = useMutation({
    mutationFn: (q: string) => askHugo(q),
    onSuccess: (answer, question) => {
      setTurn({ question, answer });
      setText('');
    },
  });
  if (me.isLoading || me.error || !me.data || me.data.can.length === 0) return null;
  const send = (q: string) => {
    const t = q.trim();
    if (t && !ask.isPending) ask.mutate(t);
  };
  return (
    <Card className={className} data-testid="hugo-seat">
      <CardContent className="space-y-3 p-5">
        <div className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-full bg-accent-fill/15 text-accent" aria-hidden="true">
            <Sparkles className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <div className="text-base font-medium text-ink">{me.data.name}</div>
            <div className="truncate text-xs2 text-ink-muted">{me.data.intro}</div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {me.data.can.slice(0, 3).map((c) => (
            <Button key={c.key} size="sm" variant="secondary" onClick={() => send(c.example)} disabled={ask.isPending}>
              {c.example}
            </Button>
          ))}
        </div>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            send(text);
          }}
        >
          <label htmlFor="hugo-seat-ask" className="sr-only">
            Ask {me.data.name}
          </label>
          <Input id="hugo-seat-ask" className="min-w-0 flex-1" value={text} maxLength={500} onChange={(e) => setText(e.target.value)} placeholder={`Ask ${me.data.name}`} />
          <Button type="submit" size="sm" loading={ask.isPending} disabled={!text.trim() || ask.isPending}>
            Ask
          </Button>
        </form>
        {ask.error && <p className="text-sm text-negative">{ask.error instanceof ApiError ? ask.error.message : 'The assistant could not answer.'}</p>}
        {turn && (
          <div className="rounded-md border border-line bg-surface-raised/40 p-3 text-sm" aria-live="polite">
            <div className="text-xs2 text-ink-muted">{turn.question}</div>
            <div className="mt-1 whitespace-pre-wrap text-ink">{turn.answer.reply}</div>
            {turn.answer.linkUrl && (
              <Button asChild size="sm" variant="link" className="mt-1 px-0">
                <Link to={turn.answer.linkUrl}>Open</Link>
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
