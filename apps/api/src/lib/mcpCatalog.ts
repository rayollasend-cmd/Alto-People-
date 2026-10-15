import { capabilitiesFor, type AgentCapabilityDef, type TenantModules } from '@alto-people/shared';

/**
 * The MCP tool catalog, as a read-only preview (agent families step 6;
 * Brief 2-7: a thin MCP server over the agent API, agent credentials only,
 * tools generated from the capability catalog, a gated tool returns an
 * approval id and does nothing else).
 *
 * Generated, never hand-written: one tool per capability the tenant is
 * offered (capabilitiesFor its modules), so a capability whose module is
 * off is absent here as it is from Hugo and the Agents page. Nothing in
 * this preview calls anything; the server that serves it is 2-7.
 */

export interface McpToolPreview {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint: false; idempotentHint: boolean; openWorldHint: false };
  /** What calling it does: proposes (returns an approval id), notifies people, or only reads. */
  effect: 'propose' | 'notify' | 'read';
  gate: string | null;
  requiredScopes: string[];
  family: string;
}

const PROPOSAL_INPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['subjectType', 'subjectId', 'summary'],
  properties: {
    subjectType: { type: 'string', description: 'What the proposal is about (Shift, OshaIncident…).' },
    subjectId: { type: 'string', format: 'uuid' },
    summary: { type: 'string', maxLength: 500, description: 'What a person approves, in words.' },
    payload: { type: 'object', description: 'The capability’s own fields, as approved.' },
  },
} as const;

const RUN_INPUT = { type: 'object', additionalProperties: false, properties: {} } as const;

export function toolFor(def: AgentCapabilityDef): McpToolPreview {
  const effect = def.gate ? 'propose' : def.notifies ? 'notify' : 'read';
  const does =
    effect === 'propose'
      ? `Files a ${def.gate} approval and returns its id; nothing happens until a person approves.`
      : effect === 'notify'
        ? 'Sends notices to people (one a person a day, logged); changes no record.'
        : 'Reads only.';
  return {
    name: def.key.replace(/\./g, '_'),
    title: def.label,
    description: `${def.label}. ${does}`,
    inputSchema: effect === 'propose' ? PROPOSAL_INPUT : RUN_INPUT,
    annotations: { readOnlyHint: effect === 'read', destructiveHint: false, idempotentHint: effect !== 'propose', openWorldHint: false },
    effect,
    gate: def.gate,
    requiredScopes: [...def.scopes],
    family: def.family,
  };
}

/** The tools this tenant would expose: its offered capabilities, in catalog order. */
export function mcpCatalogFor(modules: TenantModules | null | undefined): McpToolPreview[] {
  return capabilitiesFor(modules).map(toolFor);
}
