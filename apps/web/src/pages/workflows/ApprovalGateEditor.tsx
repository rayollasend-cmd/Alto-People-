import { useQuery } from '@tanstack/react-query';
import { HUMAN_ROLES, type Role } from '@alto-people/shared';
import { apiFetch } from '@/lib/api';
import { useRoleLabel } from '@/lib/auth';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';

/**
 * The editor for a workflow's "Require approval" step. It names exactly one
 * decider, the way the engine (lib/workflow REQUIRE_APPROVAL) and the save
 * route's validation read it: a role, a person, or a capability — plus the
 * title and summary the decider sees. The run waits until they decide;
 * approval runs the steps after it, rejection cancels them.
 */

export type GateDecider = 'role' | 'person' | 'capability';

/** The capabilities a gate may name — mirrors GATE_CAPABILITIES in routes/workflows.ts. */
export const GATE_CAPABILITIES = [
  { value: 'manage:org', label: 'Organization administrators' },
  { value: 'manage:comp', label: 'Compensation managers' },
  { value: 'manage:onboarding', label: 'HR (onboarding and offboarding)' },
  { value: 'process:payroll', label: 'Finance (payroll)' },
  { value: 'manage:scheduling', label: 'Scheduling managers' },
  { value: 'manage:compliance', label: 'Compliance' },
] as const;

/** Which kind of decider a gate's params name (role by default for a new step). */
export function deciderOf(params: Record<string, unknown>): GateDecider {
  if (typeof params.userId === 'string' && params.userId) return 'person';
  if (typeof params.capability === 'string' && params.capability) return 'capability';
  return 'role';
}

/** Params with only the chosen decider kept — the API refuses a gate naming two. */
export function withDecider(params: Record<string, unknown>, kind: GateDecider, value: string): Record<string, unknown> {
  const { role: _r, userId: _u, capability: _c, ...rest } = params;
  const key = kind === 'person' ? 'userId' : kind;
  return value ? { ...rest, [key]: value } : rest;
}

interface Approver {
  id: string;
  name: string;
  email: string;
  role: Role | null;
}

export function ApprovalGateEditor({
  params,
  onChange,
  disabled = false,
}: {
  params: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  disabled?: boolean;
}) {
  const roleLabel = useRoleLabel();
  const kind = deciderOf(params);
  const people = useQuery({
    queryKey: ['approvals', 'approvers'],
    queryFn: () => apiFetch<{ candidates: Approver[] }>('/approvals/delegations/candidates?includeMe=1'),
    enabled: kind === 'person',
  });
  const str = (k: string) => (typeof params[k] === 'string' ? (params[k] as string) : '');
  const current = kind === 'person' ? str('userId') : str(kind);

  return (
    <div className="space-y-3" data-testid="approval-gate-editor">
      <Field label="Who decides" hint="The run waits here until they approve; a rejection cancels the steps after it.">
        {() => (
          <SegmentedControl<GateDecider>
            options={[
              { value: 'role', label: 'A role' },
              { value: 'person', label: 'A person' },
              { value: 'capability', label: 'Anyone who can' },
            ]}
            value={kind}
            onChange={(k) => onChange(withDecider(params, k, ''))}
            ariaLabel="Who decides"
          />
        )}
      </Field>
      {kind === 'role' && (
        <Field label="Role" required>
          {(p) => (
            <Select {...p} size="sm" value={current} onChange={(e) => onChange(withDecider(params, 'role', e.target.value))} disabled={disabled}>
              <option value="">Choose a role</option>
              {HUMAN_ROLES.filter((r) => r !== 'ASSOCIATE' && r !== 'CLIENT_PORTAL').map((r) => (
                <option key={r} value={r}>
                  {roleLabel(r)}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
      {kind === 'person' && (
        <Field label="Person" required>
          {(p) => (
            <Select {...p} size="sm" value={current} onChange={(e) => onChange(withDecider(params, 'person', e.target.value))} disabled={disabled || people.isPending}>
              <option value="">{people.isPending ? 'Loading…' : 'Choose a person'}</option>
              {(people.data?.candidates ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.role ? ` · ${roleLabel(c.role)}` : ''}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
      {kind === 'capability' && (
        <Field label="Anyone who is" required>
          {(p) => (
            <Select {...p} size="sm" value={current} onChange={(e) => onChange(withDecider(params, 'capability', e.target.value))} disabled={disabled}>
              <option value="">Choose who</option>
              {GATE_CAPABILITIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
      <Field label="What they see" hint="One sentence. Templates work: {{ associate.firstName }}.">
        {(p) => <Input {...p} value={str('title')} maxLength={200} onChange={(e) => onChange({ ...params, title: e.target.value })} disabled={disabled} placeholder="Confirm the hire of {{ associate.firstName }}" />}
      </Field>
      <Field label="Why it waits" hint="Optional — shown under the title.">
        {(p) => <Input {...p} value={str('summary')} maxLength={2000} onChange={(e) => onChange({ ...params, summary: e.target.value })} disabled={disabled} />}
      </Field>
      {!current && <p className="text-xs text-alert">Name who decides before saving.</p>}
    </div>
  );
}
