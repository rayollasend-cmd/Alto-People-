import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Bot, Copy, LayoutGrid, MoreHorizontal, Plus, Settings2, ShieldAlert, TableProperties } from 'lucide-react';
import { AgentCards } from '@/components/agents/AgentCards';
import { ProposalList } from '@/components/agents/ProposalDecision';
import { AgentGlyph } from '@/components/agents/AgentGlyph';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Avatar } from '@/components/ui/Avatar';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/DropdownMenu';
import { userPhotoUrl } from '@/lib/photoUrl';
import { getHugo } from '@/lib/hugoApi';
import { toast } from 'sonner';
import {
  AGENT_APPROVAL_STATUS_LABELS,
  AGENT_ENVIRONMENT_LABELS,
  AGENT_EXECUTABLE_ACTIONS,
  AGENT_GATED_ACTION_LABELS,
  AGENT_FAMILIES,
  AGENT_SCOPES,
  PLATFORM_OPERATOR_TENANT_ID,
  WORKER_STATUS_LABELS,
  capabilityDef,
  type AgentCapabilitySummary,
  type AgentApprovalStatus,
  type AgentApprovalSummary,
  type AgentCertification,
  type AgentControlState,
  type AgentCredentialState,
  type AgentDetail,
  type AgentEnvironment,
  type AgentGatedAction,
  type AgentScenarioSummary,
  type AgentScope,
  type AgentScorecard,
  type AgentSummary,
  type WorkerStatus,
} from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useAuth, useTenant, useTerm } from '@/lib/auth';
import { useConfirm, usePrompt } from '@/lib/confirm';
import { fmtDate, fmtDateTime, fmtMoney, fmtPercent, fmtRelativeDate } from '@/lib/format';
import { listAdminUsers } from '@/lib/usersAdminApi';
import {
  addAgentScenario,
  certifyAgent,
  createAgent,
  ensureBuiltInAgents,
  getAgentControl,
  getAgentScorecard,
  getCapabilityScorecard,
  issueAgentCredential,
  listAgentCapabilities,
  listAgentApprovals,
  listAgentScenarios,
  listAgents,
  recordAgentSpend,
  removeAgentScenario,
  resumeAgent,
  resumeAgentCapability,
  resumeAllAgents,
  revokeAgentCredential,
  runAgentScenarios,
  suspendAgent,
  suspendAgentCapability,
  suspendAllAgents,
  updateAgentDrift,
} from '@/lib/agentsApi';
import { PageHeader } from '@/components/ui/PageHeader';
import { HugoPanel } from './HugoPanel';
import { AgentCatalogPicker, type CatalogChoice } from './AgentCatalogPicker';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { MetricCard } from '@/components/ui/MetricCard';
import { Select } from '@/components/ui/Select';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { QueryError } from '@/components/ui/QueryError';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';

/**
 * The agent registry (Brief 1D-2) — every AI agent Alto runs: who owns
 * it, what it may do, its credentials, limits, spend and the trail of
 * what it did. The hero is the approval queue: the gated actions an
 * agent may only ask for wait here until a person decides.
 *
 * Brief 1D-3 adds the controls: a kill switch for one agent or all of
 * them (credentials revoked at once; only the owner resumes one), a
 * certification tab (scenarios every agent must pass under its current
 * model version before it leaves onboarding), a scorecard and the drift
 * thresholds that raise an alert.
 *
 * Deep links: `?approval=<id>` opens that request's decision dialog (the
 * owner's notification points here); `?agent=<id>` opens that agent's
 * detail (the kill, recertification and drift notifications point here).
 * Each param is dropped once consumed.
 */

const STATUSES: WorkerStatus[] = ['ONBOARDING', 'ACTIVE', 'SUSPENDED', 'OFFBOARDED'];
const ENVIRONMENTS: AgentEnvironment[] = ['PRODUCTION', 'STAGING', 'DEVELOPMENT'];
export const STATUS_VARIANT: Record<WorkerStatus, 'pending' | 'success' | 'destructive' | 'outline'> = {
  ONBOARDING: 'pending',
  ACTIVE: 'success',
  SUSPENDED: 'destructive',
  OFFBOARDED: 'outline',
};
const APPROVAL_VARIANT: Record<AgentApprovalStatus, 'pending' | 'success' | 'destructive' | 'outline' | 'default'> = {
  PENDING: 'pending',
  APPROVED: 'success',
  REJECTED: 'destructive',
  CONSUMED: 'default',
  EXPIRED: 'outline',
};
const CREDENTIAL_VARIANT: Record<AgentCredentialState, 'success' | 'accent' | 'outline' | 'destructive'> = {
  ACTIVE: 'success',
  ROTATING: 'accent',
  EXPIRED: 'outline',
  REVOKED: 'destructive',
};
const CREDENTIAL_STATE_LABELS: Record<AgentCredentialState, string> = {
  ACTIVE: 'Active',
  ROTATING: 'Rotating',
  EXPIRED: 'Expired',
  REVOKED: 'Revoked',
};
const TTL_OPTIONS: { value: number; label: string }[] = [
  { value: 1, label: '1 hour' },
  { value: 24, label: '24 hours' },
  { value: 72, label: '3 days' },
  { value: 168, label: '7 days' },
];
const SCOPE_LABEL = new Map<string, string>(AGENT_SCOPES.map((s) => [s.code, s.label]));
const HUMAN_ONLY_ACTIONS = (Object.keys(AGENT_GATED_ACTION_LABELS) as AgentGatedAction[]).filter((a) => !AGENT_EXECUTABLE_ACTIONS.includes(a));

export function familyLabel(code: string | null | undefined): string {
  return AGENT_FAMILIES.find((f) => f.code === code)?.label ?? '';
}

/** Values the registry stores when nobody has said: never shown as words on screen. */
const PLACEHOLDER_WORDS = new Set(['', 'unknown', 'unconfirmed', 'n/a', 'tbd', '-', '—']);
const said = (v: string | null | undefined): string => {
  const t = (v ?? '').trim();
  return PLACEHOLDER_WORDS.has(t.toLowerCase()) ? '' : t;
};

/** "Anthropic · Claude Sonnet 4.5", with whatever was never confirmed left out; "Model not set" when nothing was. */
export function modelLine(p: Pick<AgentSummary['profile'], 'vendor' | 'model' | 'modelVersion'>): string {
  const parts = [said(p.vendor), [said(p.model), said(p.modelVersion)].filter(Boolean).join(' ')].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Model not set';
}

/** A model version as the page says it: the version, or "not set". */
export function versionLabel(v: string | null | undefined): string {
  return said(v) || 'not set';
}

const UNPLACED_GROUP = 'Not yet placed in a family';

export interface AgentFamilyGroup {
  key: string;
  label: string;
  agents: AgentSummary[];
}

/**
 * The agents in the taxonomy's order (packages/shared AGENT_FAMILIES): the
 * Workforce group first, then Operations, Compliance, Finance and Clients,
 * IT and Developers, Everyone — so the organization's own working agents
 * (Workforce, Compliance) read before the vendor-seeded ones (Boardroom,
 * the deployment workflow). Within a group, by family then by name; agents
 * with no family yet close the list.
 */
export function groupAgentsByFamily(agents: readonly AgentSummary[]): AgentFamilyGroup[] {
  const familyOrder = AGENT_FAMILIES.map((f) => f.code as string);
  const groupOrder: string[] = [];
  for (const f of AGENT_FAMILIES) if (!groupOrder.includes(f.group)) groupOrder.push(f.group);
  const byGroup = new Map<string, AgentSummary[]>();
  for (const a of agents) {
    const g = AGENT_FAMILIES.find((f) => f.code === a.profile.family)?.group ?? UNPLACED_GROUP;
    byGroup.set(g, [...(byGroup.get(g) ?? []), a]);
  }
  const rank = (a: AgentSummary) => {
    const i = familyOrder.indexOf(a.profile.family ?? '');
    return i === -1 ? familyOrder.length : i;
  };
  return [...groupOrder, UNPLACED_GROUP]
    .filter((g) => byGroup.has(g))
    .map((g) => ({ key: g, label: g, agents: (byGroup.get(g) ?? []).slice().sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)) }));
}

/**
 * The person who answers for an agent, as a person: their face and name,
 * opening their record when they have one. Inside a clickable row the click
 * stays on the person, not the row.
 */
export function OwnerPerson({ owner, size = 'xs', className = '' }: { owner: AgentSummary['owner']; size?: 'xs' | 'sm'; className?: string }) {
  if (!owner) {
    return (
      <Badge variant="destructive" size="sm">
        No owner
      </Badge>
    );
  }
  const name = owner.name || owner.email;
  const inner = (
    <>
      <Avatar src={userPhotoUrl(owner.id)} name={owner.name} email={owner.email} size={size} />
      <span className="truncate">{name}</span>
    </>
  );
  return owner.associateId ? (
    <Link to={`/people/${owner.associateId}`} className={`relative z-10 inline-flex min-w-0 items-center gap-2 hover:text-accent ${className}`} onClick={(e) => e.stopPropagation()} title={owner.email}>
      {inner}
    </Link>
  ) : (
    <span className={`inline-flex min-w-0 items-center gap-2 ${className}`} title={owner.email}>
      {inner}
    </span>
  );
}

export function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    const code = (err as { code?: string }).code ?? '';
    if (code === 'owner_not_eligible') return 'A client portal account cannot own an agent.';
    if (code === 'owner_not_found') return 'That owner no longer exists.';
    if (code === 'agent_not_found') return 'That agent no longer exists.';
    if (code === 'approval_decided') return 'This request was already decided.';
    if (code === 'approval_expired') return 'This request expired before it was decided.';
    if (code === 'credential_already_revoked') return 'That credential was already revoked.';
    if (code === 'owner_only') return 'Only the accountable owner can resume this agent.';
    if (code === 'agent_not_suspended') return 'This agent is not suspended.';
    if (code === 'agent_offboarded') return 'An offboarded agent cannot be suspended.';
    if (code === 'agents_not_suspended') return 'Agents are not suspended.';
    if (code === 'agent_answers_itself') return 'This agent answers its scenarios itself through the agent API; Alto cannot run them for it.';
    // agent_not_certified carries the reason ("2 of 5 scenarios are not passing …").
    return err.message || fallback;
  }
  return fallback;
}

/** Cents → "$12.34". Money reads in heavy sans, never the display serif. */
export function Money({ cents, className = '' }: { cents: number; className?: string }) {
  return <span className={`font-semibold tabular-nums ${className}`}>{fmtMoney(cents / 100)}</span>;
}

/** A compact one-line JSON for scenario cells. */
function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

/**
 * A scenario's input in words: the question when it is one ({ text }), the
 * fixture's own description when it carries one, else "its fields: a, b".
 * The JSON stays one hover away for whoever wrote it.
 */
export function describeScenarioInput(input: Record<string, unknown>): string {
  if (typeof input.description === 'string' && input.description.trim()) return input.description.trim();
  if (typeof input.text === 'string' && input.text.trim()) return `Asked: “${input.text.trim()}”`;
  if (typeof input.message === 'string' && input.message.trim()) return `Message: “${input.message.trim()}”`;
  if (typeof input.fixture === 'string' && input.fixture.trim()) return `Fixture: ${input.fixture.trim()}`;
  if (typeof input.capability === 'string' && input.capability.trim()) return `Runs ${capabilityDef(input.capability)?.label ?? input.capability}`;
  const keys = Object.keys(input);
  if (keys.length === 0) return 'No input';
  return `Given ${keys.join(', ')}`;
}

/** What a passing run must do or answer, in words. */
export function describeScenarioExpected(expected: AgentScenarioSummary['expected']): string {
  if (expected.output !== undefined) {
    const o = expected.output as Record<string, unknown>;
    if (o && typeof o === 'object' && typeof o.reply === 'string') return `Answers “${o.reply}”`;
    const keys = o && typeof o === 'object' ? Object.keys(o) : [];
    return keys.length ? `Answers with ${keys.join(', ')} exactly as written` : 'Answers exactly as written';
  }
  const actions = expected.allowedActions ?? [];
  return actions.length ? `May only: ${actions.join(', ')}` : 'Takes no action';
}

/**
 * ✓ + version when certified for the version it runs now; the onboarding
 * count while it is still onboarding; "Recertify" for a live agent whose
 * model version moved past its certificate (or that never had one).
 */
export function certificationLabel(c: AgentCertification | undefined, status: WorkerStatus): { text: string; variant: 'success' | 'pending' | 'destructive' | 'outline' } {
  if (!c) return { text: '—', variant: 'outline' };
  if (c.current) return { text: `✓ ${versionLabel(c.certifiedModelVersion ?? c.modelVersion)}`, variant: 'success' };
  if (status === 'ONBOARDING') return { text: `Onboarding: ${c.passing}/${c.scenarios} scenarios`, variant: 'pending' };
  return { text: 'Recertify', variant: 'destructive' };
}

export function hoursLabel(start: number | null, end: number | null): string {
  if (start === null && end === null) return 'Any hour';
  const s = start ?? 0;
  const e = end ?? 24;
  return `${String(s).padStart(2, '0')}:00 → ${e === 24 ? '24:00' : `${String(e).padStart(2, '0')}:00`}`;
}

function scopeChips(scopes: readonly string[]) {
  return scopes.length ? (
    <span className="flex flex-wrap gap-1">
      {scopes.map((s) => (
        <Badge key={s} variant="outline" size="sm">
          {SCOPE_LABEL.get(s) ?? s}
        </Badge>
      ))}
    </span>
  ) : (
    <span className="text-silver/60">—</span>
  );
}

/* ------------------------------------------------------------ the page */

const AGENTS_VIEW_KEY = 'alto.agents.view';
function readAgentsView(): 'cards' | 'table' {
  try {
    return window.localStorage.getItem(AGENTS_VIEW_KEY) === 'table' ? 'table' : 'cards';
  } catch {
    return 'cards';
  }
}
function writeAgentsView(v: 'cards' | 'table'): void {
  try {
    window.localStorage.setItem(AGENTS_VIEW_KEY, v);
  } catch {
    /* private mode */
  }
}

export function AgentRegistryAdmin() {
  const { can } = useAuth();
  const canManage = can('manage:org');
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const term = useTerm();
  // The assistant's name comes from the API — a tenant may call him something else.
  const assistant = useQuery({ queryKey: ['hugo', 'me'], queryFn: getHugo, staleTime: 60_000 });
  const assistantName = assistant.data?.name ?? 'the assistant';
  const [creating, setCreating] = useState(false);
  // Cards are how a buyer meets five agents; the table is how an operator
  // works fifty. The choice sticks per browser.
  const [view, setView] = useState<'cards' | 'table'>(() => readAgentsView());
  const [ensuring, setEnsuring] = useState(false);
  const [suspendingAll, setSuspendingAll] = useState(false);
  const [resumingAll, setResumingAll] = useState(false);

  const registry = useQuery({ queryKey: ['agents', 'list'], queryFn: listAgents });
  const queueFilters = useMemo(() => ({ status: 'PENDING' as const }), []);
  const queue = useQuery({ queryKey: ['agents', 'approvals', queueFilters], queryFn: () => listAgentApprovals(queueFilters) });
  // The registry carries the global switch; the dedicated read is only
  // for an API that answers without it.
  const controlQuery = useQuery({
    queryKey: ['agents', 'control'],
    queryFn: getAgentControl,
    enabled: registry.data !== undefined && registry.data.control === undefined,
  });
  const control: AgentControlState | undefined = registry.data?.control ?? controlQuery.data;
  // Agent families: beside this organization's switch, the platform's (the operator's alone).
  const platform = registry.data?.platformControl;
  const tenantSession = useTenant();
  const isOperator = tenantSession.id === PLATFORM_OPERATOR_TENANT_ID;
  // A tenant without clients has no client to message.
  const hasClients = tenantSession.moduleOn('clientPortal');

  const agents = useMemo(() => registry.data?.agents ?? [], [registry.data]);
  const groups = useMemo(() => groupAgentsByFamily(agents), [agents]);
  const counts = registry.data?.counts;
  // Named, never keyed: "Workforce agent", not `workforce-agent`.
  const builtInMissing = registry.data?.builtInMissing ?? [];
  const builtInName = useMemo(() => new Map((registry.data?.builtInMissingAgents ?? []).map((b) => [b.key, b.name])), [registry.data]);
  const builtInMissingNames = builtInMissing.map((k) => builtInName.get(k) ?? k);
  const pendingCount = registry.data?.pendingApprovals ?? queue.data?.approvals.length ?? 0;
  const pending = useMemo(
    () => (queue.data?.approvals ?? []).slice().sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)),
    [queue.data],
  );

  const refetchAll = () => qc.invalidateQueries({ queryKey: ['agents'] });

  // Deep link: ?approval=<id> (older notifications) lands on that proposal's
  // card in the queue below, ringed; the param is consumed once the queue has
  // loaded so Back and refetches don't re-focus it. A request that is no
  // longer waiting gets a toast from the list instead.
  const [target, setTarget] = useState<string | null>(() => searchParams.get('approval'));
  const queueLoaded = queue.data !== undefined;
  useEffect(() => {
    if (!searchParams.get('approval') || !queueLoaded) return;
    const next = new URLSearchParams(searchParams);
    next.delete('approval');
    setSearchParams(next, { replace: true });
    // searchParams/setSearchParams change identity on the consume above;
    // the param going null ends the cycle, so they're deliberately not deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueLoaded]);
  useEffect(() => {
    // Once decided or gone, stop ringing it.
    if (target && queueLoaded && !pending.some((a) => a.id === target && a.status === 'PENDING')) setTarget(null);
  }, [target, queueLoaded, pending]);

  // Deep link: ?agent=<id> (the kill, recertification and drift
  // notifications point here) lands on that agent's record page.
  const agentTarget = searchParams.get('agent');
  useEffect(() => {
    if (!agentTarget) return;
    navigate(`/agents/${agentTarget}`, { replace: true });
    // The redirect consumes the param; navigate is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentTarget]);

  // Deep link: ?register=1 (the roster's "Register agent") opens the one
  // registration form there is, and the param is dropped once consumed.
  const registerTarget = searchParams.get('register');
  useEffect(() => {
    if (!registerTarget) return;
    const next = new URLSearchParams(searchParams);
    next.delete('register');
    setSearchParams(next, { replace: true });
    if (canManage) setCreating(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerTarget, canManage]);

  const onResumeAll = async () => {
    setResumingAll(true);
    try {
      await resumeAllAgents();
      toast.success('Agents resumed. No credential was restored — issue new ones per agent.');
      await refetchAll();
    } catch (err) {
      toast.error(errorMessage(err, 'Could not resume the agents.'));
    } finally {
      setResumingAll(false);
    }
  };

  const onEnsure = async () => {
    setEnsuring(true);
    try {
      const r = await ensureBuiltInAgents();
      const n = r.created.length;
      toast.success(n === 1 ? '1 built-in agent registered.' : `${n} built-in agents registered.`);
      if (r.missing.length) toast.info(`Still waiting for an owner account: ${r.missing.map((k) => builtInName.get(k) ?? k).join(', ')}.`);
      await refetchAll();
    } catch (err) {
      toast.error(errorMessage(err, 'Could not register the built-in agents.'));
    } finally {
      setEnsuring(false);
    }
  };

  const columns = useMemo<GridColumn<AgentSummary>[]>(
    () => [
      {
        key: 'name',
        header: 'Agent',
        accessor: (a) => a.name,
        primary: true,
        sortable: true,
        searchable: true,
        cell: (a) => (
          <span className="flex items-center gap-2">
            <AgentGlyph family={a.profile.family} status={a.status} size="sm" />
            <span className="flex min-w-0 flex-col">
              <span className="font-medium text-ink">{a.name}</span>
              <span className="text-xs2 text-ink-muted">{modelLine(a.profile)}</span>
            </span>
          </span>
        ),
      },
      {
        key: 'family',
        header: 'Family',
        accessor: (a) => familyLabel(a.profile.family),
        sortable: true,
        searchable: true,
        cardMeta: true,
        cell: (a) => (
          <span className="flex flex-col">
            <span>{familyLabel(a.profile.family) || <span className="text-silver/60">Unplaced</span>}</span>
            {a.profile.capability && <span className="text-xs2 text-silver/70">{a.profile.capability}</span>}
          </span>
        ),
      },
      {
        key: 'owner',
        header: 'Owner',
        accessor: (a) => a.owner?.name ?? a.owner?.email ?? '',
        sortable: true,
        searchable: true,
        cardMeta: true,
        cell: (a) => <OwnerPerson owner={a.owner} />,
        csv: (a) => (a.owner ? `${a.owner.name} <${a.owner.email}>` : ''),
      },
      {
        key: 'status',
        header: 'Status',
        accessor: (a) => WORKER_STATUS_LABELS[a.status],
        sortable: true,
        cardMeta: true,
        cell: (a) => <Badge variant={STATUS_VARIANT[a.status]}>{WORKER_STATUS_LABELS[a.status]}</Badge>,
      },
      {
        key: 'certified',
        header: 'Certified',
        accessor: (a) => certificationLabel(a.certification, a.status).text,
        sortable: true,
        cell: (a) => {
          const c = a.certification;
          const l = certificationLabel(c, a.status);
          const title = c ? (c.current ? `Certified ${c.certifiedAt ? fmtDate(c.certifiedAt) : ''} for ${c.certifiedModelVersion ?? c.modelVersion}` : c.certifiedModelVersion ? `Certified for ${c.certifiedModelVersion}; now runs ${c.modelVersion} · ${c.passing}/${c.scenarios} passing` : `${c.passing}/${c.scenarios} scenarios passing under ${c.modelVersion}`) : undefined;
          return (
            <Badge variant={l.variant} size="sm" withDot={false} title={title}>
              {l.text}
            </Badge>
          );
        },
      },
      {
        key: 'environment',
        header: 'Environment',
        accessor: (a) => AGENT_ENVIRONMENT_LABELS[a.profile.environment],
        sortable: true,
      },
      {
        key: 'scopes',
        header: 'Scopes',
        accessor: (a) => a.profile.scopes.map((s) => SCOPE_LABEL.get(s) ?? s).join(', '),
        searchable: true,
        cell: (a) => scopeChips(a.profile.scopes),
      },
      { key: 'credentials', header: 'Active credentials', accessor: (a) => a.activeCredentials, sortable: true, align: 'right' },
      {
        key: 'spend',
        header: 'Spend this month',
        accessor: (a) => a.spendThisMonthCents / 100,
        sortable: true,
        align: 'right',
        cell: (a) => <Money cents={a.spendThisMonthCents} />,
        csv: (a) => (a.spendThisMonthCents / 100).toFixed(2),
      },
      {
        key: 'tasks7d',
        header: 'Tasks (7d)',
        accessor: (a) => a.scorecard?.tasksCompleted ?? null,
        sortable: true,
        align: 'right',
        cell: (a) => {
          const s = a.scorecard;
          if (!s) return <span className="text-silver/60">—</span>;
          return (
            <span className="tabular-nums" title={`${s.errors} errors · ${s.exceptionsEscalated} escalated · ${s.approvalsRequested} approvals asked, ${s.approvalsRejected} rejected`}>
              {s.tasksCompleted}
            </span>
          );
        },
      },
      {
        key: 'errorRate7d',
        header: 'Error rate (7d)',
        accessor: (a) => a.scorecard?.errorRatePct ?? null,
        sortable: true,
        align: 'right',
        cell: (a) => {
          const s = a.scorecard;
          if (!s || s.errorRatePct === null) return <span className="text-silver/60">—</span>;
          const over = a.drift?.driftErrorRatePct !== null && a.drift?.driftErrorRatePct !== undefined && s.errorRatePct >= a.drift.driftErrorRatePct;
          return (
            <span className={`tabular-nums ${over ? 'font-medium text-warning' : ''}`} title={over ? `Above the ${a.drift?.driftErrorRatePct}% drift threshold` : undefined}>
              {fmtPercent(s.errorRatePct, { decimals: 0 })}
            </span>
          );
        },
        csv: (a) => a.scorecard?.errorRatePct ?? '',
      },
      {
        key: 'costPerTask7d',
        header: 'Cost per task (7d)',
        accessor: (a) => (a.scorecard?.costPerTaskCents === null || a.scorecard?.costPerTaskCents === undefined ? null : a.scorecard.costPerTaskCents / 100),
        sortable: true,
        align: 'right',
        // The grid is wide already; the chooser turns this on.
        defaultHidden: true,
        cell: (a) => {
          const s = a.scorecard;
          if (!s || s.costPerTaskCents === null) return <span className="text-silver/60">—</span>;
          const over = a.drift?.driftCostPerTaskCents !== null && a.drift?.driftCostPerTaskCents !== undefined && s.costPerTaskCents >= a.drift.driftCostPerTaskCents;
          return <Money cents={s.costPerTaskCents} className={over ? 'text-warning' : ''} />;
        },
        csv: (a) => (a.scorecard?.costPerTaskCents === null || a.scorecard?.costPerTaskCents === undefined ? '' : (a.scorecard.costPerTaskCents / 100).toFixed(2)),
      },
      {
        key: 'lastActive',
        header: 'Last active',
        accessor: (a) => a.profile.lastActiveAt ?? '',
        sortable: true,
        cell: (a) => (a.profile.lastActiveAt ? fmtRelativeDate(a.profile.lastActiveAt) : <span className="text-silver/60">Not yet active</span>),
        csv: (a) => a.profile.lastActiveAt ?? '',
      },
      {
        key: 'pending',
        header: 'Proposals waiting',
        accessor: (a) => a.pendingApprovals,
        sortable: true,
        align: 'right',
        cell: (a) => (a.pendingApprovals > 0 ? <span className="font-medium text-warning tabular-nums">{a.pendingApprovals}</span> : <span className="tabular-nums">0</span>),
      },
    ],
    [],
  );

  return (
    <div className="space-y-6" data-template="list">
      <PageHeader
        title="Agents"
        subtitle={`The agents that work beside your ${term('workers').toLowerCase()}, routed by ${assistantName}. Each has a person who answers for it, the scopes it may use, and limits on spend, rate and hours; anything gated waits for a person.`}
        breadcrumbs={[{ label: term('nav.people'), to: '/people' }, { label: 'Agents' }]}
        primaryAction={
          canManage ? (
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" aria-hidden="true" /> Register agent
            </Button>
          ) : undefined
        }
        secondaryActions={
          <span className="flex items-center gap-2">
            <Button asChild variant="ghost" size="sm">
              <Link to="/admin/agents">
                <Settings2 className="h-4 w-4" aria-hidden="true" /> Agents &amp; gates
              </Link>
            </Button>
            {canManage && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" aria-label="More actions">
                    <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={onEnsure} disabled={ensuring || builtInMissing.length === 0}>
                    <Bot className="h-4 w-4" aria-hidden="true" /> Register built-in agents
                  </DropdownMenuItem>
                  {control && !control.allSuspendedAt && (
                    <DropdownMenuItem destructive onSelect={() => setSuspendingAll(true)}>
                      <ShieldAlert className="h-4 w-4" aria-hidden="true" /> Suspend all agents
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </span>
        }
      />

      {registry.error && <QueryError what="agents" query={registry} />}

      {/* The global switch, when thrown: nothing below it is live. */}
      {control?.allSuspendedAt && (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-md border border-alert/40 bg-alert/10 px-4 py-3 text-sm">
          <ShieldAlert className="h-5 w-5 shrink-0 text-alert" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="font-medium text-white">
              All agents suspended since {fmtDateTime(control.allSuspendedAt)}
              {control.suspendedBy ? ` by ${control.suspendedBy.name}` : ''}
              {control.reason ? ` — ${control.reason}` : ''}
            </p>
            <p className="text-xs2 text-silver/80">Every credential was revoked and every agent call is refused until this is lifted. Resuming restores no credential.</p>
          </div>
          {canManage && (
            <Button variant="secondary" onClick={onResumeAll} disabled={resumingAll}>
              {resumingAll ? 'Resuming…' : 'Resume all agents'}
            </Button>
          )}
        </div>
      )}

      {/* The platform switch, when thrown, stops every organization's agents: everyone is told.
          Its resting state is the operator's business alone, on Settings & trust › Agents & gates. */}
      {platform?.allSuspendedAt && (
        <p className="rounded-md border border-alert/40 bg-alert/10 px-4 py-2 text-sm text-ink" role="alert" data-testid="platform-switch">
          The platform switch is on since {fmtDateTime(platform.allSuspendedAt)}
          {platform.suspendedBy ? ` by ${platform.suspendedBy.name}` : ''}: every organization’s agents are stopped{platform.reason ? ` — ${platform.reason}` : ''}.
          {isOperator && (
            <>
              {' '}
              <Link to="/admin/agents#platform-switch" className="underline underline-offset-2">
                Lift it under Agents &amp; gates.
              </Link>
            </>
          )}
        </p>
      )}

      {/* Hero: the approval queue. */}
      <section aria-labelledby="agent-queue-heading" className="space-y-3">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard
            label="Waiting for a person"
            value={registry.isLoading && queue.isLoading ? '—' : String(pendingCount)}
            accent={pendingCount > 0}
            hint={pendingCount > 0 ? 'Gated actions an agent asked for' : 'Nothing waiting'}
          />
          <MetricCard label="Active" value={registry.isLoading ? '—' : String(counts?.ACTIVE ?? 0)} hint="Working now" />
          <MetricCard label="Onboarding" value={registry.isLoading ? '—' : String(counts?.ONBOARDING ?? 0)} hint="Registered, not yet live" />
          <MetricCard label="Suspended" value={registry.isLoading ? '—' : String(counts?.SUSPENDED ?? 0)} hint="Credentials revoked" />
        </div>
        <h2 id="agent-queue-heading" className="sr-only">
          Approval queue
        </h2>
        {/* Each proposal as a decision: the evidence, the agent and its owner, Approve / Reject with a
            reason. Who may decide comes from the server's rule (`mayDecide`), not from manage:org. */}
        {(pending.length > 0 || queue.isLoading || queue.error) && (
          <ProposalList
            approvals={queue.data?.approvals}
            loading={queue.isLoading}
            error={queue.error}
            onRetry={() => void queue.refetch()}
            canDecide={canManage}
            focusId={target}
            onFocusMissing={() => toast.info('That request is no longer waiting — it may already be decided.')}
            onDecided={refetchAll}
          />
        )}
        <ul className="grid gap-1 text-xs2 text-ink-muted sm:grid-cols-2" aria-label="Who carries out what">
          <li>
            <span className="font-medium text-ink">Always a person:</span> {HUMAN_ONLY_ACTIONS.map((a) => AGENT_GATED_ACTION_LABELS[a].toLowerCase()).join(', ')}. The approver does these in the app; the agent only asks.
          </li>
          <li>
            <span className="font-medium text-ink">Needs approval first:</span> {AGENT_EXECUTABLE_ACTIONS.filter((a) => hasClients || a !== 'CLIENT_MESSAGE').map((a) => AGENT_GATED_ACTION_LABELS[a].toLowerCase()).join(', ')}. The agent carries these out once a person approves.
          </li>
        </ul>
      </section>


      {builtInMissingNames.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-warning/30 bg-warning/10 px-4 py-3 text-sm" data-testid="built-in-missing">
          <Bot className="h-4 w-4 text-warning" aria-hidden="true" />
          <span>
            {builtInMissingNames.length === 1 ? 'One agent the product already runs is not registered here yet: ' : 'Agents the product already runs are not registered here yet: '}
            <strong>{builtInMissingNames.join(', ')}</strong>. Each needs an account to answer for it.
          </span>
          {canManage && (
            <Button size="sm" variant="secondary" onClick={onEnsure} disabled={ensuring}>
              {ensuring ? 'Registering…' : 'Register them'}
            </Button>
          )}
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <SectionTitle title="The agents" description={agents.length ? `${agents.length} registered, by family.` : undefined} />
        <div role="radiogroup" aria-label="Agents view" className="inline-flex gap-0.5 rounded-md border border-line bg-navy-secondary/30 p-0.5">
          <Button size="xs" variant={view === 'cards' ? 'secondary' : 'ghost'} role="radio" aria-checked={view === 'cards'} onClick={() => { setView('cards'); writeAgentsView('cards'); }}>
            <LayoutGrid className="h-3.5 w-3.5" aria-hidden="true" /> Cards
          </Button>
          <Button size="xs" variant={view === 'table' ? 'secondary' : 'ghost'} role="radio" aria-checked={view === 'table'} onClick={() => { setView('table'); writeAgentsView('table'); }}>
            <TableProperties className="h-3.5 w-3.5" aria-hidden="true" /> Table
          </Button>
        </div>
      </div>
      {view === 'cards' && agents.length > 0 && !registry.isLoading && (
        <div className="space-y-6">
          {groups.map((g) => (
            <section key={g.key} aria-labelledby={`agents-group-${g.key.replace(/\W+/g, '-')}`} className="space-y-3">
              <SectionTitle as="h3" id={`agents-group-${g.key.replace(/\W+/g, '-')}`} title={g.label} trailing={<span className="text-xs tabular-nums text-ink-muted">{g.agents.length}</span>} />
              <AgentCards agents={g.agents} />
            </section>
          ))}
        </div>
      )}
      {(view === 'table' || agents.length === 0 || registry.isLoading) && (
      <DataGrid
        id="agents"
        caption="Agents"
        rows={agents}
        rowKey={(a) => a.id}
        loading={registry.isLoading}
        error={registry.error ? errorMessage(registry.error, 'Could not load the agents.') : null}
        onRetry={() => registry.refetch()}
        search={{ placeholder: 'Search agents, owners, scopes…' }}
        urlState
        exportCsv={{ filename: 'agents' }}
        columnChooser
        columns={columns}
        onRowClick={(a) => navigate(`/agents/${a.id}`)}
        rowActionLabel={(a) => `Open ${a.name}`}
        defaultSort={{ key: 'family', direction: 'asc' }}
        empty={{
          icon: Bot,
          title: 'No agents registered',
          description: canManage ? 'Register an agent, or register the built-in ones the product already runs.' : 'Agents appear here once they are registered.',
        }}
      />
      )}

      {/* The assistant: ask him, and see what the agents he routes to are doing (agent families step 3). */}
      <HugoPanel />
      <p className="text-xs2 text-ink-muted">
        Who approves what, certification and credentials across agents, the MCP tools and the decision record are under{' '}
        <Link to="/admin/agents" className="underline underline-offset-2 hover:text-accent">
          Settings &amp; trust › Agents &amp; gates
        </Link>
        .
      </p>

      {creating && (
        <CreateAgentDialog
          onClose={() => setCreating(false)}
          onCreated={async () => {
            setCreating(false);
            await refetchAll();
          }}
        />
      )}
      {suspendingAll && (
        <SuspendAllDialog
          agents={counts ? counts.ACTIVE + counts.ONBOARDING : agents.length}
          onClose={() => setSuspendingAll(false)}
          onSuspended={async () => {
            setSuspendingAll(false);
            await refetchAll();
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------- kill switch */

export function SuspendAllDialog({ agents, onClose, onSuspended }: { agents: number; onClose: () => void; onSuspended: () => Promise<void> }) {
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const valid = reason.trim().length >= 3;

  const submit = async () => {
    if (!valid) return;
    setSaving(true);
    try {
      const r = await suspendAllAgents(reason.trim());
      toast.success(`All agents suspended. ${r.revoked === 1 ? '1 credential' : `${r.revoked} credentials`} revoked.`);
      await onSuspended();
    } catch (err) {
      toast.error(errorMessage(err, 'Could not suspend the agents.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} confirmDiscard={reason !== '' && !saving}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Suspend all agents?</DialogTitle>
          <DialogDescription>
            Every credential is revoked at once and every agent call is refused until an org admin resumes. {agents === 1 ? '1 agent is' : `${agents} agents are`} live now. Resuming restores no credential.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Field label="Reason" required hint="Kept with the switch and shown to every owner.">
            {(p) => <Textarea {...p} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={300} autoFocus />}
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={!valid || saving}>
              {saving ? 'Suspending…' : 'Suspend all agents'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------ owners */

function useOwnerOptions() {
  // Every active internal account; portal accounts are excluded because
  // the server refuses them as owners (owner_not_eligible).
  return useQuery({
    queryKey: ['admin', 'users', 'agent-owners'],
    queryFn: () => listAdminUsers({ status: 'ACTIVE' }),
    select: (d) => d.users.filter((u) => u.role !== 'CLIENT_PORTAL').sort((a, b) => (a.associateName ?? a.email).localeCompare(b.associateName ?? b.email)),
  });
}

function OwnerSelect({ value, onChange, id, ...aria }: { value: string; onChange: (v: string) => void; id?: string; 'aria-describedby'?: string; 'aria-invalid'?: true }) {
  const owners = useOwnerOptions();
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} required {...aria}>
      <option value="">{owners.isLoading ? 'Loading owners…' : 'Choose an owner'}</option>
      {(owners.data ?? []).map((u) => (
        <option key={u.id} value={u.id}>
          {u.associateName ? `${u.associateName} — ${u.email}` : u.email}
        </option>
      ))}
    </Select>
  );
}

/* ------------------------------------------------------- profile form */

export interface ProfileForm {
  name: string;
  ownerUserId: string;
  purpose: string;
  vendor: string;
  model: string;
  modelVersion: string;
  environment: AgentEnvironment;
  scopes: AgentScope[];
  /** Dollars as typed; '' = no cap. */
  spendCap: string;
  rateLimit: string;
  hoursStart: string;
  hoursEnd: string;
  status: WorkerStatus;
  notes: string;
}

function emptyForm(): ProfileForm {
  return {
    name: '',
    ownerUserId: '',
    purpose: '',
    vendor: '',
    model: '',
    modelVersion: '',
    environment: 'PRODUCTION',
    scopes: [],
    spendCap: '',
    rateLimit: '60',
    hoursStart: '',
    hoursEnd: '',
    status: 'ONBOARDING',
    notes: '',
  };
}

export function formFromAgent(a: AgentDetail): ProfileForm {
  return {
    name: a.name,
    ownerUserId: a.owner?.id ?? '',
    purpose: a.profile.purpose,
    vendor: a.profile.vendor,
    model: a.profile.model,
    modelVersion: a.profile.modelVersion,
    environment: a.profile.environment,
    scopes: a.profile.scopes,
    spendCap: a.profile.spendCapCents === null ? '' : (a.profile.spendCapCents / 100).toFixed(2),
    rateLimit: String(a.profile.rateLimitPerMinute),
    hoursStart: a.profile.allowedHoursStart === null ? '' : String(a.profile.allowedHoursStart),
    hoursEnd: a.profile.allowedHoursEnd === null ? '' : String(a.profile.allowedHoursEnd),
    status: a.status,
    notes: a.notes ?? '',
  };
}

export function formValid(f: ProfileForm): boolean {
  const rate = Number(f.rateLimit);
  const cap = f.spendCap === '' ? null : Number(f.spendCap);
  const hs = f.hoursStart === '' ? null : Number(f.hoursStart);
  const he = f.hoursEnd === '' ? null : Number(f.hoursEnd);
  return (
    f.name.trim().length >= 2 &&
    f.ownerUserId !== '' &&
    f.purpose.trim().length >= 3 &&
    f.vendor.trim().length >= 1 &&
    f.model.trim().length >= 1 &&
    f.modelVersion.trim().length >= 1 &&
    Number.isInteger(rate) &&
    rate >= 1 &&
    rate <= 10_000 &&
    (cap === null || (Number.isFinite(cap) && cap >= 0)) &&
    (hs === null || (Number.isInteger(hs) && hs >= 0 && hs <= 23)) &&
    (he === null || (Number.isInteger(he) && he >= 1 && he <= 24))
  );
}

export function limitsFromForm(f: ProfileForm) {
  return {
    spendCapCents: f.spendCap === '' ? null : Math.round(Number(f.spendCap) * 100),
    rateLimitPerMinute: Number(f.rateLimit),
    allowedHoursStart: f.hoursStart === '' ? null : Number(f.hoursStart),
    allowedHoursEnd: f.hoursEnd === '' ? null : Number(f.hoursEnd),
  };
}

function ScopePicker({ value, onChange, disabled }: { value: AgentScope[]; onChange: (next: AgentScope[]) => void; disabled?: boolean }) {
  const toggle = (code: AgentScope, on: boolean) => onChange(on ? Array.from(new Set([...value, code])) : value.filter((v) => v !== code));
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-sm font-medium text-silver">Scopes</legend>
      <p className="text-xs2 text-silver/70">Least privilege: nothing here touches pay, people records, access or settings. Those are asked for through the queue.</p>
      <div className="grid gap-1.5 sm:grid-cols-2">
        {AGENT_SCOPES.map((s) => (
          <label key={s.code} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={value.includes(s.code)} onChange={(e) => toggle(s.code, e.target.checked)} disabled={disabled} />
            {s.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** The profile fields shared by Register and Edit. */
export function ProfileFields({ form, set, canManage, owner }: { form: ProfileForm; set: <K extends keyof ProfileForm>(k: K, v: ProfileForm[K]) => void; canManage: boolean; owner: AgentDetail['owner'] | undefined }) {
  return (
    <>
      <Field label="Name" required hint="How it appears on schedules and in audit.">
        {(p) => <Input {...p} value={form.name} onChange={(e) => set('name', e.target.value)} maxLength={160} disabled={!canManage} />}
      </Field>
      <Field label="Owner" required hint="The person who answers for what this agent does.">
        {(p) => (canManage ? <OwnerSelect {...p} value={form.ownerUserId} onChange={(v) => set('ownerUserId', v)} /> : <Input {...p} value={owner ? `${owner.name} — ${owner.email}` : 'No owner'} readOnly />)}
      </Field>
      <Field label="Purpose" required>
        {(p) => <Textarea {...p} value={form.purpose} onChange={(e) => set('purpose', e.target.value)} rows={2} maxLength={500} disabled={!canManage} />}
      </Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Vendor" required>
          {(p) => <Input {...p} value={form.vendor} onChange={(e) => set('vendor', e.target.value)} maxLength={80} disabled={!canManage} />}
        </Field>
        <Field label="Model" required>
          {(p) => <Input {...p} value={form.model} onChange={(e) => set('model', e.target.value)} maxLength={120} disabled={!canManage} />}
        </Field>
        <Field label="Model version" required>
          {(p) => <Input {...p} value={form.modelVersion} onChange={(e) => set('modelVersion', e.target.value)} maxLength={80} disabled={!canManage} />}
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Environment">
          {(p) => (
            <Select {...p} value={form.environment} onChange={(e) => set('environment', e.target.value as AgentEnvironment)} disabled={!canManage}>
              {ENVIRONMENTS.map((e) => (
                <option key={e} value={e}>
                  {AGENT_ENVIRONMENT_LABELS[e]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Status">
          {(p) => (
            <Select {...p} value={form.status} onChange={(e) => set('status', e.target.value as WorkerStatus)} disabled={!canManage}>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {WORKER_STATUS_LABELS[s]}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <ScopePicker value={form.scopes} onChange={(v) => set('scopes', v)} disabled={!canManage} />
      <fieldset className="space-y-3">
        <legend className="text-sm font-medium text-silver">Limits</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Spend cap per month ($)" hint="Blank = no cap.">
            {(p) => <Input {...p} type="number" inputMode="decimal" min={0} step="0.01" value={form.spendCap} onChange={(e) => set('spendCap', e.target.value)} placeholder="No cap" disabled={!canManage} />}
          </Field>
          <Field label="Rate limit per minute" required>
            {(p) => <Input {...p} type="number" inputMode="numeric" min={1} max={10000} step={1} value={form.rateLimit} onChange={(e) => set('rateLimit', e.target.value)} disabled={!canManage} />}
          </Field>
          <Field label="Allowed hours start (0–23)" hint="Blank = any hour.">
            {(p) => <Input {...p} type="number" inputMode="numeric" min={0} max={23} step={1} value={form.hoursStart} onChange={(e) => set('hoursStart', e.target.value)} placeholder="Any hour" disabled={!canManage} />}
          </Field>
          <Field label="Allowed hours end (1–24)" hint="24 = midnight.">
            {(p) => <Input {...p} type="number" inputMode="numeric" min={1} max={24} step={1} value={form.hoursEnd} onChange={(e) => set('hoursEnd', e.target.value)} placeholder="Any hour" disabled={!canManage} />}
          </Field>
        </div>
      </fieldset>
      <Field label="Notes">
        {(p) => <Textarea {...p} value={form.notes} onChange={(e) => set('notes', e.target.value)} rows={2} maxLength={2000} disabled={!canManage} />}
      </Field>
    </>
  );
}

/* ------------------------------------------------------------- create */

function CreateAgentDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => Promise<void> }) {
  const [form, setForm] = useState<ProfileForm>(emptyForm);
  const [catalog, setCatalog] = useState<CatalogChoice>({ family: null, capabilities: [] });
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof ProfileForm>(k: K, v: ProfileForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const dirty = JSON.stringify(form) !== JSON.stringify(emptyForm()) || catalog.family !== null;
  const valid = formValid(form);

  const submit = async () => {
    if (!valid) return;
    setSaving(true);
    try {
      await createAgent({
        name: form.name.trim(),
        ownerUserId: form.ownerUserId,
        purpose: form.purpose.trim(),
        vendor: form.vendor.trim(),
        model: form.model.trim(),
        modelVersion: form.modelVersion.trim(),
        environment: form.environment,
        scopes: form.scopes,
        ...limitsFromForm(form),
        status: form.status,
        capabilities: [],
        notes: form.notes.trim() || undefined,
        family: catalog.family,
        catalogCapabilities: catalog.capabilities,
      });
      toast.success(`${form.name.trim()} registered.`);
      await onCreated();
    } catch (err) {
      toast.error(errorMessage(err, 'Could not register the agent.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} confirmDiscard={dirty && !saving}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Register agent</DialogTitle>
          <DialogDescription>Every agent has an owner who answers for it, the scopes it may use, and limits on spend, rate and hours.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <AgentCatalogPicker value={catalog} onChange={setCatalog} scopes={form.scopes} onScopes={(s) => set('scopes', s)} />
          <ProfileFields form={form} set={set} canManage owner={undefined} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || saving}>
              {saving ? 'Registering…' : 'Register'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------- detail */

/* -------------------------------------------------------- kill switch */

/**
 * The status area under the header: suspend (any org admin, with a
 * reason) or resume (the owner, and only the owner). Suspending revokes
 * every credential; resuming gives none back.
 */
export function KillSwitchRow({
  agent,
  canManage,
  onChanged,
  placement = 'summary',
}: {
  agent: AgentDetail;
  canManage: boolean;
  onChanged: () => Promise<unknown>;
  /** `actions`: the Suspend button alone, for the record header. `summary`: the suspended banner and the resumed notice. */
  placement?: 'actions' | 'summary';
}) {
  const { user } = useAuth();
  const prompt = usePrompt();
  const [busy, setBusy] = useState(false);
  const [resumed, setResumed] = useState(false);
  const isOwner = Boolean(user?.id && agent.owner?.id && user.id === agent.owner.id);
  const kill = agent.kill;

  const suspend = async () => {
    const reason = await prompt({
      title: `Suspend ${agent.name}?`,
      description: 'Every credential is revoked the moment this is saved and the agent stops being able to call Alto. Only the owner can resume it.',
      confirmLabel: 'Suspend',
      destructive: true,
      reasonLabel: 'Reason',
      reasonMaxLength: 300,
      required: true,
    });
    if (reason === null) return;
    if (reason.trim().length < 3) {
      toast.error('Give a reason of at least 3 characters.');
      return;
    }
    setBusy(true);
    try {
      const r = await suspendAgent(agent.id, reason.trim());
      toast.success(`${agent.name} suspended. ${r.revoked === 1 ? '1 credential' : `${r.revoked} credentials`} revoked.`);
      setResumed(false);
      await onChanged();
    } catch (err) {
      toast.error(errorMessage(err, 'Could not suspend the agent.'));
    } finally {
      setBusy(false);
    }
  };

  const resume = async () => {
    setBusy(true);
    try {
      await resumeAgent(agent.id);
      toast.success(`${agent.name} resumed. No credential was restored.`);
      setResumed(true);
      await onChanged();
    } catch (err) {
      toast.error(errorMessage(err, 'Could not resume the agent.'));
    } finally {
      setBusy(false);
    }
  };

  if (agent.status === 'SUSPENDED') {
    if (placement === 'actions') return null;
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-md border border-alert/40 bg-alert/10 px-3 py-2 text-sm" data-testid="kill-switch">
        <ShieldAlert className="h-4 w-4 shrink-0 text-alert" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-white">
            Suspended{kill?.suspendedAt ? ` ${fmtDateTime(kill.suspendedAt)}` : ''}
            {kill?.suspendedBy ? ` by ${kill.suspendedBy.name}` : ''}
          </p>
          <p className="text-xs2 text-silver/80">{kill?.suspendReason ? kill.suspendReason : 'Credentials revoked.'}</p>
          {!isOwner && <p className="text-xs2 text-silver/70">Only the owner{agent.owner ? ` (${agent.owner.name || agent.owner.email})` : ''} can resume.</p>}
        </div>
        {canManage && (
          <Button size="sm" variant="secondary" onClick={resume} disabled={!isOwner || busy} title={isOwner ? undefined : 'Only the owner can resume'}>
            {busy ? 'Resuming…' : 'Resume'}
          </Button>
        )}
      </div>
    );
  }

  if (agent.status === 'OFFBOARDED') return null;

  if (placement === 'actions') {
    if (!canManage) return null;
    return (
      <Button size="sm" variant="outline" className="border-alert/50 text-alert hover:border-alert hover:text-alert" onClick={suspend} disabled={busy} data-testid="kill-switch">
        <ShieldAlert className="h-4 w-4" aria-hidden="true" /> {busy ? 'Suspending…' : 'Suspend'}
      </Button>
    );
  }

  if (!resumed) return null;
  return (
    <p className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs2 text-warning" role="status" data-testid="kill-switch">
      Resumed. No credential was restored — issue a new one under Credentials.
    </p>
  );
}

/* ------------------------------------------------------- capabilities */

const SCORECARD_DAYS = 7;

/** A capability's own metric keys, in words. */
const METRIC_LABELS: Record<string, string> = {
  shiftsSeen: 'Open shifts broadcast',
  broadcastPickupRate: 'Picked up from the broadcast (%)',
  proposalsMade: 'Fills proposed',
  proposalsApproved: 'Approved',
  filledBeforeStart: 'Filled before the start',
  medianMinutesToFill: 'Median minutes, proposal to filled',
};

/**
 * Agent families: what the agent may do, one capability at a time. Each
 * has its own switch (any org admin suspends with a reason; the
 * accountable owner alone resumes) and its own scorecard read from the
 * proposals it made.
 */
export function CapabilitiesSection({ agent, canManage }: { agent: AgentDetail; canManage: boolean }) {
  const caps = useQuery({ queryKey: ['agents', 'capabilities', agent.id], queryFn: () => listAgentCapabilities(agent.id), select: (d) => d.capabilities });
  if (caps.error) return <QueryError what="capabilities" query={caps} />;
  if (!caps.data) return <p className="text-sm text-silver">Loading…</p>;
  if (caps.data.length === 0) {
    return <p className="text-sm text-silver">This agent holds no catalog capability. Built-in family agents hold theirs; an outside agent acts through its scopes.</p>;
  }
  return (
    <ul className="space-y-3" aria-label="Capabilities">
      {caps.data.map((c) => (
        <CapabilityRow key={c.key} agent={agent} cap={c} canManage={canManage} />
      ))}
    </ul>
  );
}

function capabilityState(c: AgentCapabilitySummary): { text: string; variant: 'success' | 'pending' | 'destructive' | 'outline' } {
  if (!c.offered) return { text: 'Not offered here', variant: 'outline' };
  if (c.suspendedAt) return { text: 'Suspended', variant: 'destructive' };
  if (!c.enabled) return { text: 'Off', variant: 'outline' };
  return { text: 'On', variant: 'success' };
}

function CapabilityRow({ agent, cap, canManage }: { agent: AgentDetail; cap: AgentCapabilitySummary; canManage: boolean }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const prompt = usePrompt();
  const [busy, setBusy] = useState(false);
  const isOwner = Boolean(user?.id && agent.owner?.id && user.id === agent.owner.id);
  const score = useQuery({
    queryKey: ['agents', 'capability-scorecard', agent.id, cap.key, SCORECARD_DAYS],
    queryFn: () => getCapabilityScorecard(agent.id, cap.key, SCORECARD_DAYS),
  });
  const state = capabilityState(cap);
  const refresh = () => qc.invalidateQueries({ queryKey: ['agents', 'capabilities', agent.id] });

  const suspend = async () => {
    const reason = await prompt({
      title: `Suspend “${cap.label}”?`,
      description: 'The agent stops using this capability at once; its other capabilities keep running. Only the accountable owner can resume it.',
      confirmLabel: 'Suspend',
      destructive: true,
      reasonLabel: 'Reason',
      reasonMaxLength: 300,
      required: true,
    });
    if (reason === null) return;
    if (reason.trim().length < 3) {
      toast.error('Give a reason of at least 3 characters.');
      return;
    }
    setBusy(true);
    try {
      await suspendAgentCapability(agent.id, cap.key, reason.trim());
      toast.success(`${cap.label} suspended.`);
      await refresh();
    } catch (err) {
      toast.error(errorMessage(err, 'Could not suspend the capability.'));
    } finally {
      setBusy(false);
    }
  };
  const resume = async () => {
    setBusy(true);
    try {
      await resumeAgentCapability(agent.id, cap.key);
      toast.success(`${cap.label} resumed.`);
      await refresh();
    } catch (err) {
      toast.error(errorMessage(err, 'Could not resume the capability.'));
    } finally {
      setBusy(false);
    }
  };

  const s = score.data;
  const metrics = s ? Object.entries(s.metrics ?? {}) : [];
  return (
    <li className="rounded-md border border-navy-secondary/60 px-3 py-3 text-sm" data-testid={`capability-${cap.key}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-white">{cap.label}</span>
        <Badge variant={state.variant} size="sm">{state.text}</Badge>
        {cap.gate && <span className="text-xs2 text-silver/80">asks first: {AGENT_GATED_ACTION_LABELS[cap.gate]}</span>}
        <span className="ml-auto flex gap-2">
          {canManage && cap.offered && !cap.suspendedAt && (
            <Button size="sm" variant="outline" onClick={suspend} disabled={busy}>
              Suspend
            </Button>
          )}
          {canManage && cap.suspendedAt && (
            <Button size="sm" variant="secondary" onClick={resume} disabled={busy || !isOwner} title={isOwner ? undefined : 'Only the owner can resume'}>
              Resume
            </Button>
          )}
        </span>
      </div>
      {cap.suspendedAt && (
        <p className="mt-1 text-xs2 text-silver/80">
          Suspended {fmtDateTime(cap.suspendedAt)}
          {cap.suspendedBy ? ` by ${cap.suspendedBy.name}` : ''}
          {cap.suspendReason ? ` — ${cap.suspendReason}` : ''}
        </p>
      )}
      {score.error ? (
        <p className="mt-2 text-xs2 text-silver/80">The scorecard could not be read.</p>
      ) : s ? (
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs2 sm:grid-cols-3">
          <div><dt className="text-silver/70">Proposed ({SCORECARD_DAYS} days)</dt><dd className="text-white">{s.proposed}</dd></div>
          <div><dt className="text-silver/70">Approved</dt><dd className="text-white">{s.approved}</dd></div>
          <div><dt className="text-silver/70">Carried out</dt><dd className="text-white">{s.executed}</dd></div>
          <div><dt className="text-silver/70">Rejected</dt><dd className="text-white">{s.rejected}</dd></div>
          <div><dt className="text-silver/70">Superseded</dt><dd className="text-white">{s.superseded}</dd></div>
          <div><dt className="text-silver/70">Outcome rate</dt><dd className="text-white">{s.outcomeRatePct === null ? '—' : `${s.outcomeRatePct}%`}</dd></div>
          {metrics.map(([k, v]) => (
            <div key={k}><dt className="text-silver/70">{METRIC_LABELS[k] ?? k}</dt><dd className="text-white">{v === null ? '—' : v}</dd></div>
          ))}
        </dl>
      ) : (
        <p className="mt-2 text-xs2 text-silver/80">Loading the scorecard…</p>
      )}
    </li>
  );
}

/* ------------------------------------------------------ certification */

/** Parse a JSON object typed by hand; the message is for the field's error line. */
function parseJsonObject(text: string): { value: Record<string, unknown> } | { error: string } {
  if (text.trim() === '') return { error: 'Required.' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: 'Not valid JSON.' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: 'Must be a JSON object, like {"text": "…"}.' };
  return { value: parsed as Record<string, unknown> };
}

export function CertificationSection({ agent, canManage, onChanged }: { agent: AgentDetail; canManage: boolean; onChanged: () => Promise<unknown> }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const scenarios = useQuery({ queryKey: ['agents', 'scenarios', agent.id], queryFn: () => listAgentScenarios(agent.id), select: (d) => d.scenarios });
  const cert = agent.certification;
  const [running, setRunning] = useState(false);
  const [certifying, setCertifying] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [input, setInput] = useState('');
  const [mode, setMode] = useState<'output' | 'actions'>('output');
  const [expectedOutput, setExpectedOutput] = useState('');
  const [allowedActions, setAllowedActions] = useState('');
  const [touched, setTouched] = useState(false);

  const inputParsed = parseJsonObject(input);
  const outputParsed = parseJsonObject(expectedOutput);
  const actionsList = allowedActions
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const nameValid = name.trim().length >= 2;
  const expectedValid = mode === 'output' ? 'value' in outputParsed : actionsList.length > 0;
  const formValid = nameValid && 'value' in inputParsed && expectedValid;
  const formDirty = name !== '' || input !== '' || expectedOutput !== '' || allowedActions !== '';

  const refresh = async () => {
    await Promise.all([qc.invalidateQueries({ queryKey: ['agents', 'scenarios', agent.id] }), onChanged()]);
  };

  const add = async () => {
    setTouched(true);
    if (!formValid || !('value' in inputParsed)) return;
    setAdding(true);
    try {
      await addAgentScenario(agent.id, {
        name: name.trim(),
        input: inputParsed.value,
        expected: mode === 'output' && 'value' in outputParsed ? { output: outputParsed.value } : { allowedActions: actionsList },
      });
      toast.success('Scenario added.');
      setName('');
      setInput('');
      setExpectedOutput('');
      setAllowedActions('');
      setTouched(false);
      await refresh();
    } catch (err) {
      toast.error(errorMessage(err, 'Could not add the scenario.'));
    } finally {
      setAdding(false);
    }
  };

  const remove = async (s: AgentScenarioSummary) => {
    const ok = await confirm({ title: `Delete “${s.name}”?`, description: 'Its runs go with it. Certification is recomputed from what remains.', confirmLabel: 'Delete', destructive: true });
    if (!ok) return;
    setRemoving(s.id);
    try {
      await removeAgentScenario(agent.id, s.id);
      toast.success('Scenario deleted.');
      await refresh();
    } catch (err) {
      toast.error(errorMessage(err, 'Could not delete the scenario.'));
    } finally {
      setRemoving(null);
    }
  };

  const run = async () => {
    setRunning(true);
    try {
      const r = await runAgentScenarios(agent.id);
      qc.setQueryData(['agents', 'scenarios', agent.id], { scenarios: r.scenarios });
      toast[r.passed === r.ran ? 'success' : 'info'](`${r.passed} of ${r.ran} scenarios passed.`);
      await onChanged();
    } catch (err) {
      toast.error(errorMessage(err, 'Could not run the scenarios.'));
    } finally {
      setRunning(false);
    }
  };

  const certify = async () => {
    setCertifying(true);
    try {
      const r = await certifyAgent(agent.id);
      toast.success(r.agent.status === 'ACTIVE' && agent.status === 'ONBOARDING' ? `${agent.name} certified and active.` : `${agent.name} certified for ${r.certification.modelVersion}.`);
      await refresh();
    } catch (err) {
      toast.error(errorMessage(err, 'Could not certify the agent.'));
    } finally {
      setCertifying(false);
    }
  };

  const canCertify = Boolean(cert?.ready) && (agent.status === 'ONBOARDING' || !cert?.current);
  const rows = scenarios.data ?? [];

  return (
    <div className="space-y-4">
      {/* The summary. */}
      <div className="flex flex-wrap items-start gap-3 rounded-md border border-navy-secondary bg-navy-secondary/40 px-3 py-2 text-sm">
        <div className="min-w-0 flex-1 space-y-0.5">
          {cert ? (
            <>
              <p className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-white">Runs {cert.modelVersion}</span>
                <Badge variant={certificationLabel(cert, agent.status).variant} size="sm" withDot={false}>
                  {cert.current ? 'Certified for this version' : cert.certifiedModelVersion ? `Certified for ${cert.certifiedModelVersion}` : 'Not certified'}
                </Badge>
              </p>
              <p className="text-xs2 text-silver/80">
                {cert.scenarios === 0 && cert.current
                  ? `Attested at registration: it was already running when it was registered, so it counts as certified for ${versionLabel(cert.modelVersion)} with no scenario yet.`
                  : `${cert.passing} of ${cert.scenarios} ${cert.scenarios === 1 ? 'scenario' : 'scenarios'} passing under ${versionLabel(cert.modelVersion)}`}
                {cert.certifiedAt ? ` · last certified ${fmtDateTime(cert.certifiedAt)}` : ''}
                {' · '}
                {cert.ready ? 'ready to certify' : cert.scenarios === 0 ? 'add at least one scenario to prove it' : 'not ready'}
              </p>
            </>
          ) : (
            <p className="text-silver/70">No certification data.</p>
          )}
        </div>
        {canManage && (
          <div className="flex flex-wrap gap-2">
            {cert?.runnable && (
              <Button size="sm" variant="secondary" onClick={run} disabled={running || rows.length === 0}>
                {running ? 'Running…' : 'Run scenarios'}
              </Button>
            )}
            <Button size="sm" onClick={certify} disabled={!canCertify || certifying}>
              {certifying ? 'Certifying…' : 'Certify'}
            </Button>
          </div>
        )}
      </div>
      {cert && !cert.runnable && (
        <p className="text-xs2 text-silver/70">
          This agent answers its scenarios itself, through the agent API with its own credential. Each answer is recorded here as a run under the model version it runs now; the vendor's integration guide under Developers says how.
        </p>
      )}
      {cert && !cert.current && agent.status !== 'ONBOARDING' && (
        <p className="text-xs2 text-warning">The model version moved past the certificate. Every scenario must pass again under {cert.modelVersion} before this agent is certified.</p>
      )}

      {/* The scenarios. */}
      {scenarios.error && <QueryError what="the scenarios" query={scenarios} />}
      {scenarios.isLoading ? (
        <p className="text-sm text-silver/70">Loading scenarios…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-silver/70">No scenarios yet. An agent is certified only once every scenario passes.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs2 text-silver/70">
              <tr>
                <th scope="col" className="py-1 pr-3 font-medium">Scenario</th>
                <th scope="col" className="py-1 pr-3 font-medium">Input</th>
                <th scope="col" className="py-1 pr-3 font-medium">Expected</th>
                <th scope="col" className="py-1 pr-3 font-medium">Latest run</th>
                {canManage && (
                  <th scope="col" className="py-1 font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-navy-secondary align-top">
              {rows.map((s) => (
                <tr key={s.id}>
                  <td className="py-1.5 pr-3 font-medium text-white">{s.name}</td>
                  <td className="max-w-[16rem] py-1.5 pr-3">
                    <span className="block truncate text-xs text-silver" title={compactJson(s.input)}>
                      {describeScenarioInput(s.input)}
                    </span>
                  </td>
                  <td className="max-w-[16rem] py-1.5 pr-3">
                    <span className="block truncate text-xs text-silver" title={s.expected.output !== undefined ? compactJson(s.expected.output) : (s.expected.allowedActions ?? []).join(', ')}>
                      {describeScenarioExpected(s.expected)}
                    </span>
                  </td>
                  <td className="py-1.5 pr-3">
                    {s.latest ? (
                      <span className="flex flex-col gap-0.5">
                        <span>
                          <Badge variant={s.latest.passed ? 'success' : 'destructive'} size="sm">
                            {s.latest.passed ? 'Pass' : 'Fail'}
                          </Badge>
                        </span>
                        {s.latest.reason && <span className="text-xs2 text-silver">{s.latest.reason}</span>}
                        <span className="text-xs2 text-silver/70">
                          {fmtDateTime(s.latest.ranAt)} · {s.latest.ranBy ? s.latest.ranBy.name : 'the agent'}
                        </span>
                      </span>
                    ) : (
                      <span className="text-xs2 text-silver/60">Not run under {cert ? versionLabel(cert.modelVersion) : 'this version'}</span>
                    )}
                  </td>
                  {canManage && (
                    <td className="py-1.5 text-right">
                      <Button size="sm" variant="ghost" onClick={() => remove(s)} disabled={removing === s.id} aria-label={`Delete ${s.name}`}>
                        {removing === s.id ? 'Deleting…' : 'Delete'}
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Add one. */}
      {canManage && (
        <form
          className="space-y-3 rounded-md border border-navy-secondary p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <p className="text-sm font-medium text-white">Add scenario</p>
          <Field label="Name" required error={touched && !nameValid ? 'At least 2 characters.' : undefined}>
            {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={160} />}
          </Field>
          <Field label="Input (JSON)" required hint='What the agent is given, e.g. {"text": "when do I work tomorrow?"}' error={touched && 'error' in inputParsed ? inputParsed.error : undefined}>
            {(p) => <Textarea {...p} value={input} onChange={(e) => setInput(e.target.value)} rows={2} className="font-mono text-xs" spellCheck={false} />}
          </Field>
          <Field label="Expected">
            {(p) => (
              <Select {...p} value={mode} onChange={(e) => setMode(e.target.value as 'output' | 'actions')}>
                <option value="output">Output (JSON, compared whole)</option>
                <option value="actions">Allowed actions (every action taken must be listed)</option>
              </Select>
            )}
          </Field>
          {mode === 'output' ? (
            <Field label="Expected output (JSON)" required error={touched && 'error' in outputParsed ? outputParsed.error : undefined}>
              {(p) => <Textarea {...p} value={expectedOutput} onChange={(e) => setExpectedOutput(e.target.value)} rows={2} className="font-mono text-xs" spellCheck={false} />}
            </Field>
          ) : (
            <Field label="Allowed actions" required hint="Comma-separated, e.g. schedule.read, message.reply" error={touched && actionsList.length === 0 ? 'List at least one action.' : undefined}>
              {(p) => <Input {...p} value={allowedActions} onChange={(e) => setAllowedActions(e.target.value)} maxLength={2000} />}
            </Field>
          )}
          <div className="flex justify-end">
            <Button type="submit" variant="secondary" disabled={adding || (touched && !formValid) || !formDirty}>
              {adding ? 'Adding…' : 'Add scenario'}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

/* ---------------------------------------------------------- scorecard */

const SCORECARD_WINDOWS = [7, 30] as const;

/** Money inside a MetricCard: the card's display serif is for counts; money reads in heavy sans. */
function MoneyValue({ cents }: { cents: number | null }) {
  if (cents === null) return <span className="font-sans text-2xl font-semibold text-silver/60">—</span>;
  return <span className="font-sans text-2xl font-semibold tabular-nums">{fmtMoney(cents / 100)}</span>;
}

export function ScorecardSection({ agent, canManage, onChanged }: { agent: AgentDetail; canManage: boolean; onChanged: () => Promise<unknown> }) {
  const [days, setDays] = useState<number>(7);
  const scorecard = useQuery({
    queryKey: ['agents', 'scorecard', agent.id, days],
    queryFn: () => getAgentScorecard(agent.id, days),
    // The registry already carries the trailing week; show it while the fresh read lands.
    placeholderData: days === 7 && agent.scorecard?.days === 7 ? agent.scorecard : undefined,
  });
  const s: AgentScorecard | undefined = scorecard.data;

  const drift = agent.drift;
  const [errorRate, setErrorRate] = useState(drift?.driftErrorRatePct === null || drift?.driftErrorRatePct === undefined ? '' : String(drift.driftErrorRatePct));
  const [costPerTask, setCostPerTask] = useState(drift?.driftCostPerTaskCents === null || drift?.driftCostPerTaskCents === undefined ? '' : (drift.driftCostPerTaskCents / 100).toFixed(2));
  const [savingDrift, setSavingDrift] = useState(false);

  const errorRateNum = errorRate === '' ? null : Number(errorRate);
  const costNum = costPerTask === '' ? null : Number(costPerTask);
  const driftValid = (errorRateNum === null || (Number.isInteger(errorRateNum) && errorRateNum >= 1 && errorRateNum <= 100)) && (costNum === null || (Number.isFinite(costNum) && costNum >= 0.01));
  const driftBaseline = `${drift?.driftErrorRatePct ?? ''}|${drift?.driftCostPerTaskCents ?? ''}`;
  const driftNow = `${errorRateNum ?? ''}|${costNum === null ? '' : Math.round(costNum * 100)}`;
  const driftDirty = driftBaseline !== driftNow;

  const saveDrift = async () => {
    if (!driftValid || !driftDirty) return;
    setSavingDrift(true);
    try {
      await updateAgentDrift(agent.id, {
        driftErrorRatePct: errorRateNum,
        driftCostPerTaskCents: costNum === null ? null : Math.round(costNum * 100),
      });
      toast.success('Thresholds saved.');
      await onChanged();
    } catch (err) {
      toast.error(errorMessage(err, 'Could not save the thresholds.'));
    } finally {
      setSavingDrift(false);
    }
  };

  const loading = scorecard.isLoading && !s;
  const dash = '—';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-silver">
          Trailing {days} days, from the trail, the queue and the spend records.
          {scorecard.isFetching && s ? ' Refreshing…' : ''}
        </p>
        <div role="group" aria-label="Scorecard window" className="flex gap-1">
          {SCORECARD_WINDOWS.map((d) => (
            <Button key={d} size="xs" variant={days === d ? 'secondary' : 'ghost'} aria-pressed={days === d} onClick={() => setDays(d)}>
              {d} days
            </Button>
          ))}
        </div>
      </div>
      {scorecard.error && <QueryError what="the scorecard" query={scorecard} />}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <MetricCard label="Tasks completed" value={loading || !s ? dash : String(s.tasksCompleted)} hint={s ? `${s.errors} ${s.errors === 1 ? 'error' : 'errors'}` : undefined} />
        <MetricCard
          label="Error rate"
          value={loading || !s ? dash : s.errorRatePct === null ? dash : fmtPercent(s.errorRatePct, { decimals: 0 })}
          accent={Boolean(s && drift?.driftErrorRatePct !== null && drift?.driftErrorRatePct !== undefined && s.errorRatePct !== null && s.errorRatePct >= drift.driftErrorRatePct)}
          hint={s?.errorRatePct === null ? 'Nothing to measure' : 'Errors over tasks and errors'}
        />
        <MetricCard label="Exceptions escalated" value={loading || !s ? dash : String(s.exceptionsEscalated)} hint="Handed to a person" />
        <MetricCard label="Approvals" value={loading || !s ? dash : String(s.approvalsRequested)} hint={s ? `${s.approvalsRejected} rejected` : undefined} />
        <MetricCard label="Spend" value={loading || !s ? dash : <MoneyValue cents={s.spendCents} />} />
        <MetricCard
          label="Cost per task"
          value={loading || !s ? dash : <MoneyValue cents={s.costPerTaskCents} />}
          accent={Boolean(s && drift?.driftCostPerTaskCents !== null && drift?.driftCostPerTaskCents !== undefined && s.costPerTaskCents !== null && s.costPerTaskCents >= drift.driftCostPerTaskCents)}
          hint={s?.costPerTaskCents === null ? 'No completed tasks' : undefined}
        />
      </div>

      {/* Drift thresholds. */}
      <form
        className="space-y-3 rounded-md border border-navy-secondary p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void saveDrift();
        }}
      >
        <div>
          <p className="text-sm font-medium text-white">Drift thresholds</p>
          <p className="text-xs2 text-silver/70">A daily look at the trailing week. The owner is alerted when either line is crossed. Blank = not watched.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-3 sm:items-end">
          <Field label="Error rate (%)" hint="1–100">
            {(p) => <Input {...p} type="number" inputMode="numeric" min={1} max={100} step={1} value={errorRate} onChange={(e) => setErrorRate(e.target.value)} placeholder="Not watched" disabled={!canManage} />}
          </Field>
          <Field label="Cost per task ($)">
            {(p) => <Input {...p} type="number" inputMode="decimal" min={0.01} step="0.01" value={costPerTask} onChange={(e) => setCostPerTask(e.target.value)} placeholder="Not watched" disabled={!canManage} />}
          </Field>
          <Field label="Last alert">{(p) => <Input {...p} value={drift?.lastDriftAlertAt ? fmtDateTime(drift.lastDriftAlertAt) : 'Never'} readOnly />}</Field>
        </div>
        {canManage && (
          <div className="flex justify-end">
            <Button type="submit" variant="secondary" disabled={!driftValid || !driftDirty || savingDrift}>
              {savingDrift ? 'Saving…' : 'Save thresholds'}
            </Button>
          </div>
        )}
      </form>
    </div>
  );
}

/* -------------------------------------------------------- credentials */

export function CredentialsSection({ agent, canManage, onChanged }: { agent: AgentDetail; canManage: boolean; onChanged: () => Promise<unknown> }) {
  const prompt = usePrompt();
  const [ttl, setTtl] = useState(24);
  const [issuing, setIssuing] = useState(false);
  const [issued, setIssued] = useState<{ plaintext: string; last4: string; expiresAt: string } | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const issue = async () => {
    setIssuing(true);
    try {
      const r = await issueAgentCredential(agent.id, { ttlHours: ttl });
      setIssued(r);
      toast.success('Credential issued.');
      await onChanged();
    } catch (err) {
      toast.error(errorMessage(err, 'Could not issue a credential.'));
    } finally {
      setIssuing(false);
    }
  };

  const revoke = async (credentialId: string, last4: string) => {
    const reason = await prompt({
      title: `Revoke credential …${last4}?`,
      description: 'The agent loses access the moment this is saved.',
      confirmLabel: 'Revoke',
      destructive: true,
      reasonLabel: 'Reason',
      reasonMaxLength: 200,
      required: false,
    });
    if (reason === null) return;
    setRevoking(credentialId);
    try {
      await revokeAgentCredential(agent.id, credentialId, reason.trim() || undefined);
      toast.success('Revoked.');
      await onChanged();
    } catch (err) {
      toast.error(errorMessage(err, 'Could not revoke the credential.'));
    } finally {
      setRevoking(null);
    }
  };

  return (
    <div className="space-y-4">
      {issued && (
        <div className="space-y-2 rounded-md border border-warning/40 bg-warning/10 p-3" role="status">
          <p className="text-sm font-medium text-warning">Copy this credential now. It will not be shown again.</p>
          <p className="text-xs2 text-silver">
            Ends in …{issued.last4} · expires {fmtDateTime(issued.expiresAt)}. The agent sends it as a bearer token to the agent API. It is stored nowhere else: only a hash is kept, so a lost credential is revoked and reissued, never recovered.
          </p>
          <div className="break-all rounded-md border border-navy-secondary bg-navy-secondary/40 p-3 font-mono text-xs text-white" data-testid="issued-credential">
            {issued.plaintext}
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(issued.plaintext);
                toast.success('Copied to clipboard.');
              }}
            >
              <Copy className="h-4 w-4" aria-hidden="true" /> Copy
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setIssued(null)}>
              I've saved it
            </Button>
          </div>
        </div>
      )}

      {canManage && !issued && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[10rem]">
            <Field label="Valid for">
              {(p) => (
                <Select {...p} value={String(ttl)} onChange={(e) => setTtl(Number(e.target.value))}>
                  {TTL_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          <Button type="button" variant="secondary" onClick={issue} disabled={issuing || agent.status === 'OFFBOARDED'}>
            {issuing ? 'Issuing…' : 'Issue credential'}
          </Button>
        </div>
      )}

      {agent.credentials.length === 0 ? (
        <p className="text-sm text-silver/70">No credentials yet.</p>
      ) : (
        <ul className="divide-y divide-navy-secondary rounded-md border border-navy-secondary text-sm">
          {agent.credentials.map((c) => {
            const live = c.state === 'ACTIVE' || c.state === 'ROTATING';
            return (
              <li key={c.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                <span className="font-mono text-white">…{c.last4}</span>
                <Badge variant={CREDENTIAL_VARIANT[c.state]} size="sm">
                  {CREDENTIAL_STATE_LABELS[c.state]}
                </Badge>
                <span className="min-w-0 flex-1 text-xs2 text-silver/70">
                  Issued {fmtDateTime(c.issuedAt)}
                  {c.issuedBy ? ` by ${c.issuedBy.name}` : ''} · expires {fmtDateTime(c.expiresAt)} · last used {c.lastUsedAt ? fmtRelativeDate(c.lastUsedAt) : 'never'}
                  {c.revokedAt ? ` · revoked ${fmtDateTime(c.revokedAt)}${c.revokedReason ? ` — ${c.revokedReason}` : ''}` : ''}
                </span>
                {canManage && live && (
                  <Button size="sm" variant="secondary" onClick={() => revoke(c.id, c.last4)} disabled={revoking === c.id}>
                    {revoking === c.id ? 'Revoking…' : 'Revoke'}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ----------------------------------------------------------- requests */

/** Everything this agent proposed that needed a person: gated actions and what became of them. */
export function RequestsSection({ approvals }: { approvals: AgentApprovalSummary[] }) {
  if (approvals.length === 0) return <p className="text-sm text-silver/70">This agent has not proposed anything that needed a person.</p>;
  return (
    <ul className="divide-y divide-navy-secondary rounded-md border border-navy-secondary text-sm">
      {approvals.map((a) => (
        <li key={a.id} className="space-y-1 px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-white">{AGENT_GATED_ACTION_LABELS[a.action]}</span>
            <Badge variant={APPROVAL_VARIANT[a.status]} size="sm">
              {AGENT_APPROVAL_STATUS_LABELS[a.status]}
            </Badge>
            <span className="text-xs2 text-silver/70">{fmtDateTime(a.requestedAt)}</span>
          </div>
          <p className="text-silver">{a.summary}</p>
          {a.decidedBy && (
            <p className="text-xs2 text-silver/70">
              {AGENT_APPROVAL_STATUS_LABELS[a.status === 'CONSUMED' ? 'APPROVED' : a.status]} by {a.decidedBy.name} {fmtDateTime(a.decidedAt)}
              {a.decisionNote ? ` — ${a.decisionNote}` : ''}
              {a.consumedAt ? ` · carried out ${fmtDateTime(a.consumedAt)}` : ''}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

/* -------------------------------------------------------------- spend */

export function SpendSection({ agent, canManage, onChanged }: { agent: AgentDetail; canManage: boolean; onChanged: () => Promise<unknown> }) {
  const [amount, setAmount] = useState('');
  const [taskRef, setTaskRef] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const dollars = Number(amount);
  const valid = amount !== '' && Number.isFinite(dollars) && dollars >= 0;

  const submit = async () => {
    if (!valid) return;
    setSaving(true);
    try {
      await recordAgentSpend(agent.id, {
        amountCents: Math.round(dollars * 100),
        taskRef: taskRef.trim() || undefined,
        note: note.trim() || undefined,
      });
      toast.success('Spend recorded.');
      setAmount('');
      setTaskRef('');
      setNote('');
      await onChanged();
    } catch (err) {
      toast.error(errorMessage(err, 'Could not record the spend.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm">
        This month: <Money cents={agent.spendThisMonthCents} className="text-white" />
        {agent.profile.spendCapCents !== null && (
          <span className="text-silver/70">
            {' '}of <Money cents={agent.profile.spendCapCents} /> cap
          </span>
        )}
      </p>
      {canManage && (
        <form
          className="grid gap-3 sm:grid-cols-[8rem_1fr_1fr_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Field label="Amount ($)" required>
            {(p) => <Input {...p} type="number" inputMode="decimal" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />}
          </Field>
          <Field label="Task ref">{(p) => <Input {...p} value={taskRef} onChange={(e) => setTaskRef(e.target.value)} maxLength={120} />}</Field>
          <Field label="Note">{(p) => <Input {...p} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />}</Field>
          <Button type="submit" variant="secondary" disabled={!valid || saving}>
            {saving ? 'Recording…' : 'Record spend'}
          </Button>
        </form>
      )}
      {agent.spend.length === 0 ? (
        <p className="text-sm text-silver/70">No spend recorded.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs2 text-silver/70">
            <tr>
              <th scope="col" className="py-1 pr-3 font-medium">When</th>
              <th scope="col" className="py-1 pr-3 font-medium">Task</th>
              <th scope="col" className="py-1 pr-3 font-medium">Note</th>
              <th scope="col" className="py-1 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-navy-secondary">
            {agent.spend.map((s) => (
              <tr key={s.id}>
                <td className="py-1.5 pr-3 whitespace-nowrap">{fmtDate(s.occurredAt)}</td>
                <td className="py-1.5 pr-3 font-mono text-xs">{s.taskRef ?? '—'}</td>
                <td className="py-1.5 pr-3 text-silver">{s.note ?? '—'}</td>
                <td className="py-1.5 text-right">
                  <Money cents={s.amountCents} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- trail */

/** Every action an agent's trail can carry (apps/api, `action: 'agent.…'`), in words. */
export const AGENT_TRAIL_ACTION_LABELS: Record<string, string> = {
  'agent.registered': 'Registered',
  'agent.updated': 'Profile updated',
  'agent.built_in_ensured': 'Built-in agents registered',
  'agent.scopes_added': 'Scopes added',
  'agent.credential.issued': 'Credential issued',
  'agent.credential.revoked': 'Credential revoked',
  'agent.credentials.measured': 'Credentials measured',
  'agent.spend.recorded': 'Spend recorded',
  'agent.approval.requested': 'Asked for approval',
  'agent.approval.approved': 'Approval decided',
  'agent.denied': 'Call refused',
  'agent.suspended': 'Suspended',
  'agent.resumed': 'Resumed',
  'agent.all_suspended': 'Every agent suspended',
  'agent.all_resumed': 'Every agent resumed',
  'agent.tenant_suspended': 'The organization’s agents suspended',
  'agent.tenant_resumed': 'The organization’s agents resumed',
  'agent.certified': 'Certified',
  'agent.recertification_required': 'Recertification required',
  'agent.scenario.added': 'Scenario added',
  'agent.scenario.removed': 'Scenario removed',
  'agent.drift.configured': 'Drift thresholds set',
  'agent.drift_alert': 'Drift alert raised',
  'agent.capability_suspended': 'Capability suspended',
  'agent.capability_resumed': 'Capability resumed',
  'agent.proposal_created': 'Proposal made',
  'agent.proposal_superseded': 'Proposal superseded',
  'agent.gate_policy_created': 'Gate policy added',
  'agent.gate_policy_ended': 'Gate policy ended',
  'agent.decision_profile_saved': 'Decision profile saved',
  'agent.bias_audit_added': 'Bias audit recorded',
  'agent.message.sent': 'Message sent',
  'agent.whatsapp.reply': 'Replied on WhatsApp',
  'agent.app.reply': 'Replied in the app',
  'agent.app.handoff': 'Handed to a person',
  'agent.attendance.asked': 'Asked about tomorrow’s attendance',
  'agent.coverage.forecast': 'Coverage forecast',
  'agent.document_chase.sent': 'Document reminder sent',
  'agent.document_chase.escalated': 'Document reminder escalated',
  'agent.document_chase.resolved': 'Document chase closed',
  'agent.incident.chased': 'Incident followed up',
  'agent.schedule_repair.no_candidate': 'No one found for a shift',
  'agent.me': 'Identified itself',
  'agent.nothing': 'Nothing to do',
  'hugo.asked': 'Asked the assistant',
};

/** A trail action in words: the map, else the code read out ("agent.foo_bar" → "Foo bar"). */
export function trailActionLabel(action: string): string {
  const known = AGENT_TRAIL_ACTION_LABELS[action];
  if (known) return known;
  const tail = action.replace(/^(agent|hugo)\./, '').replace(/[._]+/g, ' ').trim();
  return tail ? tail.charAt(0).toUpperCase() + tail.slice(1) : action;
}

/** The entity a trail row touched, by name; the id stays in the title for whoever needs it. */
export function trailEntityName(t: AgentDetail['trail'][number], agent: Pick<AgentDetail, 'name' | 'approvals'>): string {
  const meta = t.metadata ?? {};
  switch (t.entityType) {
    case 'Worker':
    case 'AgentProfile':
      return agent.name;
    case 'AgentCredential':
      return typeof meta.last4 === 'string' ? `Credential …${meta.last4}` : 'A credential';
    case 'AgentApprovalRequest': {
      const a = agent.approvals.find((x) => x.id === t.entityId);
      return a ? `Proposal: ${a.summary}` : 'A proposal';
    }
    case 'AgentProposal':
      return typeof meta.capability === 'string' ? `Proposal: ${capabilityDef(meta.capability)?.label ?? meta.capability}` : 'A proposal';
    case 'AgentCapability':
      return typeof meta.key === 'string' ? (capabilityDef(meta.key)?.label ?? meta.key) : 'A capability';
    case 'AgentScenario':
      return typeof meta.name === 'string' ? `Scenario: ${meta.name}` : 'A scenario';
    case 'Associate':
      return typeof meta.name === 'string' ? meta.name : 'A person';
    case 'AgentSpend':
      return 'Spend';
    default:
      return t.entityType.replace(/([a-z])([A-Z])/g, '$1 $2');
  }
}

/** The few metadata keys worth a glance; the rest stays in the audit log. */
function summariseMeta(meta: Record<string, unknown> | null): string {
  if (!meta) return '';
  const parts: string[] = [];
  if (Array.isArray(meta.scopes)) parts.push(`scopes: ${(meta.scopes as string[]).map((s) => SCOPE_LABEL.get(s) ?? s).join(', ')}`);
  if (Array.isArray(meta.added)) parts.push(`added: ${(meta.added as string[]).map((s) => SCOPE_LABEL.get(s) ?? s).join(', ')}`);
  if (typeof meta.status === 'string') parts.push(`status: ${WORKER_STATUS_LABELS[meta.status as WorkerStatus]?.toLowerCase() ?? meta.status.toLowerCase()}`);
  if (typeof meta.modelVersion === 'string') parts.push(`version ${versionLabel(meta.modelVersion)}`);
  if (typeof meta.reason === 'string' && meta.reason) parts.push(meta.reason);
  if (typeof meta.amountCents === 'number') parts.push(fmtMoney(meta.amountCents / 100));
  return parts.join(' · ');
}

export function TrailSection({ agent }: { agent: AgentDetail }) {
  if (agent.trail.length === 0) return <p className="text-sm text-silver/70">Nothing in the trail yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs2 text-silver/70">
          <tr>
            <th scope="col" className="py-1 pr-3 font-medium">When</th>
            <th scope="col" className="py-1 pr-3 font-medium">What happened</th>
            <th scope="col" className="py-1 pr-3 font-medium">To</th>
            <th scope="col" className="py-1 font-medium">Details</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-navy-secondary">
          {agent.trail.map((t) => (
            <tr key={t.id}>
              <td className="py-1.5 pr-3 whitespace-nowrap">{fmtDateTime(t.createdAt)}</td>
              <td className="py-1.5 pr-3 text-ink" title={t.action}>{trailActionLabel(t.action)}</td>
              <td className="py-1.5 pr-3 text-xs2 text-silver/70" title={`${t.entityType} ${t.entityId}`}>
                {trailEntityName(t, agent)}
              </td>
              <td className="py-1.5 text-silver">{summariseMeta(t.metadata) || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs2 text-silver/70">The trail is the audit log for this agent and is read-only.</p>
    </div>
  );
}
