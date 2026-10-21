import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { fmtMoney } from '@/lib/format';
import { MetricCard } from '@/components/ui/MetricCard';
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
    <MetricCard
      label="Agents · 30 days"
      value={r ? `${r.hoursSaved}h saved` : <Skeleton className="h-8 w-24" />}
      hint={
        r ? (
          <>
            {fmtMoney(r.costCents / 100)} cost
            {r.hoursPerDollar !== null ? ` · ${r.hoursPerDollar}h per $` : ''}
            {r.proposals.acceptancePct !== null ? ` · ${r.proposals.acceptancePct}% of ${r.proposals.filed} proposals accepted` : ` · ${r.assistant.answers} questions answered`}
            <span className="block text-2xs text-ink-muted">estimate</span>
          </>
        ) : undefined
      }
      className="h-full"
      cta={false}
      wrap={(card) => (
        <Link to="/agents" className="block h-full rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright">
          {card}
        </Link>
      )}
    />
  );
}
