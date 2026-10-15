import { AGENT_FAMILIES, capabilitiesFor, type AgentFamily, type AgentScope } from '@alto-people/shared';
import { useTenant } from '@/lib/auth';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';

/**
 * Brief 2-6 step 1 — the family and the catalog capabilities an agent is
 * registered with. "Custom" is an agent outside the catalog: it acts through
 * its scopes only. Only capabilities this organization offers (its modules
 * on) are listed; picking one adds the scopes it needs to the agent's.
 */

export interface CatalogChoice {
  family: AgentFamily | null;
  capabilities: string[];
}

export function AgentCatalogPicker({ value, onChange, scopes, onScopes }: { value: CatalogChoice; onChange: (v: CatalogChoice) => void; scopes: AgentScope[]; onScopes: (s: AgentScope[]) => void }) {
  const tenant = useTenant();
  const offered = capabilitiesFor(tenant.modules).filter((c) => c.family === value.family);

  const toggle = (key: string, needs: readonly AgentScope[]) => {
    const on = value.capabilities.includes(key);
    onChange({ ...value, capabilities: on ? value.capabilities.filter((k) => k !== key) : [...value.capabilities, key] });
    if (!on) onScopes([...new Set([...scopes, ...needs])]);
  };

  return (
    <div className="space-y-3">
      <Field label="Family" hint="Custom: an agent outside the catalog, acting through its scopes.">
        {(p) => (
          <Select {...p} value={value.family ?? ''} onChange={(e) => onChange({ family: (e.target.value || null) as AgentFamily | null, capabilities: [] })}>
            <option value="">Custom</option>
            {AGENT_FAMILIES.map((f) => (
              <option key={f.code} value={f.code}>
                {f.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {value.family && (
        <fieldset className="rounded-md border border-navy-secondary p-3">
          <legend className="px-1 text-sm text-white">Catalog capabilities</legend>
          {offered.length === 0 ? (
            <p className="text-xs text-silver">This family has no catalog capability offered here yet.</p>
          ) : (
            offered.map((c) => (
              <label key={c.key} className="flex cursor-pointer items-start gap-2 py-1 text-sm text-silver hover:text-white">
                <input type="checkbox" className="mt-1" checked={value.capabilities.includes(c.key)} onChange={() => toggle(c.key, c.scopes)} />
                <span>
                  <span className="text-white">{c.label}</span>
                  {c.gate && <span className="ml-1 text-xs text-warning">· needs approval</span>}
                  <span className="block font-mono text-2xs text-silver/70">{c.scopes.join(' ')}</span>
                </span>
              </label>
            ))
          )}
        </fieldset>
      )}
    </div>
  );
}
