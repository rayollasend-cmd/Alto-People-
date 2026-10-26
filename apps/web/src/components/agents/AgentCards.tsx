import { Link } from 'react-router-dom';
import { capabilityDef, WORKER_CAPABILITIES, WORKER_STATUS_LABELS, type AgentSummary } from '@alto-people/shared';
import { Badge } from '@/components/ui/Badge';
import { AgentGlyph } from '@/components/agents/AgentGlyph';
import { fmtMoney, fmtPercent, fmtRelativeDate } from '@/lib/format';
import { cn } from '@/lib/cn';
import { familyLabel, OwnerPerson, STATUS_VARIANT } from '@/pages/admin/AgentRegistryAdmin';

/**
 * The agents as a wall of cards (UX upgrade, 2026-10-15): one card per
 * agent with its mark, family, status, the model in product words, the
 * person who answers for it (face and name, opening their record), what it
 * may do, and the week's numbers. The table view stays one toggle away for
 * a registry with dozens of agents; the cards are how a buyer meets five.
 *
 * The whole card opens the agent (the title is a stretched link); the
 * owner is a link of its own, so a card holds no link inside a link.
 */
// Worker-level capabilities (deploy, report-read) carry their roster label; catalog ones their catalog name.
const WORKER_CAP_LABEL = new Map<string, string>(WORKER_CAPABILITIES.map((c) => [c.code, c.label]));

export function AgentCards({ agents, className }: { agents: AgentSummary[]; className?: string }) {
  return (
    // grid-cols-1 (minmax(0,1fr)) + min-w-0: with no base column a card's
    // min-content width pushed the phone page to 471px (F500 G2).
    <ul className={cn('grid grid-cols-1 gap-[var(--d-stack)] sm:grid-cols-2 xl:grid-cols-3', className)} aria-label="Agents">
      {agents.map((a) => (
        <li key={a.id} className="min-w-0">
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
    <article className="group relative flex h-full flex-col rounded-lg border border-line bg-surface p-[var(--d-card)] transition-colors hover:border-accent/50 focus-within:ring-2 focus-within:ring-gold-bright">
      <div className="flex items-start gap-3">
        <AgentGlyph family={a.profile.family} status={a.status} />
        <div className="min-w-0 flex-1">
          {/* The badge keeps the top-right corner on every card; a long name
              wraps under itself (two lines at most) instead of pushing the
              badge onto a line of its own (F500 2026-10-26). */}
          <div className="flex items-start justify-between gap-2">
            <Link
              to={`/agents/${a.id}`}
              aria-label={`Open ${a.name}`}
              title={a.name}
              className="line-clamp-2 min-w-0 font-medium text-ink after:absolute after:inset-0 after:rounded-lg after:content-[''] group-hover:text-accent focus:outline-none"
            >
              {a.name}
            </Link>
            <Badge variant={STATUS_VARIANT[a.status]} size="sm" className="mt-0.5 shrink-0">
              {WORKER_STATUS_LABELS[a.status]}
            </Badge>
          </div>
          {/* The family; who answers for it is the Owner line below, and the
              vendor and model are on the record's Profile tab, not in prime
              space (F500 G2). */}
          <div className="mt-0.5 truncate text-xs text-ink-muted">{familyLabel(a.profile.family) || 'Not yet placed in a family'}</div>
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
            {errorsLabel(s)}
          </dd>
        </div>
        <div>
          <dt className="text-ink-muted">Spend · month</dt>
          <dd className="mt-0.5 text-base font-semibold tabular-nums text-ink">{fmtMoney(a.spendThisMonthCents / 100)}</dd>
        </div>
      </dl>

      <div className="mt-3 flex items-center justify-between gap-2 text-xs text-ink-muted">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0">Owner</span>
          <OwnerPerson owner={a.owner} />
        </span>
        <span className="shrink-0">
          {a.pendingApprovals > 0 ? (
            <span className="font-medium text-caution">
              {a.pendingApprovals} {a.pendingApprovals === 1 ? 'proposal' : 'proposals'} waiting
            </span>
          ) : a.profile.lastActiveAt ? (
            `Active ${fmtRelativeDate(a.profile.lastActiveAt)}`
          ) : (
            'Not yet active'
          )}
        </span>
      </div>
    </article>
  );
}

/** One rule for the Errors figure: "—" when the agent finished no tasks
 *  this week (no rate to speak of), the rate otherwise (F500 G2: some cards
 *  said "—" and another "0%" for the same nothing). */
export function errorsLabel(s: AgentSummary['scorecard']): string {
  if (!s || s.tasksCompleted === 0 || s.errorRatePct === null) return '—';
  return fmtPercent(s.errorRatePct, { decimals: 0 });
}
