import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ApiError, apiFetch } from '@/lib/api';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { QueryError } from '@/components/ui/QueryError';

/**
 * Brief 2-5 step 6 — the access review the access-review control signs
 * off: elevated accounts and their flags (the 1A-4 report), and every AI
 * agent with its owner, scopes, gates and credentials' age, flagged where it
 * needs a look. "Record this review" writes the evidence row the approver
 * then signs below, noting which flags are accepted and why.
 */

interface ReviewAgent {
  id: string;
  name: string;
  status: string;
  owner: { email: string; status: string } | null;
  scopes: string[];
  gatePolicies: number;
  liveCredentials: number;
  oldestCredentialDays: number | null;
  flags: string[];
}

interface Review {
  elevatedAccounts: number;
  flaggedAccounts: number;
  accountFlags: Record<string, number>;
  agents: ReviewAgent[];
  agentFlagLabels: Record<string, string>;
}

export function AccessReviewPanel() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['compliance-evidence', 'access-review'], queryFn: () => apiFetch<Review>('/admin/access-review') });
  const record = async () => {
    try {
      await apiFetch('/admin/access-review/run', { method: 'POST', body: {} });
      toast.success('Recorded. Sign it off below once every flag is resolved or accepted.');
      await qc.invalidateQueries({ queryKey: ['compliance-evidence'] });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not record the review.');
    }
  };
  if (q.isError) return <QueryError what="the access review" query={q} />;
  const r = q.data;
  if (!r) return <p className="text-sm text-silver">Loading the review…</p>;
  const flagged = r.agents.filter((a) => a.flags.length);
  return (
    <section aria-labelledby="access-review-title" className="space-y-3 rounded-md border border-navy-secondary p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id="access-review-title" className="font-semibold text-white">This quarter’s review</h3>
        <Button size="sm" className="ml-auto" onClick={() => void record()}>
          Record this review
        </Button>
      </div>
      <p className="text-silver">
        {r.elevatedAccounts} elevated accounts; {r.flaggedAccounts} accounts carry a flag on the access report. {r.agents.length} agents, {flagged.length} flagged.
      </p>
      {flagged.length > 0 && (
        <ul className="divide-y divide-navy-secondary">
          {flagged.map((a) => (
            <li key={a.id} className="py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-white">{a.name}</span>
                <span className="text-xs text-silver">
                  owner {a.owner?.email ?? 'none'} · {a.liveCredentials} live credential{a.liveCredentials === 1 ? '' : 's'}
                  {a.oldestCredentialDays !== null ? `, oldest ${a.oldestCredentialDays} days` : ''} · {a.gatePolicies} gate{a.gatePolicies === 1 ? '' : 's'}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                {a.flags.map((f) => (
                  <Badge key={f} variant="pending" size="sm">
                    {r.agentFlagLabels[f] ?? f}
                  </Badge>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
