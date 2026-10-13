import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { BotMessageSquare, Copy, Plus } from 'lucide-react';
import { toast } from 'sonner';
import {
  AGENT_APPROVAL_STATUS_LABELS,
  AGENT_ENVIRONMENT_LABELS,
  AGENT_EXECUTABLE_ACTIONS,
  AGENT_GATED_ACTION_LABELS,
  AGENT_SCOPES,
  WORKER_STATUS_LABELS,
  type AgentApprovalStatus,
  type AgentApprovalSummary,
  type AgentCredentialState,
  type AgentDetail,
  type AgentEnvironment,
  type AgentGatedAction,
  type AgentScope,
  type AgentSummary,
  type WorkerStatus,
} from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useConfirm, usePrompt } from '@/lib/confirm';
import { fmtDate, fmtDateTime, fmtMoney, fmtRelativeDate } from '@/lib/format';
import { listAdminUsers } from '@/lib/usersAdminApi';
import {
  createAgent,
  decideAgentApproval,
  ensureBuiltInAgents,
  getAgent,
  issueAgentCredential,
  listAgentApprovals,
  listAgents,
  recordAgentSpend,
  revokeAgentCredential,
  updateAgent,
} from '@/lib/agentsApi';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { MetricCard } from '@/components/ui/MetricCard';
import { Select } from '@/components/ui/Select';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { QueryError } from '@/components/ui/QueryError';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs';
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
 * Deep link: `?approval=<id>` opens that request's decision dialog (the
 * owner's notification points here); the param is dropped once consumed.
 */

const STATUSES: WorkerStatus[] = ['ONBOARDING', 'ACTIVE', 'SUSPENDED', 'OFFBOARDED'];
const ENVIRONMENTS: AgentEnvironment[] = ['PRODUCTION', 'STAGING', 'DEVELOPMENT'];
const STATUS_VARIANT: Record<WorkerStatus, 'pending' | 'success' | 'destructive' | 'outline'> = {
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

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    const code = (err as { code?: string }).code ?? '';
    if (code === 'owner_not_eligible') return 'A client portal account cannot own an agent.';
    if (code === 'owner_not_found') return 'That owner no longer exists.';
    if (code === 'agent_not_found') return 'That agent no longer exists.';
    if (code === 'approval_decided') return 'This request was already decided.';
    if (code === 'approval_expired') return 'This request expired before it was decided.';
    if (code === 'credential_already_revoked') return 'That credential was already revoked.';
    return err.message || fallback;
  }
  return fallback;
}

/** Cents → "$12.34". Money reads in heavy sans, never the display serif. */
function Money({ cents, className = '' }: { cents: number; className?: string }) {
  return <span className={`font-semibold tabular-nums ${className}`}>{fmtMoney(cents / 100)}</span>;
}

function hoursLabel(start: number | null, end: number | null): string {
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

export function AgentRegistryAdmin() {
  const { can } = useAuth();
  const canManage = can('manage:org');
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [ensuring, setEnsuring] = useState(false);
  const [deciding, setDeciding] = useState<{ approval: AgentApprovalSummary; decision: 'approve' | 'reject' | null } | null>(null);

  const registry = useQuery({ queryKey: ['agents', 'list'], queryFn: listAgents });
  const queueFilters = useMemo(() => ({ status: 'PENDING' as const }), []);
  const queue = useQuery({ queryKey: ['agents', 'approvals', queueFilters], queryFn: () => listAgentApprovals(queueFilters) });

  const agents = registry.data?.agents ?? [];
  const counts = registry.data?.counts;
  const builtInMissing = registry.data?.builtInMissing ?? [];
  const pendingCount = registry.data?.pendingApprovals ?? queue.data?.approvals.length ?? 0;
  const pending = useMemo(
    () => (queue.data?.approvals ?? []).slice().sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)),
    [queue.data],
  );

  const refetchAll = () => qc.invalidateQueries({ queryKey: ['agents'] });

  // Deep link: ?approval=<id> opens the decision dialog once the queue has
  // loaded, and the param is consumed so Back and refetches don't re-open
  // it. A request that is no longer waiting gets a toast instead.
  const target = searchParams.get('approval');
  const queueLoaded = queue.data !== undefined;
  useEffect(() => {
    if (!target || !queueLoaded) return;
    const next = new URLSearchParams(searchParams);
    next.delete('approval');
    setSearchParams(next, { replace: true });
    const approval = pending.find((a) => a.id === target);
    if (!approval) {
      toast.info('That request is no longer waiting — it may already be decided.');
      return;
    }
    setDeciding({ approval, decision: null });
    // searchParams/setSearchParams change identity on the consume above;
    // target going null ends the cycle, so they're deliberately not deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, queueLoaded, pending]);

  const onEnsure = async () => {
    setEnsuring(true);
    try {
      const r = await ensureBuiltInAgents();
      const n = r.created.length;
      toast.success(n === 1 ? '1 built-in agent registered.' : `${n} built-in agents registered.`);
      if (r.missing.length) toast.info(`Still waiting for an owner account: ${r.missing.join(', ')}.`);
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
          <span className="flex flex-col">
            <span className="font-medium text-white">{a.name}</span>
            <span className="text-xs2 text-silver/70">
              {a.profile.vendor} · {a.profile.model} {a.profile.modelVersion}
            </span>
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
        cell: (a) =>
          a.owner ? (
            <span className="flex flex-col">
              <span>{a.owner.name || a.owner.email}</span>
              {a.owner.name && <span className="text-xs2 text-silver/70">{a.owner.email}</span>}
            </span>
          ) : (
            <Badge variant="destructive" size="sm">No owner</Badge>
          ),
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
        key: 'lastActive',
        header: 'Last active',
        accessor: (a) => a.profile.lastActiveAt ?? '',
        sortable: true,
        cell: (a) => (a.profile.lastActiveAt ? fmtRelativeDate(a.profile.lastActiveAt) : <span className="text-silver/60">Never</span>),
        csv: (a) => a.profile.lastActiveAt ?? '',
      },
      {
        key: 'pending',
        header: 'Pending requests',
        accessor: (a) => a.pendingApprovals,
        sortable: true,
        align: 'right',
        cell: (a) => (a.pendingApprovals > 0 ? <span className="font-medium text-warning tabular-nums">{a.pendingApprovals}</span> : <span className="tabular-nums">0</span>),
      },
    ],
    [],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="AI agents"
        subtitle="Every AI agent Alto runs: who owns it, what it may do, its credentials, limits, spend and the trail of what it did. Gated actions wait here for a person."
        primaryAction={
          canManage ? (
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" aria-hidden="true" /> Register agent
            </Button>
          ) : undefined
        }
      />

      {registry.error && <QueryError what="agents" query={registry} />}

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
        {queue.error && <QueryError what="the approval queue" query={queue} />}
        {pending.length > 0 && (
          <ul className="divide-y divide-navy-secondary rounded-md border border-navy-secondary">
            {pending.map((a) => (
              <li key={a.id} id={`approval-${a.id}`} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium text-white">{a.agentName}</span>
                    <Badge variant="pending" size="sm">
                      {AGENT_GATED_ACTION_LABELS[a.action]}
                    </Badge>
                  </div>
                  <p className="text-sm text-silver">{a.summary}</p>
                  <p className="text-xs2 text-silver/70">
                    Requested {fmtRelativeDate(a.requestedAt)} · expires {fmtDateTime(a.expiresAt)}
                  </p>
                </div>
                {canManage && (
                  <div className="flex gap-2">
                    <Button size="sm" variant="secondary" onClick={() => setDeciding({ approval: a, decision: 'reject' })}>
                      Reject
                    </Button>
                    <Button size="sm" onClick={() => setDeciding({ approval: a, decision: 'approve' })}>
                      Approve
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs2 text-silver/70">
          {HUMAN_ONLY_ACTIONS.map((a) => AGENT_GATED_ACTION_LABELS[a]).join(' and ')} approvals are carried out by the approver in the app; the agent never does them itself.{' '}
          {AGENT_EXECUTABLE_ACTIONS.map((a) => AGENT_GATED_ACTION_LABELS[a]).join(' and ')} may be carried out by the agent once approved.
        </p>
      </section>

      {builtInMissing.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-warning/30 bg-warning/10 px-4 py-3 text-sm">
          <BotMessageSquare className="h-4 w-4 text-warning" aria-hidden="true" />
          <span>
            Not yet registered: <strong>{builtInMissing.join(', ')}</strong>. Alto already runs these; they need an owner account before they can be registered.
          </span>
          {canManage && (
            <Button size="sm" variant="secondary" onClick={onEnsure} disabled={ensuring}>
              {ensuring ? 'Registering…' : 'Register built-in agents'}
            </Button>
          )}
        </div>
      )}

      <DataGrid
        id="agents"
        caption="AI agents"
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
        onRowClick={(a) => setOpenId(a.id)}
        rowActionLabel={(a) => `Open ${a.name}`}
        defaultSort={{ key: 'name', direction: 'asc' }}
        empty={{
          icon: BotMessageSquare,
          title: 'No agents registered',
          description: canManage ? 'Register an agent, or register the built-in ones Alto already runs.' : 'Agents appear here once they are registered.',
        }}
      />

      {creating && (
        <CreateAgentDialog
          onClose={() => setCreating(false)}
          onCreated={async () => {
            setCreating(false);
            await refetchAll();
          }}
        />
      )}
      {openId && <AgentDetailDialog id={openId} canManage={canManage} onClose={() => setOpenId(null)} onChanged={refetchAll} />}
      {deciding && (
        <DecisionDialog
          approval={deciding.approval}
          decision={deciding.decision}
          canManage={canManage}
          onClose={() => setDeciding(null)}
          onDecided={async () => {
            setDeciding(null);
            await refetchAll();
          }}
        />
      )}
    </div>
  );
}

/* ---------------------------------------------------------- decisions */

function DecisionDialog({
  approval,
  decision,
  canManage,
  onClose,
  onDecided,
}: {
  approval: AgentApprovalSummary;
  /** Preselected from the row's button; null (deep link) offers both. */
  decision: 'approve' | 'reject' | null;
  canManage: boolean;
  onClose: () => void;
  onDecided: () => Promise<void>;
}) {
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState<'approve' | 'reject' | null>(null);
  const humanOnly = !AGENT_EXECUTABLE_ACTIONS.includes(approval.action);

  const decide = async (d: 'approve' | 'reject') => {
    setSaving(d);
    try {
      await decideAgentApproval(approval.id, d, note.trim() || undefined);
      toast.success(d === 'approve' ? 'Approved.' : 'Rejected.');
      await onDecided();
    } catch (err) {
      toast.error(errorMessage(err, 'Could not record the decision.'));
    } finally {
      setSaving(null);
    }
  };

  const title = decision === 'approve' ? 'Approve this request?' : decision === 'reject' ? 'Reject this request?' : 'Decide this request';

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} confirmDiscard={note !== '' && saving === null}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            <span className="font-medium text-white">{approval.agentName}</span> asks for <span className="font-medium text-white">{AGENT_GATED_ACTION_LABELS[approval.action].toLowerCase()}</span>
            {' · '}requested {fmtDateTime(approval.requestedAt)}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <p className="rounded-md border border-navy-secondary bg-navy-secondary/40 px-3 py-2 text-sm">{approval.summary}</p>
          {Object.keys(approval.payload).length > 0 && (
            <details className="rounded-md border border-navy-secondary px-3 py-2">
              <summary className="cursor-pointer text-sm text-silver">Details</summary>
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs text-silver">{JSON.stringify(approval.payload, null, 2)}</pre>
            </details>
          )}
          {humanOnly && (
            <p className="text-xs2 text-warning">
              Approving does not carry this out. {AGENT_GATED_ACTION_LABELS[approval.action]} is done by you in the app; the agent only asked.
            </p>
          )}
          {canManage && (
            <Field label="Note" hint="Optional. Kept with the decision.">
              {(p) => <Textarea {...p} value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={500} />}
            </Field>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={saving !== null}>
              {canManage ? 'Cancel' : 'Close'}
            </Button>
            {canManage && decision !== 'approve' && (
              <Button type="button" variant="secondary" onClick={() => decide('reject')} disabled={saving !== null}>
                {saving === 'reject' ? 'Rejecting…' : 'Reject'}
              </Button>
            )}
            {canManage && decision !== 'reject' && (
              <Button type="button" onClick={() => decide('approve')} disabled={saving !== null}>
                {saving === 'approve' ? 'Approving…' : 'Approve'}
              </Button>
            )}
          </DialogFooter>
        </div>
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

interface ProfileForm {
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

function formFromAgent(a: AgentDetail): ProfileForm {
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

function formValid(f: ProfileForm): boolean {
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

function limitsFromForm(f: ProfileForm) {
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
function ProfileFields({ form, set, canManage, owner }: { form: ProfileForm; set: <K extends keyof ProfileForm>(k: K, v: ProfileForm[K]) => void; canManage: boolean; owner: AgentDetail['owner'] | undefined }) {
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
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof ProfileForm>(k: K, v: ProfileForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const dirty = JSON.stringify(form) !== JSON.stringify(emptyForm());
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

function AgentDetailDialog({ id, canManage, onClose, onChanged }: { id: string; canManage: boolean; onClose: () => void; onChanged: () => Promise<unknown> }) {
  const detail = useQuery({ queryKey: ['agents', 'detail', id], queryFn: () => getAgent(id) });
  if (!detail.data) {
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{detail.error ? 'Could not load this agent' : 'Loading…'}</DialogTitle>
            <DialogDescription>{detail.error ? errorMessage(detail.error, 'Try again in a moment.') : 'Profile, credentials, requests, spend and trail.'}</DialogDescription>
          </DialogHeader>
          {detail.error && <QueryError what="this agent" query={detail} />}
        </DialogContent>
      </Dialog>
    );
  }
  return <AgentDetailBody key={detail.data.id} agent={detail.data} canManage={canManage} onClose={onClose} onChanged={onChanged} />;
}

function AgentDetailBody({ agent, canManage, onClose, onChanged }: { agent: AgentDetail; canManage: boolean; onClose: () => void; onChanged: () => Promise<unknown> }) {
  const confirm = useConfirm();
  const [tab, setTab] = useState('profile');
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

  const liveCredentials = agent.credentials.filter((c) => c.state === 'ACTIVE' || c.state === 'ROTATING').length;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} confirmDiscard={dirty && !saving}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            <span className="inline-flex flex-wrap items-center gap-2">
              {agent.name}
              <Badge variant={STATUS_VARIANT[agent.status]} size="sm">
                {WORKER_STATUS_LABELS[agent.status]}
              </Badge>
            </span>
          </DialogTitle>
          <DialogDescription>
            {agent.profile.vendor} · {agent.profile.model} {agent.profile.modelVersion} · {AGENT_ENVIRONMENT_LABELS[agent.profile.environment]}
            {agent.profile.builtInKey ? ' · built in' : ''} · spend this month <Money cents={agent.spendThisMonthCents} className="text-white" />
            {agent.profile.spendCapCents !== null && (
              <>
                {' of '}
                <Money cents={agent.profile.spendCapCents} />
              </>
            )}
            {' · '}
            {hoursLabel(agent.profile.allowedHoursStart, agent.profile.allowedHoursEnd)} · {agent.profile.rateLimitPerMinute}/min
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="profile">Profile</TabsTrigger>
            <TabsTrigger value="credentials">Credentials ({liveCredentials})</TabsTrigger>
            <TabsTrigger value="requests">Requests ({agent.approvals.length})</TabsTrigger>
            <TabsTrigger value="spend">Spend ({agent.spend.length})</TabsTrigger>
            <TabsTrigger value="trail">Trail ({agent.trail.length})</TabsTrigger>
          </TabsList>

          <TabsContent value="profile">
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <ProfileFields form={form} set={set} canManage={canManage} owner={agent.owner} />
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
                  {canManage ? 'Cancel' : 'Close'}
                </Button>
                {canManage && (
                  <Button type="submit" disabled={!valid || !dirty || saving}>
                    {saving ? 'Saving…' : 'Save'}
                  </Button>
                )}
              </DialogFooter>
            </form>
          </TabsContent>

          <TabsContent value="credentials">
            <CredentialsSection agent={agent} canManage={canManage} onChanged={onChanged} />
          </TabsContent>

          <TabsContent value="requests">
            <RequestsSection approvals={agent.approvals} />
          </TabsContent>

          <TabsContent value="spend">
            <SpendSection agent={agent} canManage={canManage} onChanged={onChanged} />
          </TabsContent>

          <TabsContent value="trail">
            <TrailSection agent={agent} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------- credentials */

function CredentialsSection({ agent, canManage, onChanged }: { agent: AgentDetail; canManage: boolean; onChanged: () => Promise<unknown> }) {
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
            Ends in …{issued.last4} · expires {fmtDateTime(issued.expiresAt)}. The agent sends it as a bearer token to the agent API.
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

function RequestsSection({ approvals }: { approvals: AgentApprovalSummary[] }) {
  if (approvals.length === 0) return <p className="text-sm text-silver/70">This agent has not asked for anything.</p>;
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

function SpendSection({ agent, canManage, onChanged }: { agent: AgentDetail; canManage: boolean; onChanged: () => Promise<unknown> }) {
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

/** The few metadata keys worth a glance; the rest stays in the audit log. */
function summariseMeta(meta: Record<string, unknown> | null): string {
  if (!meta) return '';
  const parts: string[] = [];
  if (Array.isArray(meta.scopes)) parts.push(`scopes: ${(meta.scopes as string[]).map((s) => SCOPE_LABEL.get(s) ?? s).join(', ')}`);
  if (typeof meta.status === 'string') parts.push(`status: ${meta.status}`);
  if (typeof meta.approvalId === 'string') parts.push(`approval ${meta.approvalId.slice(0, 8)}`);
  if (typeof meta.code === 'string') parts.push(meta.code);
  if (typeof meta.last4 === 'string') parts.push(`…${meta.last4}`);
  if (typeof meta.reason === 'string' && meta.reason) parts.push(meta.reason);
  if (typeof meta.amountCents === 'number') parts.push(fmtMoney(meta.amountCents / 100));
  return parts.join(' · ');
}

function TrailSection({ agent }: { agent: AgentDetail }) {
  if (agent.trail.length === 0) return <p className="text-sm text-silver/70">Nothing in the trail yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs2 text-silver/70">
          <tr>
            <th scope="col" className="py-1 pr-3 font-medium">When</th>
            <th scope="col" className="py-1 pr-3 font-medium">Action</th>
            <th scope="col" className="py-1 pr-3 font-medium">Entity</th>
            <th scope="col" className="py-1 font-medium">Details</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-navy-secondary">
          {agent.trail.map((t) => (
            <tr key={t.id}>
              <td className="py-1.5 pr-3 whitespace-nowrap">{fmtDateTime(t.createdAt)}</td>
              <td className="py-1.5 pr-3 font-mono text-xs text-white">{t.action}</td>
              <td className="py-1.5 pr-3 text-xs2 text-silver/70">
                {t.entityType} <span className="font-mono">{t.entityId.slice(0, 8)}</span>
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
