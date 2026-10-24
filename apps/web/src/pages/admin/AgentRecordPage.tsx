import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, ShieldAlert } from '@/components/ui/icons';
import { toast } from 'sonner';
import { AGENT_ENVIRONMENT_LABELS, AGENT_SCOPES, WORKER_STATUS_LABELS, type AgentDetail } from '@alto-people/shared';
import { RecordTemplate } from '@/components/templates';
import type { PageAction } from '@/components/ui/PageHeader';
import { AgentGlyph } from '@/components/agents/AgentGlyph';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { MetricCard } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { QueryError } from '@/components/ui/QueryError';
import { Skeleton } from '@/components/ui/Skeleton';
import { useAuth } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
import { fmtDate, fmtMoney, fmtPercent } from '@/lib/format';
import { getAgent, listAgentCapabilities, updateAgent } from '@/lib/agentsApi';
import { AgentDecisionRecordTab, decisionRecordQuery } from '@/pages/admin/AgentDecisionRecordTab';
import {
  CapabilitiesSection,
  CertificationSection,
  CredentialsSection,
  KillSwitchRow,
  OwnerPerson,
  ProfileFields,
  RequestsSection,
  ScorecardSection,
  SpendSection,
  STATUS_VARIANT,
  TrailSection,
  errorMessage,
  familyLabel,
  formFromAgent,
  formValid,
  hoursLabel,
  limitsFromForm,
  modelLine,
  useSuspendAgent,
  versionLabel,
  type ProfileForm,
} from '@/pages/admin/AgentRegistryAdmin';

const TABS = ['profile', 'capabilities', 'credentials', 'certification', 'scorecard', 'requests', 'spend', 'record'] as const;
type TabKey = (typeof TABS)[number];

const SCOPE_LABEL = new Map<string, string>(AGENT_SCOPES.map((s) => [s.code, s.label]));

/**
 * An agent's record (UX upgrade, 2026-10-15): the Record template, like a
 * person's or a client's. The header is the agent's mark, name and status;
 * the subtitle says family, owner and status in words; the actions are
 * Edit (the profile becomes a form) and Suspend (destructive, confirmed);
 * the summary strip is the week's numbers; the tabs are the facets, with
 * counts where a count means something. `?tab=` is the open tab, so a
 * notification can land on Certification.
 */
export function AgentRecordPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const canManage = can('manage:org');
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [editing, setEditing] = useState(false);
  const detail = useQuery({ queryKey: ['agents', 'detail', id], queryFn: () => getAgent(id), enabled: id.length > 0 });
  // The counts on two tabs come from reads the tabs themselves make; one cache entry each.
  const capabilities = useQuery({ queryKey: ['agents', 'capabilities', id], queryFn: () => listAgentCapabilities(id), enabled: id.length > 0, select: (d) => d.capabilities });
  const decisions = useQuery({ ...decisionRecordQuery(id), enabled: id.length > 0 });
  const onChanged = async () => {
    await qc.invalidateQueries({ queryKey: ['agents'] });
  };
  const tabParam = searchParams.get('tab');
  const activeTab: TabKey = (TABS as readonly string[]).includes(tabParam ?? '') ? (tabParam as TabKey) : 'profile';
  const setTab = (key: string) => {
    const next = new URLSearchParams(searchParams);
    if (key === 'profile') next.delete('tab');
    else next.set('tab', key);
    setSearchParams(next, { replace: true });
  };
  // Leaving the Profile tab ends an edit; the form keeps nothing unsaved.
  useEffect(() => {
    if (activeTab !== 'profile') setEditing(false);
  }, [activeTab]);

  if (detail.error) {
    return (
      <div className="space-y-4">
        <QueryError what="this agent" query={detail} />
        <Button asChild variant="ghost" size="sm">
          <Link to="/agents">Back to the agents</Link>
        </Button>
      </div>
    );
  }
  const agent = detail.data;
  if (!agent) {
    return (
      <div className="space-y-4" aria-busy="true" aria-label="Loading the agent">
        <div className="flex items-center gap-4">
          <Skeleton className="h-14 w-14 rounded-xl" />
          <div className="space-y-2">
            <Skeleton className="h-7 w-56" />
            <Skeleton className="h-4 w-80" />
          </div>
        </div>
        <Skeleton className="h-24" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  return (
    <AgentRecord
      agent={agent}
      canManage={canManage}
      editing={editing}
      setEditing={setEditing}
      activeTab={activeTab}
      setTab={setTab}
      onChanged={onChanged}
      capabilitiesCount={capabilities.data?.length}
      decisionsCount={decisions.data?.decisions.length}
    />
  );
}

/** The loaded record: header, numbers, tabs and the trail beside them. */
function AgentRecord({
  agent,
  canManage,
  editing,
  setEditing,
  activeTab,
  setTab,
  onChanged,
  capabilitiesCount,
  decisionsCount,
}: {
  agent: AgentDetail;
  canManage: boolean;
  editing: boolean;
  setEditing: (v: boolean) => void;
  activeTab: TabKey;
  setTab: (key: string) => void;
  onChanged: () => Promise<unknown>;
  capabilitiesCount: number | undefined;
  decisionsCount: number | undefined;
}) {
  const { suspend, busy: suspending } = useSuspendAgent(agent, onChanged);
  const s = agent.scorecard;
  const liveCredentials = agent.credentials.filter((c) => c.state === 'ACTIVE' || c.state === 'ROTATING').length;
  const over =
    s?.errorRatePct !== null &&
    s?.errorRatePct !== undefined &&
    agent.drift?.driftErrorRatePct !== null &&
    agent.drift?.driftErrorRatePct !== undefined &&
    s.errorRatePct >= agent.drift.driftErrorRatePct;
  // A name, never an email address, in the subtitle (F500 G2).
  const ownerName = agent.owner ? agent.owner.name || 'an owner with no name on file' : 'no owner';
  const statusWords = WORKER_STATUS_LABELS[agent.status].toLowerCase();
  // Edit beside the title; Suspend (destructive) in "More", where its own
  // reason prompt is the confirm (F500 G2 — the Clients lesson).
  const actions: PageAction[] = [
    {
      key: 'edit',
      label: 'Edit',
      icon: Pencil,
      hidden: !canManage || editing,
      onSelect: () => {
        setTab('profile');
        setEditing(true);
      },
    },
    {
      key: 'suspend',
      label: suspending ? 'Suspending…' : 'Suspend',
      icon: ShieldAlert,
      destructive: true,
      loading: suspending,
      hidden: !canManage || agent.status === 'SUSPENDED' || agent.status === 'OFFBOARDED',
      hint: 'Revokes every credential at once',
      onSelect: () => void suspend(),
    },
  ];
  // A tab with nothing in it waits until there is something — unless the
  // reader can add the first one (a credential, a spend line) from it.
  const showEmpty = (n: number | undefined, addable: boolean) => n === undefined || n > 0 || (addable && canManage);

  return (
    <RecordTemplate
      identity={<AgentGlyph family={agent.profile.family} status={agent.status} size="lg" />}
      title={agent.name}
      status={
        <Badge variant={STATUS_VARIANT[agent.status]} size="sm">
          {WORKER_STATUS_LABELS[agent.status]}
        </Badge>
      }
      subtitle={`${familyLabel(agent.profile.family) || 'Not yet placed in a family'} · owned by ${ownerName} · ${statusWords}`}
      actions={actions}
      // The activity trail reads beside the tabs, not behind one of nine.
      aside={
        <section aria-labelledby="agent-trail-heading" className="space-y-2">
          <h2 id="agent-trail-heading" className="text-sm font-medium text-ink">
            Activity
          </h2>
          <TrailSection agent={agent} />
        </section>
      }
      summary={
        <div className="space-y-[var(--d-stack)]">
          <MetricStrip label="This agent's week">
            <MetricCard label="Tasks · 7 days" value={s ? String(s.tasksCompleted) : '—'} hint={s ? `${s.errors} errors · ${s.exceptionsEscalated} escalated` : 'No activity yet'} />
            <MetricCard
              label="Error rate · 7 days"
              value={s && s.errorRatePct !== null ? fmtPercent(s.errorRatePct, { decimals: 0 }) : '—'}
              accent={over}
              hint={over ? `Above the ${agent.drift?.driftErrorRatePct}% drift threshold` : agent.drift?.driftErrorRatePct != null ? `Drift threshold ${agent.drift.driftErrorRatePct}%` : 'No threshold set'}
            />
            <MetricCard
              label="Spend · this month"
              value={fmtMoney(agent.spendThisMonthCents / 100)}
              hint={agent.profile.spendCapCents !== null ? `of ${fmtMoney(agent.profile.spendCapCents / 100)} cap` : 'No cap set'}
            />
            <MetricCard label="Waiting for a person" value={String(agent.pendingApprovals)} accent={agent.pendingApprovals > 0} hint={agent.pendingApprovals > 0 ? 'Proposals it made' : 'Nothing waiting'} />
          </MetricStrip>
          <KillSwitchRow agent={agent} canManage={canManage} onChanged={onChanged} placement="summary" />
        </div>
      }
      activeTab={activeTab}
      onTabChange={setTab}
      tabs={[
        {
          key: 'profile',
          label: 'Profile',
          content: editing ? (
            <ProfileEditForm key={agent.id} agent={agent} onChanged={onChanged} onDone={() => setEditing(false)} />
          ) : (
            <ProfileView agent={agent} />
          ),
        },
        { key: 'capabilities', label: 'Capabilities & gates', count: capabilitiesCount, content: <CapabilitiesSection agent={agent} canManage={canManage} /> },
        ...(showEmpty(agent.credentials.length, true)
          ? [{ key: 'credentials', label: 'Credentials', count: liveCredentials, content: <CredentialsSection agent={agent} canManage={canManage} onChanged={onChanged} /> }]
          : []),
        {
          key: 'certification',
          label: agent.certification && agent.certification.scenarios > 0 ? `Certification (${agent.certification.passing}/${agent.certification.scenarios})` : 'Certification',
          content: <CertificationSection agent={agent} canManage={canManage} onChanged={onChanged} />,
        },
        { key: 'scorecard', label: 'Scorecard', content: <ScorecardSection agent={agent} canManage={canManage} onChanged={onChanged} /> },
        ...(showEmpty(agent.approvals.length, false)
          ? [{ key: 'requests', label: 'Proposals', count: agent.approvals.length, content: <RequestsSection approvals={agent.approvals} /> }]
          : []),
        ...(showEmpty(agent.spend.length, true)
          ? [{ key: 'spend', label: 'Spend', count: agent.spend.length, content: <SpendSection agent={agent} canManage={canManage} onChanged={onChanged} /> }]
          : []),
        ...(showEmpty(decisionsCount, false)
          ? [{ key: 'record', label: 'Decision record', count: decisionsCount, content: <AgentDecisionRecordTab agentId={agent.id} canManage={canManage} /> }]
          : []),
      ]}
    />
  );
}

/* ------------------------------------------------------------ profile */

/** Build notes the registry once wrote ("Registered by the boot sweep (Brief 1D-2)…"), said in words. */
export function noteInWords(note: string): string {
  return /boot sweep|\bBrief \d/i.test(note) ? 'Added automatically. Confirm the owner.' : note;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 py-2 sm:grid-cols-[12rem_1fr] sm:gap-4">
      <dt className="text-sm text-ink-muted">{label}</dt>
      <dd className="min-w-0 text-sm text-ink">{children}</dd>
    </div>
  );
}

/** The profile as a record reads: who answers for it, what it is for, what it runs on, where, and its limits. */
function ProfileView({ agent }: { agent: AgentDetail }) {
  const p = agent.profile;
  return (
    <dl className="max-w-3xl divide-y divide-line" data-testid="agent-profile">
      <Row label="Owner">
        <OwnerPerson owner={agent.owner} size="sm" />
      </Row>
      <Row label="Purpose">{p.purpose || '—'}</Row>
      <Row label="Family">{familyLabel(p.family) || 'Not yet placed'}</Row>
      {p.capability && <Row label="Capability">{p.capability}</Row>}
      <Row label="Model">{modelLine(p)}</Row>
      <Row label="Model version">{versionLabel(p.modelVersion)}</Row>
      <Row label="Environment">{AGENT_ENVIRONMENT_LABELS[p.environment]}</Row>
      <Row label="Status">
        <Badge variant={STATUS_VARIANT[agent.status]} size="sm">
          {WORKER_STATUS_LABELS[agent.status]}
        </Badge>
      </Row>
      <Row label="Scopes">
        {p.scopes.length ? (
          <span className="flex flex-wrap gap-1">
            {p.scopes.map((sc) => (
              <Badge key={sc} variant="outline" size="sm" withDot={false}>
                {SCOPE_LABEL.get(sc) ?? sc}
              </Badge>
            ))}
          </span>
        ) : (
          'None'
        )}
      </Row>
      <Row label="Limits">
        {p.spendCapCents === null ? 'No spend cap' : `${fmtMoney(p.spendCapCents / 100)} a month`} · {p.rateLimitPerMinute} calls a minute · {hoursLabel(p.allowedHoursStart, p.allowedHoursEnd)}
      </Row>
      <Row label="Registered">
        {fmtDate(agent.createdAt)}
        {p.builtInKey ? ' · ships with the product' : ''}
      </Row>
      {agent.notes && <Row label="Notes">{noteInWords(agent.notes)}</Row>}
    </dl>
  );
}

function ProfileEditForm({ agent, onChanged, onDone }: { agent: AgentDetail; onChanged: () => Promise<unknown>; onDone: () => void }) {
  const confirm = useConfirm();
  const [form, setForm] = useState<ProfileForm>(() => formFromAgent(agent));
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof ProfileForm>(k: K, v: ProfileForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const baseline = useMemo(() => JSON.stringify(formFromAgent(agent)), [agent]);
  const dirty = JSON.stringify(form) !== baseline;
  const valid = formValid(form);

  const save = async () => {
    if (!valid || !dirty) return;
    if ((form.status === 'SUSPENDED' || form.status === 'OFFBOARDED') && form.status !== agent.status) {
      const ok = await confirm({
        title: form.status === 'SUSPENDED' ? `Suspend ${agent.name}?` : `Offboard ${agent.name}?`,
        description: 'Every credential is revoked at once and the agent stops being able to call the product. The record and its trail stay for audit.',
        confirmLabel: form.status === 'SUSPENDED' ? 'Suspend' : 'Offboard',
        destructive: true,
      });
      if (!ok) return;
    }
    setSaving(true);
    try {
      await updateAgent(agent.id, {
        name: form.name.trim(),
        ownerUserId: form.ownerUserId !== (agent.owner?.id ?? '') ? form.ownerUserId : undefined,
        purpose: form.purpose.trim(),
        vendor: form.vendor.trim(),
        model: form.model.trim(),
        modelVersion: form.modelVersion.trim(),
        environment: form.environment,
        scopes: form.scopes,
        ...limitsFromForm(form),
        status: form.status,
        notes: form.notes.trim() || null,
      });
      toast.success('Saved.');
      await onChanged();
      onDone();
    } catch (err) {
      toast.error(errorMessage(err, 'Could not save the agent.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="max-w-3xl space-y-4"
      aria-label="Edit the agent"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <ProfileFields form={form} set={set} canManage owner={agent.owner} />
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" disabled={!valid || !dirty || saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </form>
  );
}
