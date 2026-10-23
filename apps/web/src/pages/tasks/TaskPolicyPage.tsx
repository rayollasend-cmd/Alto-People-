import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { WORKER_CAPABILITIES, WORK_TASK_HIGH_RISK_POLICIES, type WorkTaskHighRiskPolicy } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useAuth, useTerm } from '@/lib/auth';
import { getTaskPolicy, updateTaskPolicy } from '@/lib/tasksApi';
import { useOrgSites } from '@/lib/useOrgSites';
import { ListTemplate } from '@/components/templates';
import { Button, Input, Select } from '@/components/ui';
import { Card, CardContent } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * Brief 3-2: the assignment rules, tenant-wide or for one site. How long a
 * machine's stalled task waits before a person gets it, what the engine
 * may spend on its own, who may hold high-risk work, what a robot's task
 * costs, and the span of control Brief 3-3 warns on.
 */

const POLICY_LABEL: Record<WorkTaskHighRiskPolicy, string> = {
  PERSON_ONLY: 'A person only',
  PERSON_OR_SUPERVISED_ROBOT: 'A person, or a robot a person on shift supervises',
};

const CAPS: ReadonlyArray<{ code: string; label: string; types: readonly string[] }> = WORKER_CAPABILITIES;
const ROBOT_CAPS = CAPS.filter((c) => c.types.includes('ROBOT'));

export function TaskPolicyPage() {
  const { can } = useAuth();
  const term = useTerm();
  const canEdit = can('manage:org');
  const sites = useOrgSites(true);
  const [locationId, setLocationId] = useState('');
  const q = useQuery({ queryKey: ['tasks', 'policy', { locationId }], queryFn: () => getTaskPolicy(locationId || null) });
  // Sites with their own policy, marked in the picker so nobody hunts for them.
  const custom = new Set((q.data as { overrideLocationIds?: string[] } | undefined)?.overrideLocationIds ?? []);

  const [handoff, setHandoff] = useState('30');
  const [maxAuto, setMaxAuto] = useState('');
  const [highRisk, setHighRisk] = useState<WorkTaskHighRiskPolicy>('PERSON_OR_SUPERVISED_ROBOT');
  const [robotDefault, setRobotDefault] = useState('4.00');
  const [agentCost, setAgentCost] = useState('0.00');
  const [span, setSpan] = useState('4');
  const [utilization, setUtilization] = useState('70');
  const [backup, setBackup] = useState('25');
  const [robotCosts, setRobotCosts] = useState<Record<string, string>>({});

  useEffect(() => {
    const p = q.data;
    if (!p) return;
    setHandoff(String(p.handoffSeconds));
    setMaxAuto(p.maxAutoAssignCents === null ? '' : (p.maxAutoAssignCents / 100).toFixed(2));
    setHighRisk(p.highRiskPolicy);
    setRobotDefault((p.robotDefaultCostCents / 100).toFixed(2));
    setAgentCost((p.agentCostPerTaskCents / 100).toFixed(2));
    setSpan(String(p.maxRobotsPerCrewLead));
    setUtilization(String(p.robotUtilizationPct));
    setBackup(String(p.backupCrewRatioPct));
    setRobotCosts(Object.fromEntries(Object.entries(p.robotCostPerTaskCents).map(([k, v]) => [k, (v / 100).toFixed(2)])));
  }, [q.data]);

  const cents = (s: string) => Math.round(Number(s || '0') * 100);
  const save = useMutation({
    mutationFn: () =>
      updateTaskPolicy(
        {
          handoffSeconds: Number(handoff) || 30,
          maxAutoAssignCents: maxAuto.trim() === '' ? null : cents(maxAuto),
          highRiskPolicy: highRisk,
          robotDefaultCostCents: cents(robotDefault),
          agentCostPerTaskCents: cents(agentCost),
          maxRobotsPerCrewLead: Number(span) || 4,
          robotUtilizationPct: Math.min(100, Math.max(1, Number(utilization) || 70)),
          backupCrewRatioPct: Math.min(100, Math.max(0, Number(backup) || 0)),
          robotCostPerTaskCents: Object.fromEntries(Object.entries(robotCosts).filter(([, v]) => v.trim() !== '').map(([k, v]) => [k, cents(v)])),
        },
        locationId || null,
      ),
    onSuccess: () => {
      toast.success('Policy saved.');
      void q.refetch();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save the policy.'),
  });

  const siteLabel = term('site');
  return (
    <ListTemplate
      title="Task assignment"
      subtitle="Who holds a task when it comes in, what can be assigned without a person, and when a person takes over."
      filters={
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="task-policy-scope" className="text-sm text-ink-muted">
            Applies to
          </label>
          <Select id="task-policy-scope" size="sm" value={locationId} onChange={(e) => setLocationId(e.target.value)} className="w-full sm:w-72">
            <option value="">Every {siteLabel.toLowerCase()} (the default)</option>
            {(sites ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {custom.has(s.id) ? ' (custom)' : ''}
              </option>
            ))}
          </Select>
          {q.data && q.data.locationId === null && locationId && <span className="text-xs2 text-ink-muted">No override here yet; saving creates one.</span>}
        </div>
      }
    >
      {q.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardContent className="space-y-4">
              <SectionTitle title="When a machine stalls" />
              <Field label="Seconds before a person takes over" hint="A robot's or agent's task that stalled or failed waits this long, then goes to the best person on shift and the crew lead is told.">
                {(p) => <Input {...p} type="number" min={5} max={900} value={handoff} onChange={(e) => setHandoff(e.target.value)} disabled={!canEdit} className="w-32" />}
              </Field>
              <Field label="High-risk work may be held by">
                {(p) => (
                  <Select {...p} value={highRisk} onChange={(e) => setHighRisk(e.target.value as WorkTaskHighRiskPolicy)} disabled={!canEdit}>
                    {WORK_TASK_HIGH_RISK_POLICIES.map((v) => (
                      <option key={v} value={v}>
                        {POLICY_LABEL[v]}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Robots per crew lead" hint="The control room shows the span; the scheduler warns above this.">
                {(p) => <Input {...p} type="number" min={1} max={50} value={span} onChange={(e) => setSpan(e.target.value)} disabled={!canEdit} className="w-32" />}
              </Field>
              <Field label="Robot utilisation (% of a shift on tasks)" hint="The season planner's robot capacity: a robot's shift minutes times this.">
                {(p) => <Input {...p} type="number" min={1} max={100} value={utilization} onChange={(e) => setUtilization(e.target.value)} disabled={!canEdit} className="w-32" />}
              </Field>
              <Field label="Backup crew (% of robot minutes)" hint="Standby people a robot-dependent week needs, as a share of the robots' task minutes.">
                {(p) => <Input {...p} type="number" min={0} max={100} value={backup} onChange={(e) => setBackup(e.target.value)} disabled={!canEdit} className="w-32" />}
              </Field>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="space-y-4">
              <SectionTitle title="What may be assigned without a person" />
              <Field label="Assign on its own up to ($ per task)" hint="Leave empty for no cap. Dearer work queues for a person.">
                {(p) => <Input {...p} type="number" min={0} step="0.01" value={maxAuto} onChange={(e) => setMaxAuto(e.target.value)} disabled={!canEdit} className="w-40" placeholder="No cap" />}
              </Field>
              <Field label="A robot's task, by default ($)">
                {(p) => <Input {...p} type="number" min={0} step="0.01" value={robotDefault} onChange={(e) => setRobotDefault(e.target.value)} disabled={!canEdit} className="w-40" />}
              </Field>
              <Field label="An agent's task ($)">
                {(p) => <Input {...p} type="number" min={0} step="0.01" value={agentCost} onChange={(e) => setAgentCost(e.target.value)} disabled={!canEdit} className="w-40" />}
              </Field>
              <div className="space-y-2">
                <div className="text-xs2 uppercase tracking-[0.14em] text-ink-muted">A robot's task, per kind of work ($)</div>
                {ROBOT_CAPS.map((c) => (
                  <label key={c.code} className="flex items-center justify-between gap-3 text-sm text-ink">
                    <span>{c.label}</span>
                    <Input
                      type="number"
                      min={0}
                      step="0.01"
                      value={robotCosts[c.code] ?? ''}
                      onChange={(e) => setRobotCosts((m) => ({ ...m, [c.code]: e.target.value }))}
                      disabled={!canEdit}
                      className="w-32"
                      placeholder="default"
                      aria-label={`${c.label} robot cost`}
                    />
                  </label>
                ))}
              </div>
            </CardContent>
          </Card>
          {canEdit && (
            <div className="lg:col-span-2">
              <Button onClick={() => save.mutate()} loading={save.isPending}>
                Save policy
              </Button>
            </div>
          )}
        </div>
      )}
    </ListTemplate>
  );
}
