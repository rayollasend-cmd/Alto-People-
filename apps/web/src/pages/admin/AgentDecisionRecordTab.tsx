import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError, apiFetch } from '@/lib/api';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { QueryError } from '@/components/ui/QueryError';

/**
 * Brief 2-6 step 3 — an agent's compliance record: what each capability
 * decides about people (its profile), the bias audit in force with a
 * warning 30 days before it lapses, and every decision about a person with
 * who decided and the notice, explanation, review and data-request dates.
 * Rows are append-only; a date, once entered, stays.
 */

interface DecisionRecord {
  profiles: Array<{ capabilityKey: string; decisionTypes: string[]; jurisdictions: string[]; assesses: string; humanReview: string; noticeStartedAt: string | null; isDefault: boolean }>;
  audits: Array<{ id: string; auditorName: string; conductedAt: string; validUntil: string; inForce: boolean; expiresSoon: boolean; dataKind: string; summaryUrl: string | null }>;
  decisions: Array<{
    id: string;
    at: string;
    capabilityKey: string;
    decisionType: string;
    subject: string | null;
    outcome: 'FAVORABLE' | 'ADVERSE' | 'NONE';
    summary: string;
    jurisdictionTags: string[];
    humanDecidedAt: string | null;
    noticeGivenAt: string | null;
    explanationSentAt: string | null;
    reviewRequestedAt: string | null;
  }>;
}

const OUTCOME: Record<DecisionRecord['decisions'][number]['outcome'], 'success' | 'destructive' | 'default'> = { FAVORABLE: 'success', ADVERSE: 'destructive', NONE: 'default' };
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '—');

export function AgentDecisionRecordTab({ agentId, canManage }: { agentId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['agents', 'decision-record', agentId], queryFn: () => apiFetch<DecisionRecord>(`/agents/${agentId}/decision-record`) });
  const mark = async (id: string, event: 'notice_given' | 'explanation_sent') => {
    try {
      await apiFetch(`/agents/decisions/${id}/events`, { method: 'POST', body: { event } });
      void qc.invalidateQueries({ queryKey: ['agents', 'decision-record', agentId] });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not record it.');
    }
  };
  if (q.isError) return <QueryError what="the compliance record" query={q} />;
  const d = q.data;
  if (!d) return <p className="text-sm text-silver">Loading…</p>;
  const deciding = d.profiles.filter((p) => p.decisionTypes.length);

  return (
    <div className="space-y-4 text-sm">
      <section aria-labelledby="adr-profiles">
        <h3 id="adr-profiles" className="mb-1 font-semibold text-white">What it decides about people</h3>
        {deciding.length === 0 ? (
          <p className="text-silver">Nothing: no capability of this agent is tagged as a decision about a person.</p>
        ) : (
          <ul className="space-y-1">
            {deciding.map((p) => (
              <li key={p.capabilityKey} className="text-silver">
                <span className="font-mono text-xs text-white">{p.capabilityKey}</span> — {p.decisionTypes.join(', ').toLowerCase()}
                {p.jurisdictions.length ? ` · ${p.jurisdictions.join(', ')}` : ''} · human review {p.humanReview === 'ALWAYS' ? 'always' : 'on request'}
                {p.isDefault ? ' · catalog default' : ''}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="adr-audits">
        <h3 id="adr-audits" className="mb-1 font-semibold text-white">Bias audits</h3>
        {d.audits.length === 0 ? (
          <p className="text-silver">None on file.</p>
        ) : (
          <ul className="space-y-1">
            {d.audits.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2 text-silver">
                <span className="text-white">{a.auditorName}</span>
                <span>
                  {a.conductedAt} → {a.validUntil}
                </span>
                <Badge variant={a.inForce ? (a.expiresSoon ? 'pending' : 'success') : 'default'} size="sm">
                  {a.inForce ? (a.expiresSoon ? 'Lapses within 30 days' : 'In force') : 'Lapsed'}
                </Badge>
                {a.summaryUrl && (
                  <a className="text-gold underline underline-offset-2" href={a.summaryUrl} target="_blank" rel="noreferrer">
                    Published summary
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="adr-decisions" className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 id="adr-decisions" className="font-semibold text-white">Decisions about people ({d.decisions.length})</h3>
          <Button asChild size="sm" variant="outline" className="ml-auto">
            <a href={`/api/agents/${agentId}/decision-record.csv`}>
              <Download className="mr-1.5 h-3.5 w-3.5" /> CSV
            </a>
          </Button>
        </div>
        {d.decisions.length === 0 ? (
          <p className="text-silver">None yet.</p>
        ) : (
          <ul className="divide-y divide-navy-secondary">
            {d.decisions.map((x) => (
              <li key={x.id} className="space-y-1 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-white">{x.subject ?? 'A person'}</span>
                  <Badge variant={OUTCOME[x.outcome]} size="sm">
                    {x.outcome.toLowerCase()}
                  </Badge>
                  <span className="text-xs text-silver">
                    {x.decisionType.toLowerCase()} · {day(x.at)} · decided by a person {day(x.humanDecidedAt)}
                  </span>
                </div>
                <p className="text-xs text-silver">{x.summary}</p>
                <p className="text-xs text-silver">
                  Notice {day(x.noticeGivenAt)} · explanation {day(x.explanationSentAt)} · review requested {day(x.reviewRequestedAt)}
                </p>
                {canManage && (
                  <div className="flex gap-2">
                    {!x.noticeGivenAt && (
                      <Button size="sm" variant="ghost" onClick={() => void mark(x.id, 'notice_given')}>
                        Notice given
                      </Button>
                    )}
                    {x.outcome === 'ADVERSE' && !x.explanationSentAt && (
                      <Button size="sm" variant="ghost" onClick={() => void mark(x.id, 'explanation_sent')}>
                        Explanation sent
                      </Button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
