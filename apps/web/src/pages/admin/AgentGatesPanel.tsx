import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AGENT_CAPABILITIES,
  AGENT_FAMILIES,
  AGENT_GATED_ACTION_LABELS,
  ROLE_LABELS,
  type AgentGatedAction,
  type Role,
} from "@alto-people/shared";
import { toast } from "sonner";
import { ApiError, apiFetch } from "@/lib/api";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { QueryError } from "@/components/ui/QueryError";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/Dialog";

/**
 * Brief 2-6 step 2 — the organization's own gates on its agents, over the
 * platform floor. A policy can require approval where the platform does
 * not, and name who decides and how long a request waits; it can never
 * remove an approval the platform requires (a NOT_REQUIRED policy on one
 * shows, and changes nothing). The preview says what would happen now.
 * Rendered open inside Settings & trust › Agents & gates (AgentGovernance).
 */

interface GatePolicy {
  id: string;
  scope: "TENANT" | "FAMILY" | "CAPABILITY" | "AGENT";
  scopeKey: string | null;
  action: string;
  requirement: "REQUIRED" | "NOT_REQUIRED";
  approver: "OWNER" | "ROLE" | "DESK" | "USER";
  approverRole: Role | null;
  approverUserId: string | null;
  ttlHours: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  inForce: boolean;
}

interface GatePreview {
  required: boolean;
  floor: boolean;
  approver: string;
  ttlHours: number;
  reason: string;
}

const PLATFORM_ACTIONS = (
  Object.keys(AGENT_GATED_ACTION_LABELS) as AgentGatedAction[]
).filter((a) => a !== "POLICY_GATE");
const STAFF_ROLES = (Object.keys(ROLE_LABELS) as Role[]).filter(
  (r) => r !== "ASSOCIATE" && r !== "CLIENT_PORTAL" && r !== "LIVE_ASN",
);

const actionLabel = (a: string) =>
  a === "*"
    ? "Every action"
    : (AGENT_GATED_ACTION_LABELS[a as AgentGatedAction] ??
      AGENT_CAPABILITIES.find((c) => c.key === a)?.label ??
      a);

export function AgentGatesPanel({
  agents,
  canManage,
  adding = false,
  onAddingChange,
}: {
  agents: Array<{ id: string; name: string }>;
  canManage: boolean;
  /** The "Add policy" dialog is open (the section's action opens it). */
  adding?: boolean;
  onAddingChange?: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["agents", "gates"],
    queryFn: () => apiFetch<{ policies: GatePolicy[] }>("/agents/gates"),
  });
  const [previewAgent, setPreviewAgent] = useState("");
  const [previewAction, setPreviewAction] = useState("SHIFT_ASSIGN");
  const preview = useQuery({
    queryKey: ["agents", "gates", "preview", previewAgent, previewAction],
    queryFn: () => {
      const isPlatform = (PLATFORM_ACTIONS as readonly string[]).includes(
        previewAction,
      );
      return apiFetch<GatePreview>(
        `/agents/gates/preview?workerId=${previewAgent}&${isPlatform ? "action" : "capability"}=${encodeURIComponent(previewAction)}`,
      );
    },
    enabled: !!previewAgent,
  });

  const end = async (id: string) => {
    try {
      await apiFetch(`/agents/gates/${id}/end`, { method: "POST", body: {} });
      void qc.invalidateQueries({ queryKey: ["agents", "gates"] });
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Could not end the policy.",
      );
    }
  };

  const keyName = (p: GatePolicy) =>
    p.scope === "TENANT"
      ? "Every agent"
      : p.scope === "AGENT"
        ? (agents.find((a) => a.id === p.scopeKey)?.name ?? "An agent")
        : (AGENT_FAMILIES.find((f) => f.code === p.scopeKey)?.label ??
          AGENT_CAPABILITIES.find((c) => c.key === p.scopeKey)?.label ??
          p.scopeKey);
  const decider = (p: GatePolicy) =>
    p.approver === "ROLE"
      ? (ROLE_LABELS[p.approverRole!] ?? p.approverRole)
      : p.approver === "USER"
        ? "A named person"
        : p.approver === "DESK"
          ? "The subject’s desk"
          : "The agent’s owner";
  const policies = q.data?.policies ?? [];

  return (
    <div className="space-y-4" data-testid="agent-gates">
      {q.isError ? (
        <QueryError what="the gates" query={q} />
      ) : q.isPending ? null : policies.length === 0 ? (
        // One line, not an empty table: the floor still applies.
        <p className="text-sm text-ink-muted">
          No policies of your own yet. The platform floor applies to every agent.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Gate policies</caption>
            <thead className="text-left text-xs2 text-ink-muted">
              <tr>
                <th scope="col" className="py-1 pr-3 font-medium">For</th>
                <th scope="col" className="py-1 pr-3 font-medium">Action</th>
                <th scope="col" className="py-1 pr-3 font-medium">Approval</th>
                <th scope="col" className="py-1 pr-3 font-medium">Who decides</th>
                <th scope="col" className="py-1 pr-3 font-medium">Waits</th>
                <th scope="col" className="py-1 font-medium"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {policies.map((p) => (
                <tr key={p.id} className={p.inForce ? "" : "text-ink-muted"}>
                  <td className="py-2 pr-3 text-ink">{keyName(p)}</td>
                  <td className="py-2 pr-3">{actionLabel(p.action)}</td>
                  <td className="py-2 pr-3">
                    <Badge variant={!p.inForce ? "default" : p.requirement === "REQUIRED" ? "pending" : "default"} size="sm">
                      {!p.inForce ? "Ended" : p.requirement === "REQUIRED" ? "Approval required" : "Not required"}
                    </Badge>
                  </td>
                  <td className="py-2 pr-3">{decider(p)}</td>
                  <td className="py-2 pr-3 tabular-nums">{p.ttlHours} h</td>
                  <td className="py-2 text-right">
                    {canManage && p.inForce && (
                      <Button size="sm" variant="ghost" className="text-ink-muted hover:text-alert" onClick={() => void end(p.id)}>
                        End
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Try a policy before trusting it: what would happen now. */}
      <div className="grid grid-cols-1 gap-3 border-t border-line pt-3 sm:grid-cols-3">
        <Field label="Try it: agent">
          {(p) => (
            <Select {...p} value={previewAgent} onChange={(e) => setPreviewAgent(e.target.value)}>
              <option value="">Choose an agent</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Try it: action">
          {(p) => (
            <Select {...p} value={previewAction} onChange={(e) => setPreviewAction(e.target.value)}>
              {PLATFORM_ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {AGENT_GATED_ACTION_LABELS[a]}
                </option>
              ))}
              {AGENT_CAPABILITIES.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <p className="self-end text-sm text-ink-muted" aria-live="polite">
          {preview.data ? preview.data.reason : previewAgent ? "Checking…" : "Pick an agent to see what would happen."}
        </p>
      </div>

      {canManage && adding && <AddPolicyDialog agents={agents} onClose={() => onAddingChange?.(false)} />}
    </div>
  );
}

/** A new policy, in a dialog (F500 G4: the page opens on status, not a form). */
function AddPolicyDialog({ agents, onClose }: { agents: Array<{ id: string; name: string }>; onClose: () => void }) {
  const qc = useQueryClient();
  const [scope, setScope] = useState<GatePolicy["scope"]>("TENANT");
  const [scopeKey, setScopeKey] = useState("");
  const [action, setAction] = useState("*");
  const [requirement, setRequirement] = useState<GatePolicy["requirement"]>("REQUIRED");
  const [approver, setApprover] = useState<GatePolicy["approver"]>("OWNER");
  const [approverRole, setApproverRole] = useState<Role>("OPERATIONS_MANAGER");
  const [ttl, setTtl] = useState("72");
  const [saving, setSaving] = useState(false);
  const keyOptions =
    scope === "FAMILY"
      ? AGENT_FAMILIES.map((f) => ({ value: f.code, label: f.label }))
      : scope === "CAPABILITY"
        ? AGENT_CAPABILITIES.map((c) => ({ value: c.key, label: c.label }))
        : scope === "AGENT"
          ? agents.map((a) => ({ value: a.id, label: a.name }))
          : [];
  const save = async () => {
    setSaving(true);
    try {
      await apiFetch("/agents/gates", {
        method: "POST",
        body: {
          scope,
          scopeKey: scope === "TENANT" ? null : scopeKey,
          action,
          requirement,
          approver,
          ...(approver === "ROLE" ? { approverRole } : {}),
          ttlHours: Number(ttl),
        },
      });
      toast.success("Policy saved.");
      void qc.invalidateQueries({ queryKey: ["agents", "gates"] });
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not save the policy.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && !saving && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add policy</DialogTitle>
          <DialogDescription>
            Require approval where the platform does not, and name who decides. A platform approval (pay, separations, client messages, exports, shift assignments, HR cases) can never be removed.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid grid-cols-1 gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Field label="For">
            {(p) => (
              <Select
                {...p}
                value={scope}
                onChange={(e) => {
                  setScope(e.target.value as GatePolicy["scope"]);
                  setScopeKey("");
                }}
              >
                <option value="TENANT">Every agent</option>
                <option value="FAMILY">A family</option>
                <option value="CAPABILITY">A capability</option>
                <option value="AGENT">One agent</option>
              </Select>
            )}
          </Field>
          {scope !== "TENANT" && (
            <Field label="Which">
              {(p) => (
                <Select {...p} value={scopeKey} onChange={(e) => setScopeKey(e.target.value)}>
                  <option value="">Choose</option>
                  {keyOptions.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          <Field label="Action">
            {(p) => (
              <Select {...p} value={action} onChange={(e) => setAction(e.target.value)}>
                <option value="*">Every action</option>
                {PLATFORM_ACTIONS.map((a) => (
                  <option key={a} value={a}>
                    {AGENT_GATED_ACTION_LABELS[a]}
                  </option>
                ))}
                {AGENT_CAPABILITIES.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Approval">
            {(p) => (
              <Select {...p} value={requirement} onChange={(e) => setRequirement(e.target.value as GatePolicy["requirement"])}>
                <option value="REQUIRED">Required</option>
                <option value="NOT_REQUIRED">Not required (where the platform allows)</option>
              </Select>
            )}
          </Field>
          <Field label="Who decides">
            {(p) => (
              <Select {...p} value={approver} onChange={(e) => setApprover(e.target.value as GatePolicy["approver"])}>
                <option value="OWNER">The agent’s owner</option>
                <option value="ROLE">A role</option>
                <option value="DESK">The subject’s desk</option>
              </Select>
            )}
          </Field>
          {approver === "ROLE" && (
            <Field label="Role">
              {(p) => (
                <Select {...p} value={approverRole} onChange={(e) => setApproverRole(e.target.value as Role)}>
                  {STAFF_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          <Field label="Expires after (hours)">
            {(p) => <Input {...p} inputMode="numeric" value={ttl} onChange={(e) => setTtl(e.target.value)} />}
          </Field>
          <DialogFooter className="sm:col-span-2">
            <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" loading={saving} disabled={scope !== "TENANT" && !scopeKey}>
              Add policy
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
