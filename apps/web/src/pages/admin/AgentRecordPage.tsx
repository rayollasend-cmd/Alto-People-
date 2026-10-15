import { useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AGENT_ENVIRONMENT_LABELS, WORKER_STATUS_LABELS } from '@alto-people/shared';
import { RecordTemplate } from '@/components/templates';
import { AgentGlyph } from '@/components/agents/AgentGlyph';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { MetricCard } from '@/components/ui/MetricCard';
import { QueryError } from '@/components/ui/QueryError';
import { Skeleton } from '@/components/ui/Skeleton';
import { useAuth } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
import { fmtMoney, fmtPercent } from '@/lib/format';
import { getAgent, updateAgent } from '@/lib/agentsApi';
import { AgentDecisionRecordTab } from '@/pages/admin/AgentDecisionRecordTab';
import {
  CapabilitiesSection,
  CertificationSection,
  CredentialsSection,
  KillSwitchRow,
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
  type ProfileForm,
} from '@/pages/admin/AgentRegistryAdmin';

const TABS = ['profile', 'capabilities', 'credentials', 'certification', 'scorecard', 'requests', 'spend', 'trail', 'record'] as const;
type TabKey = (typeof TABS)[number];

/**
 * An agent's record (UX upgrade, 2026-10-15): the Record template, like a
 * person's or a client's, instead of a dialog over the registry. The
 * header is the agent's mark, name and status; the summary strip is the
 * week's numbers and the kill switch; the tabs are what the dialog held.
 * `?tab=` is the open tab, so a notification can land on Certification.
 */
export function AgentRecordPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const canManage = can('manage:org');
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const detail = useQuery({ queryKey: ['agents', 'detail', id], queryFn: () => getAgent(id), enabled: id.length > 0 });
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

  const s = agent.scorecard;
  const liveCredentials = agent.credentials.filter((c) => c.state === 'ACTIVE' || c.state === 'ROTATING').length;
  const over =
    s?.errorRatePct !== null &&
    s?.errorRatePct !== undefined &&
    agent.drift?.driftErrorRatePct !== null &&
    agent.drift?.driftErrorRatePct !== undefined &&
    s.errorRatePct >= agent.drift.driftErrorRatePct;

  return (
    <RecordTemplate
      breadcrumbs={[{ label: 'Settings & Trust' }, { label: 'Agents', to: '/agents' }, { label: agent.name }]}
      identity={<AgentGlyph family={agent.profile.family} status={agent.status} size="lg" />}
      title={agent.name}
      status={
        <Badge variant={STATUS_VARIANT[agent.status]} size="sm">
          {WORKER_STATUS_LABELS[agent.status]}
        </Badge>
      }
      subtitle={
        <>
          {familyLabel(agent.profile.family) || 'Unplaced'} · {agent.profile.vendor} · {agent.profile.model} {agent.profile.modelVersion} ·{' '}
          {AGENT_ENVIRONMENT_LABELS[agent.profile.environment]}
          {agent.profile.builtInKey ? ' · built in' : ''} · {hoursLabel(agent.profile.allowedHoursStart, agent.profile.allowedHoursEnd)} · {agent.profile.rateLimitPerMinute}/min
        </>
      }
      summary={
        <div className="space-y-[var(--d-stack)]">
          <div className="grid gap-[var(--d-stack)] sm:grid-cols-2 xl:grid-cols-4">
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
            <MetricCard label="Waiting for a person" value={String(agent.pendingApprovals)} accent={agent.pendingApprovals > 0} hint={agent.pendingApprovals > 0 ? 'Gated actions it asked for' : 'Nothing waiting'} />
          </div>
          <KillSwitchRow agent={agent} canManage={canManage} onChanged={onChanged} />
        </div>
      }
      activeTab={activeTab}
      onTabChange={setTab}
      tabs={[
        { key: 'profile', label: 'Profile', content: <ProfileTab key={agent.id} agent={agent} canManage={canManage} onChanged={onChanged} /> },
        { key: 'capabilities', label: 'Capabilities & gates', content: <CapabilitiesSection agent={agent} canManage={canManage} /> },
        { key: 'credentials', label: 'Credentials', count: liveCredentials, content: <CredentialsSection agent={agent} canManage={canManage} onChanged={onChanged} /> },
        {
          key: 'certification',
          label: agent.certification ? `Certification (${agent.certification.passing}/${agent.certification.scenarios})` : 'Certification',
          content: <CertificationSection agent={agent} canManage={canManage} onChanged={onChanged} />,
        },
        { key: 'scorecard', label: 'Scorecard', content: <ScorecardSection agent={agent} canManage={canManage} onChanged={onChanged} /> },
        { key: 'requests', label: 'Requests', count: agent.approvals.length, content: <RequestsSection approvals={agent.approvals} /> },
        { key: 'spend', label: 'Spend', count: agent.spend.length, content: <SpendSection agent={agent} canManage={canManage} onChanged={onChanged} /> },
        { key: 'trail', label: 'Trail', count: agent.trail.length, content: <TrailSection agent={agent} /> },
        { key: 'record', label: 'Decision record', content: <AgentDecisionRecordTab agentId={agent.id} canManage={canManage} /> },
      ]}
    />
  );
}

function ProfileTab({ agent, canManage, onChanged }: { agent: Parameters<typeof formFromAgent>[0]; canManage: boolean; onChanged: () => Promise<unknown> }) {
  const confirm = useConfirm();
  const [form, setForm] = useState<ProfileForm>(() => formFromAgent(agent));
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof ProfileForm>(k: K, v: ProfileForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const baseline = useMemo(() => JSON.stringify(formFromAgent(agent)), [agent]);
  const dirty = JSON.stringify(form) !== baseline;
  const valid = formValid(form);

  const save = async () => {
    if (!valid || !canManage || !dirty) return;
    if ((form.status === 'SUSPENDED' || form.status === 'OFFBOARDED') && form.status !== agent.status) {
      const ok = await confirm({
        title: form.status === 'SUSPENDED' ? `Suspend ${agent.name}?` : `Offboard ${agent.name}?`,
        description: 'Every credential is revoked at once and the agent stops being able to call Alto. The record and its trail stay for audit.',
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
    } catch (err) {
      toast.error(errorMessage(err, 'Could not save the agent.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="max-w-3xl space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <ProfileFields form={form} set={set} canManage={canManage} owner={agent.owner} />
      {canManage && (
        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => setForm(formFromAgent(agent))} disabled={!dirty || saving}>
            Discard
          </Button>
          <Button type="submit" disabled={!valid || !dirty || saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      )}
    </form>
  );
}
