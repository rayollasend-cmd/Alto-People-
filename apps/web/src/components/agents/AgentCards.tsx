import { Link } from 'react-router-dom';
import { capabilityDef, WORKER_CAPABILITIES, WORKER_STATUS_LABELS, type AgentSummary } from '@alto-people/shared';
import { Badge } from '@/components/ui/Badge';
import { AgentGlyph } from '@/components/agents/AgentGlyph';
import { fmtMoney, fmtPercent, fmtRelativeDate } from '@/lib/format';
import { cn } from '@/lib/cn';
import { familyLabel, STATUS_VARIANT } from '@/pages/admin/AgentRegistryAdmin';

/**
 * The agents as a wall of cards (UX upgrade, 2026-10-15): one card per
 * agent with its mark, family, status, the model in product words, who
 * answers for it, what it may do, and the week's numbers. The table view
 * stays one toggle away for a registry with dozens of agents; the cards
 * are how a buyer meets five.
 */
// Worker-level capabilities (deploy, report-read) carry their roster label; catalog ones their catalog name.
const WORKER_CAP_LABEL = new Map<string, string>(WORKER_CAPABILITIES.map((c) => [c.code, c.label]));

export function AgentCards({ agents, className }: { agents: AgentSummary[]; className?: string }) {
  return (
    <ul className={cn('grid gap-[var(--d-stack)] sm:grid-cols-2 xl:grid-cols-3', className)} aria-label="Agents">
      {agents.map((a) => (
        <li key={a.id}>
          <AgentCard agent={a} />
        </li>
      ))}
    </ul>
  );
}

function AgentCard({ agent: a }: { agent: AgentSummary }) {
  const caps = a.capabilities.map((c) => capabilityDef(c)?.label ?? WORKER_CAP_LABEL.get(c) ?? c);
  const s = a.scorecard;
  const over =
    s?.errorRatePct !== null &&
    s?.errorRatePct !== undefined &&
    a.drift?.driftErrorRatePct !== null &&
    a.drift?.driftErrorRatePct !== undefined &&
    s.errorRatePct >= a.drift.driftErrorRatePct;
  return (
    <Link
      to={`/agents/${a.id}`}
      aria-label={`Open ${a.name}`}
      className="group flex h-full flex-col rounded-lg border border-line bg-surface p-[var(--d-card)] transition-colors hover:border-accent/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
    >
      <div className="flex items-start gap-3">
        <AgentGlyph family={a.profile.family} status={a.status} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium text-ink group-hover:text-accent">{a.name}</span>
            <Badge variant={STATUS_VARIANT[a.status]} size="sm">
              {WORKER_STATUS_LABELS[a.status]}
            </Badge>
          </div>
          <div className="mt-0.5 truncate text-xs text-ink-muted">
            {familyLabel(a.profile.family) || 'Unplaced'} · {a.profile.vendor} · {a.profile.model} {a.profile.modelVersion}
          </div>
        </div>
      </div>

      {a.profile.capability && <p className="mt-3 line-clamp-2 text-sm text-ink-muted">{a.profile.capability}</p>}

      {caps.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1">
          {caps.slice(0, 3).map((c) => (
            <Badge key={c} variant="outline" size="sm" withDot={false}>
              {c}
            </Badge>
          ))}
          {caps.length > 3 && (
            <Badge variant="outline" size="sm" withDot={false}>
              +{caps.length - 3}
            </Badge>
          )}
        </div>
      )}

      <dl className="mt-auto grid grid-cols-3 gap-2 border-t border-line pt-3 text-xs">
        <div>
          <dt className="text-ink-muted">Tasks · 7d</dt>
          <dd className="mt-0.5 text-base font-semibold tabular-nums text-ink">{s ? s.tasksCompleted : '—'}</dd>
        </div>
        <div>
          <dt className="text-ink-muted">Errors</dt>
          <dd className={cn('mt-0.5 text-base font-semibold tabular-nums', over ? 'text-caution' : 'text-ink')}>
            {s && s.errorRatePct !== null ? fmtPercent(s.errorRatePct, { decimals: 0 }) : '—'}
          </dd>
        </div>
        <div>
          <dt className="text-ink-muted">Spend · month</dt>
          <dd className="mt-0.5 text-base font-semibold tabular-nums text-ink">{fmtMoney(a.spendThisMonthCents / 100)}</dd>
        </div>
      </dl>

      <div className="mt-3 flex items-center justify-between gap-2 text-xs text-ink-muted">
        <span className="truncate">{a.owner ? `Owner ${a.owner.name || a.owner.email}` : 'No owner'}</span>
        <span className="shrink-0">
          {a.pendingApprovals > 0 ? (
            <span className="font-medium text-caution">{a.pendingApprovals} waiting</span>
          ) : a.profile.lastActiveAt ? (
            `Active ${fmtRelativeDate(a.profile.lastActiveAt)}`
          ) : (
            'Never active'
          )}
        </span>
      </div>
    </Link>
  );
}
