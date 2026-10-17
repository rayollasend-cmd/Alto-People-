import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Bot } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { fmtMoney } from '@/lib/format';
import { Card, CardContent } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * Agent ROI beside margin: hours of people's time the agents gave back
 * over thirty days, against what they cost. An estimate, and says so.
 */

export interface AgentRoi {
  windowDays: number;
  hoursSaved: number;
  costCents: number;
  hoursPerDollar: number | null;
  proposals: { filed: number; accepted: number; rejected: number; acceptancePct: number | null };
  assistant: { answers: number; modelAnswers: number; handoffs: number };
  perAgent: Array<{ workerId: string; name: string; filed: number; accepted: number; hoursSaved: number; costCents: number }>;
  estimate: true;
}

export const getAgentRoi = () => apiFetch<AgentRoi>('/executive/agent-roi');

export function AgentRoiTile() {
  const q = useQuery({ queryKey: ['ExecutiveDashboard', 'agent-roi'], queryFn: getAgentRoi });
  const r = q.data ?? null;
  if (q.isError) return null;
  return (
    <Link to="/agents" className="block h-full" aria-label="Agents: hours saved and cost, last 30 days">
      <Card className="h-full transition-colors hover:border-accent/40">
        <CardContent className="p-4">
          <div className="flex items-center gap-1.5 text-xs text-ink-muted">
            <Bot className="h-3.5 w-3.5" aria-hidden="true" />
            Agents · 30 days
          </div>
          {!r ? (
            <Skeleton className="mt-2 h-8 w-24" />
          ) : (
            <>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="text-2xl font-semibold tabular-nums text-ink">{r.hoursSaved}h</span>
                <span className="text-xs text-ink-muted">saved</span>
              </div>
              <div className="mt-0.5 text-xs text-ink-muted">
                {fmtMoney(r.costCents / 100)} cost
                {r.hoursPerDollar !== null ? ` · ${r.hoursPerDollar}h per $` : ''}
                {r.proposals.acceptancePct !== null ? ` · ${r.proposals.acceptancePct}% of ${r.proposals.filed} proposals accepted` : ` · ${r.assistant.answers} questions answered`}
              </div>
              <div className="mt-0.5 text-2xs text-ink-muted">estimate</div>
            </>
          )}
        </CardContent>
      </Card>
    </Link>
  );
}
