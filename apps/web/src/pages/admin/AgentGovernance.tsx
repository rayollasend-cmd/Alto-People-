import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { PLATFORM_OPERATOR_TENANT_ID, WORKER_STATUS_LABELS, capabilityDef, type AgentControlState, type AgentSummary } from '@alto-people/shared';
import { SettingsSection } from '@/components/templates';
import { AgentGlyph } from '@/components/agents/AgentGlyph';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryError } from '@/components/ui/QueryError';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { apiFetch } from '@/lib/api';
import { useAuth, useTenant } from '@/lib/auth';
import { usePrompt } from '@/lib/confirm';
import { fmtDateTime } from '@/lib/format';
import { getAgentControl, getPlatformControl, listAgents, listDecisionRecords, resumeAllAgents, resumePlatformAgents, suspendPlatformAgents } from '@/lib/agentsApi';
import { AgentGatesPanel } from './AgentGatesPanel';
import { McpCatalogPreview } from './McpCatalogPreview';
import { OwnerPerson, STATUS_VARIANT, SuspendAllDialog, certificationLabel, errorMessage, familyLabel, versionLabel } from './AgentRegistryAdmin';

/**
 * Settings & trust › Agents & gates: how the organization governs its
 * agents, in one Settings page of sections that are always open. The
 * agents themselves are a People page (/agents); this is what an auditor
 * or an IT admin checks about all of them at once — the gates (who approves
 * what), certification and credentials across agents, the MCP tools the
 * server offers, the decision record, and the two switches: the
 * organization's, and the platform's for the operator alone. Danger sits
 * last, as the template says.
 */
export function AgentGovernance() {
  const { can } = useAuth();
  const tenant = useTenant();
  const canManage = can('manage:org');
  const isOperator = tenant.id === PLATFORM_OPERATOR_TENANT_ID;
  const qc = useQueryClient();
  const { hash } = useLocation();

  const registry = useQuery({ queryKey: ['agents', 'list'], queryFn: listAgents });
  const gates = useQuery({ queryKey: ['agents', 'gates'], queryFn: () => apiFetch<{ policies: Array<{ inForce: boolean }> }>('/agents/gates') });
  const controlQuery = useQuery({ queryKey: ['agents', 'control'], queryFn: getAgentControl, enabled: registry.data !== undefined && registry.data.control === undefined });
  const control: AgentControlState | undefined = registry.data?.control ?? controlQuery.data;
  const agents = registry.data?.agents ?? [];
  const refetchAll = () => qc.invalidateQueries({ queryKey: ['agents'] });

  // A link into one section (#gates, #platform-switch) lands on it once the page has rendered.
  useEffect(() => {
    if (!hash) return;
    const el = document.getElementById(hash.slice(1));
    el?.scrollIntoView({ block: 'start' });
  }, [hash, registry.data]);

  const inForce = (gates.data?.policies ?? []).filter((p) => p.inForce).length;

  return (
    <div className="space-y-6" data-template="settings">
      <PageHeader
        title="Agents & gates"
        subtitle="Who approves what, whether each agent is certified for the version it runs, the credentials it holds, the tools the MCP server offers, the decisions recorded about people, and the switch that stops every agent."
        breadcrumbs={[{ label: 'Settings & trust', to: '/admin' }, { label: 'Agents & gates' }]}
        secondaryActions={
          <Button asChild variant="ghost" size="sm">
            <Link to="/agents">Open the agents</Link>
          </Button>
        }
      />

      {registry.error && <QueryError what="the agents" query={registry} />}

      <SettingsSection
        id="gates"
        title="Gates: who approves what"
        description="The platform always puts pay, separations, client messages, exports, shift assignments and HR cases in front of a person. Your own policies add approvals above that floor and name who decides."
        status={gates.isLoading ? undefined : <Badge variant={inForce > 0 ? 'accent' : 'outline'} size="sm" withDot={false}>{inForce === 1 ? '1 policy in force' : `${inForce} policies in force`}</Badge>}
      >
        <AgentGatesPanel agents={agents.map((a) => ({ id: a.id, name: a.name }))} canManage={canManage} />
      </SettingsSection>

      <CertificationAcross agents={agents} loading={registry.isLoading} />

      <CredentialsAcross agents={agents} loading={registry.isLoading} />

      <SettingsSection
        id="mcp"
        title="MCP tools"
        description="What an agent connecting over MCP can call here, generated from the capabilities this organization has switched on. Each agent sees only the tools it holds."
      >
        <McpCatalogPreview />
      </SettingsSection>

      <DecisionRecordAcross />

      <OrganizationSwitch control={control} canManage={canManage} agents={registry.data ? registry.data.counts.ACTIVE + registry.data.counts.ONBOARDING : agents.length} onChanged={refetchAll} />

      {isOperator && <PlatformSwitch initial={registry.data?.platformControl} canManage={canManage} onChanged={refetchAll} />}
    </div>
  );
}

/* ------------------------------------------------------ certification */

/**
 * The same reading the record page and the Trust Center use: certified
 * means certified for the model version the agent runs now. An agent that
 * was running when it was registered is attested for that version with no
 * scenario yet; one whose version moved past its certificate must recertify.
 */
function CertificationAcross({ agents, loading }: { agents: AgentSummary[]; loading: boolean }) {
  const certified = agents.filter((a) => a.certification?.current).length;
  const attested = agents.filter((a) => a.certification?.current && a.certification.scenarios === 0).length;
  return (
    <SettingsSection
      id="certification"
      title="Certification"
      description="Every agent must pass its scenarios under the model version it runs before it leaves onboarding, and again whenever that version changes."
      status={loading ? undefined : <Badge variant={certified === agents.length && agents.length > 0 ? 'success' : 'pending'} size="sm" withDot={false}>{`${certified} of ${agents.length} certified for the version they run`}</Badge>}
    >
      {loading ? (
        <SkeletonRows count={3} />
      ) : agents.length === 0 ? (
        <EmptyState title="No agents registered" description="Register an agent on the Agents page; its certification shows here." />
      ) : (
        <ul className="divide-y divide-line text-sm" aria-label="Certification by agent">
          {agents.map((a) => {
            const c = a.certification;
            const l = certificationLabel(c, a.status);
            return (
              <li key={a.id} className="flex flex-wrap items-center gap-3 py-2">
                <AgentGlyph family={a.profile.family} status={a.status} size="sm" />
                <span className="min-w-0 flex-1">
                  <Link to={`/agents/${a.id}?tab=certification`} className="font-medium text-ink hover:text-accent">
                    {a.name}
                  </Link>
                  <span className="block text-xs text-ink-muted">
                    {familyLabel(a.profile.family) || 'Not yet placed'} · runs {c ? versionLabel(c.modelVersion) : versionLabel(a.profile.modelVersion)}
                    {c && c.scenarios > 0 ? ` · ${c.passing} of ${c.scenarios} scenarios passing` : c?.current ? ' · attested at registration, no scenario yet' : ' · no scenario yet'}
                  </span>
                </span>
                <Badge variant={l.variant} size="sm" withDot={false}>
                  {l.text}
                </Badge>
              </li>
            );
          })}
        </ul>
      )}
      {attested > 0 && (
        <p className="text-xs2 text-ink-muted">
          {attested === 1 ? '1 agent counts' : `${attested} agents count`} as certified because {attested === 1 ? 'it was' : 'they were'} already running when registered. Add scenarios on {attested === 1 ? 'its' : 'their'} Certification tab to prove it.
        </p>
      )}
    </SettingsSection>
  );
}

/* -------------------------------------------------------- credentials */

function CredentialsAcross({ agents, loading }: { agents: AgentSummary[]; loading: boolean }) {
  const live = agents.reduce((n, a) => n + a.activeCredentials, 0);
  const holders = agents.filter((a) => a.activeCredentials > 0);
  return (
    <SettingsSection
      id="credentials"
      title="Credentials"
      description="Short-lived bearer tokens an agent presents to the agent API. Each is shown once when issued and stored nowhere else; suspending an agent revokes every one it holds."
      status={loading ? undefined : <Badge variant={live > 0 ? 'accent' : 'outline'} size="sm" withDot={false}>{live === 1 ? '1 live credential' : `${live} live credentials`}</Badge>}
    >
      {loading ? (
        <SkeletonRows count={2} />
      ) : holders.length === 0 ? (
        <EmptyState title="No live credentials" description="Issue one from an agent's Credentials tab when it is ready to call the agent API." />
      ) : (
        <ul className="divide-y divide-line text-sm" aria-label="Credentials by agent">
          {holders.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-3 py-2">
              <AgentGlyph family={a.profile.family} status={a.status} size="sm" />
              <span className="min-w-0 flex-1">
                <Link to={`/agents/${a.id}?tab=credentials`} className="font-medium text-ink hover:text-accent">
                  {a.name}
                </Link>
                <span className="block text-xs text-ink-muted">
                  <Badge variant={STATUS_VARIANT[a.status]} size="sm" withDot={false}>
                    {WORKER_STATUS_LABELS[a.status]}
                  </Badge>
                </span>
              </span>
              <span className="flex items-center gap-2 text-xs text-ink-muted">
                <span>Owner</span>
                <OwnerPerson owner={a.owner} />
              </span>
              <span className="tabular-nums text-ink">{a.activeCredentials === 1 ? '1 live' : `${a.activeCredentials} live`}</span>
            </li>
          ))}
        </ul>
      )}
    </SettingsSection>
  );
}

/* ---------------------------------------------------- decision record */

const OUTCOME_VARIANT = { FAVORABLE: 'success', ADVERSE: 'destructive', NONE: 'default' } as const;
const OUTCOME_LABEL = { FAVORABLE: 'Favorable', ADVERSE: 'Adverse', NONE: 'No outcome' } as const;
const decisionWords = (t: string) => t.charAt(0) + t.slice(1).toLowerCase().replace(/_/g, ' ');

function DecisionRecordAcross() {
  const q = useQuery({ queryKey: ['agents', 'decision-records'], queryFn: listDecisionRecords });
  const rows = q.data?.decisions ?? [];
  return (
    <SettingsSection
      id="decision-record"
      title="Decision record"
      description="Every automated decision about a person this organization's agents recorded, newest first, with who decided and whether the person was told. Each agent's own record, its bias audits and the notice dates are on its Decision record tab."
      status={q.data ? <Badge variant="outline" size="sm" withDot={false}>{q.data.total === 1 ? '1 decision' : `${q.data.total} decisions`}</Badge> : undefined}
    >
      {q.isError ? (
        <QueryError what="the decision record" query={q} />
      ) : q.isLoading ? (
        <SkeletonRows count={3} />
      ) : rows.length === 0 ? (
        <EmptyState title="No decisions recorded" description="A row appears the first time an agent's capability decides something about a person." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs2 text-ink-muted">
              <tr>
                <th scope="col" className="py-1 pr-3 font-medium">When</th>
                <th scope="col" className="py-1 pr-3 font-medium">Agent</th>
                <th scope="col" className="py-1 pr-3 font-medium">Decision</th>
                <th scope="col" className="py-1 pr-3 font-medium">About</th>
                <th scope="col" className="py-1 pr-3 font-medium">Outcome</th>
                <th scope="col" className="py-1 font-medium">Decided by a person</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="py-1.5 pr-3 whitespace-nowrap">{fmtDateTime(r.at)}</td>
                  <td className="py-1.5 pr-3">
                    <Link to={`/agents/${r.agentId}?tab=record`} className="text-ink hover:text-accent">
                      {r.agentName}
                    </Link>
                  </td>
                  <td className="py-1.5 pr-3">
                    <span className="block text-ink">{decisionWords(r.decisionType)}</span>
                    <span className="block text-xs text-ink-muted">
                      {capabilityDef(r.capabilityKey)?.label ?? r.capabilityKey} · {r.summary}
                    </span>
                  </td>
                  <td className="py-1.5 pr-3">
                    {r.subjectAssociateId ? (
                      <Link to={`/people/${r.subjectAssociateId}`} className="text-ink hover:text-accent">
                        {r.subject ?? 'A person'}
                      </Link>
                    ) : (
                      r.subject ?? '—'
                    )}
                  </td>
                  <td className="py-1.5 pr-3">
                    <Badge variant={OUTCOME_VARIANT[r.outcome] ?? 'default'} size="sm" withDot={false}>
                      {OUTCOME_LABEL[r.outcome] ?? r.outcome}
                    </Badge>
                  </td>
                  <td className="py-1.5 text-xs text-ink-muted">
                    {r.humanDecidedAt ? fmtDateTime(r.humanDecidedAt) : 'Not yet'}
                    {r.noticeGivenAt ? ' · person told' : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SettingsSection>
  );
}

/* -------------------------------------------------------- the switches */

function OrganizationSwitch({ control, canManage, agents, onChanged }: { control: AgentControlState | undefined; canManage: boolean; agents: number; onChanged: () => Promise<unknown> }) {
  const [suspending, setSuspending] = useState(false);
  const [resuming, setResuming] = useState(false);
  const on = Boolean(control?.allSuspendedAt);
  const resume = async () => {
    setResuming(true);
    try {
      await resumeAllAgents();
      toast.success('Agents resumed. No credential was restored — issue new ones per agent.');
      await onChanged();
    } catch (err) {
      toast.error(errorMessage(err, 'Could not resume the agents.'));
    } finally {
      setResuming(false);
    }
  };
  return (
    <SettingsSection
      id="kill-switch"
      danger
      title="Stop every agent"
      description="This organization's switch. When it is on, every credential is revoked and every agent call is refused until an admin lifts it; lifting it restores no credential."
      status={control ? <Badge variant={on ? 'destructive' : 'success'} size="sm">{on ? 'On' : 'Off'}</Badge> : undefined}
      action={
        canManage && control ? (
          on ? (
            <Button size="sm" variant="secondary" onClick={resume} disabled={resuming}>
              {resuming ? 'Resuming…' : 'Resume all agents'}
            </Button>
          ) : (
            <Button size="sm" variant="destructive" onClick={() => setSuspending(true)}>
              <ShieldAlert className="h-4 w-4" aria-hidden="true" /> Suspend all agents
            </Button>
          )
        ) : undefined
      }
    >
      {on && control ? (
        <p className="text-sm text-ink" role="alert">
          On since {fmtDateTime(control.allSuspendedAt!)}
          {control.suspendedBy ? ` by ${control.suspendedBy.name}` : ''}
          {control.reason ? ` — ${control.reason}` : ''}.
        </p>
      ) : (
        <p className="text-sm text-ink-muted">Off. {agents === 1 ? '1 agent is' : `${agents} agents are`} live or onboarding.</p>
      )}
      {suspending && (
        <SuspendAllDialog
          agents={agents}
          onClose={() => setSuspending(false)}
          onSuspended={async () => {
            setSuspending(false);
            await onChanged();
          }}
        />
      )}
    </SettingsSection>
  );
}

function PlatformSwitch({ initial, canManage, onChanged }: { initial: AgentControlState | undefined; canManage: boolean; onChanged: () => Promise<unknown> }) {
  const prompt = usePrompt();
  const [busy, setBusy] = useState(false);
  const q = useQuery({ queryKey: ['agents', 'platform-control'], queryFn: getPlatformControl, initialData: initial });
  const control = q.data;
  const on = Boolean(control?.allSuspendedAt);
  const suspend = async () => {
    const reason = await prompt({
      title: 'Stop every organization’s agents?',
      description: 'The platform switch revokes every credential on every tenant and refuses every agent call until it is lifted here. Lifting it restores no credential anywhere.',
      confirmLabel: 'Stop every agent',
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
      const r = await suspendPlatformAgents(reason.trim());
      toast.success(`Every organization’s agents stopped. ${r.revoked === 1 ? '1 credential' : `${r.revoked} credentials`} revoked.`);
      await Promise.all([q.refetch(), onChanged()]);
    } catch (err) {
      toast.error(errorMessage(err, 'Could not throw the platform switch.'));
    } finally {
      setBusy(false);
    }
  };
  const resume = async () => {
    setBusy(true);
    try {
      await resumePlatformAgents();
      toast.success('The platform switch is off. No credential was restored.');
      await Promise.all([q.refetch(), onChanged()]);
    } catch (err) {
      toast.error(errorMessage(err, 'Could not lift the platform switch.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsSection
      id="platform-switch"
      danger
      title="Platform switch"
      description="The operator's switch over every organization on the platform. Thrown here, and lifted here alone; every organization's Agents page says when it is on."
      status={control ? <Badge variant={on ? 'destructive' : 'success'} size="sm">{on ? 'On' : 'Off'}</Badge> : undefined}
      action={
        canManage && control ? (
          on ? (
            <Button size="sm" variant="secondary" onClick={resume} disabled={busy}>
              {busy ? 'Lifting…' : 'Lift the platform switch'}
            </Button>
          ) : (
            <Button size="sm" variant="destructive" onClick={suspend} disabled={busy}>
              <ShieldAlert className="h-4 w-4" aria-hidden="true" /> {busy ? 'Stopping…' : 'Stop every organization’s agents'}
            </Button>
          )
        ) : undefined
      }
    >
      {q.isError ? (
        <QueryError what="the platform switch" query={q} />
      ) : !control ? (
        <SkeletonRows count={1} />
      ) : on ? (
        <p className="text-sm text-ink" role="alert" data-testid="platform-switch">
          On since {fmtDateTime(control.allSuspendedAt!)}
          {control.suspendedBy ? ` by ${control.suspendedBy.name}` : ''}
          {control.reason ? ` — ${control.reason}` : ''}.
        </p>
      ) : (
        <p className="text-sm text-ink-muted" data-testid="platform-switch">
          Off. Every organization's agents run under their own switch.
        </p>
      )}
    </SettingsSection>
  );
}
