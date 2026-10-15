import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { capabilityDef, type AgentProposalSummary } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { fmtRelativeDate } from '@/lib/format';
import { askHugo, getHugo, listProposals, type HugoAnswer } from '@/lib/hugoApi';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { QueryError } from '@/components/ui/QueryError';

/**
 * Hugo on the Agents page (agent families step 3): ask him, and see what
 * the agents he routes to are doing. He answers from the registry the
 * server keeps (lib/hugo): only what is switched on for this organization
 * and this desk, never a capability that is off. The approval queue above
 * stays the page's hero; this is the conversation beside it.
 */

const STATUS_VARIANT: Record<AgentProposalSummary['status'], 'pending' | 'success' | 'destructive' | 'default' | 'accent'> = {
  PROPOSED: 'pending',
  APPROVED: 'accent',
  EXECUTED: 'success',
  REJECTED: 'destructive',
  FAILED: 'destructive',
  EXPIRED: 'default',
  SUPERSEDED: 'default',
};

const STATUS_LABEL: Record<AgentProposalSummary['status'], string> = {
  PROPOSED: 'Waiting',
  APPROVED: 'Approved',
  EXECUTED: 'Done',
  REJECTED: 'Rejected',
  FAILED: 'Failed',
  EXPIRED: 'Expired',
  SUPERSEDED: 'No longer needed',
};

interface Turn {
  question: string;
  answer: HugoAnswer;
}

export function HugoPanel() {
  const me = useQuery({ queryKey: ['hugo', 'me'], queryFn: getHugo, staleTime: 60_000 });
  const proposals = useQuery({ queryKey: ['agents', 'proposals', {}], queryFn: () => listProposals() });
  const [text, setText] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const ask = useMutation({
    mutationFn: (q: string) => askHugo(q),
    onSuccess: (answer, question) => {
      setTurns((t) => [{ question, answer }, ...t].slice(0, 5));
      setText('');
    },
  });

  const send = (q: string) => {
    const trimmed = q.trim();
    if (!trimmed || ask.isPending) return;
    ask.mutate(trimmed);
  };

  if (me.error) {
    // Switched off, or nothing for this account: say so quietly; the page works without him.
    const off = me.error instanceof ApiError && (me.error.status === 409 || me.error.status === 403);
    return off ? (
      <p className="text-sm text-silver" data-testid="hugo-off">
        {me.error.message}
      </p>
    ) : (
      <QueryError what="the assistant" query={me} />
    );
  }

  const recent = (proposals.data?.proposals ?? []).slice(0, 5);

  return (
    <Card data-testid="hugo-panel">
      <CardHeader>
        <CardTitle>{me.data ? `Ask ${me.data.name}` : 'Ask the assistant'}</CardTitle>
        <CardDescription>{me.data?.intro ?? 'Loading…'}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {me.data && me.data.can.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {me.data.can.map((c) => (
              <Button key={c.key} size="sm" variant="secondary" onClick={() => send(c.example)} disabled={ask.isPending}>
                {c.example}
              </Button>
            ))}
          </div>
        )}
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            send(text);
          }}
        >
          <label htmlFor="hugo-ask" className="sr-only">
            Your question
          </label>
          <Input
            id="hugo-ask"
            className="min-w-0 flex-1"
            value={text}
            maxLength={500}
            onChange={(e) => setText(e.target.value)}
            placeholder={me.data?.can[0]?.example ?? 'Ask a question'}
          />
          <Button type="submit" size="sm" loading={ask.isPending} disabled={!text.trim() || ask.isPending}>
            Ask
          </Button>
        </form>
        {ask.error && <p className="text-sm text-alert">{ask.error instanceof ApiError ? ask.error.message : 'The assistant could not answer.'}</p>}
        {turns.length > 0 && (
          <ul className="space-y-3" aria-live="polite">
            {turns.map((t, i) => (
              <li key={`${i}-${t.question}`} className="rounded-md border border-navy-secondary px-3 py-2">
                <p className="text-xs2 text-silver">{t.question}</p>
                <p className="whitespace-pre-line text-sm text-white">{t.answer.reply}</p>
                {t.answer.linkUrl && (
                  <Link to={t.answer.linkUrl} className="text-sm text-gold hover:text-gold-bright">
                    Open
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}

        <div>
          <h3 className="text-sm font-medium text-white">What the agents are doing</h3>
          {proposals.error ? (
            <QueryError what="the agents' proposals" query={proposals} />
          ) : recent.length === 0 ? (
            <p className="text-sm text-silver">{proposals.isLoading ? 'Loading…' : 'No proposals yet.'}</p>
          ) : (
            <ul className="mt-2 divide-y divide-navy-secondary">
              {recent.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                  <span className="text-white">{capabilityDef(p.capabilityKey)?.label ?? p.capabilityKey}</span>
                  <Badge variant={STATUS_VARIANT[p.status]} size="sm">
                    {STATUS_LABEL[p.status]}
                  </Badge>
                  <span className="text-xs2 text-silver">{fmtRelativeDate(p.statusAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
