import { z } from 'zod';
import { capabilitiesFor, type AgentCapabilityDef, type AgentCapabilityKey } from '@alto-people/shared';
import type { PrismaClient } from '@prisma/client';
import { HttpError } from '../middleware/error.js';
import { createProposal } from './agentCapabilities.js';
import { getApproval, type AgentContext } from './agents.js';
import { toolFor, type McpToolPreview } from './mcpCatalog.js';
import { ALTO_TENANT_ID } from './tenant.js';
import { loadTenantProfile } from './tenantProfile.js';

/**
 * Brief 2-7 — the MCP server: a thin layer over the agent API.
 *
 *   JSON-RPC 2.0 over one HTTP endpoint (the Streamable HTTP transport,
 *   stateless: every POST carries one message and its answer is JSON; no
 *   session, no server-sent stream). Agent credentials only, through
 *   requireAgent, so the kill switches, hours, rate limit and scopes apply
 *   to every call exactly as on /agent/v1.
 *
 *   tools/list — the capabilities this tenant offers (mcpCatalogFor, the
 *   same generation the Agents page previews) that this agent HOLDS, enabled
 *   and not suspended; plus whoami and approval_status.
 *
 *   tools/call — a capability tool files a proposal through createProposal,
 *   the agent API's one write path. A gated one returns its approval id and
 *   status "pending" and does nothing else; a person decides in the app.
 *   Tool failures come back as a result with isError (the model can read
 *   them); protocol mistakes as JSON-RPC errors.
 */

export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
const LATEST = MCP_PROTOCOL_VERSIONS[0];
export const MCP_SERVER_INFO = { name: 'alto-people', title: 'Alto People', version: '1.0.0' };

type Db = PrismaClient;
type Id = string | number | null;

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: Id;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export const RPC = { parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internal: -32603 } as const;

const MessageSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
});

const ok = (id: Id, result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, result });
const fail = (id: Id, code: number, message: string, data?: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } });

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

const result = (structured: Record<string, unknown>, text?: string): ToolResult => ({
  content: [{ type: 'text', text: text ?? JSON.stringify(structured) }],
  structuredContent: structured,
});
const toolError = (text: string, code?: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true, ...(code ? { structuredContent: { error: code } } : {}) });

const BUILT_IN_TOOLS = [
  {
    name: 'whoami',
    title: 'Who am I',
    description: 'This agent: name, status, granted scopes and the capabilities it holds. Reads only.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'approval_status',
    title: 'Where an approval stands',
    description: 'The status of an approval this agent asked for (pending, approved, denied, expired), with the decision note. Reads only.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['approvalId'], properties: { approvalId: { type: 'string', format: 'uuid' } } },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
] as const;

/** The capability tools this agent may call: offered here AND held, enabled, not suspended. */
export async function toolsForAgent(db: Db, agent: AgentContext): Promise<Array<{ def: AgentCapabilityDef; tool: McpToolPreview }>> {
  const tenantId = agent.tenantId ?? ALTO_TENANT_ID;
  const [profile, held] = await Promise.all([
    loadTenantProfile(tenantId),
    db.agentCapability.findMany({ where: { workerId: agent.workerId, tenantId, enabled: true, suspendedAt: null }, select: { key: true } }),
  ]);
  const keys = new Set(held.map((h) => h.key));
  // The same generation as the Agents page preview (mcpCatalogFor), narrowed to what this agent holds.
  return capabilitiesFor(profile.modules)
    .filter((def) => keys.has(def.key))
    .map((def) => ({ def, tool: toolFor(def) }));
}

const wire = (t: McpToolPreview) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations });

const ProposalArgs = z
  .object({
    subjectType: z.string().trim().min(2).max(40),
    subjectId: z.string().uuid().nullable().optional(),
    summary: z.string().trim().min(3).max(500),
    payload: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
const RunArgs = z.object({}).strict();

async function callTool(db: Db, agent: AgentContext, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  if (name === 'whoami') {
    const tools = await toolsForAgent(db, agent);
    return result({ workerId: agent.workerId, name: agent.name, status: agent.status, scopes: agent.scopes, capabilities: tools.map((t) => t.def.key) });
  }
  if (name === 'approval_status') {
    const parsed = z.object({ approvalId: z.string().uuid() }).strict().safeParse(args);
    if (!parsed.success) return toolError('approvalId must be the id a proposal returned.', 'invalid_arguments');
    try {
      const a = await getApproval(db, parsed.data.approvalId, agent.tenantId);
      if (a.workerId !== agent.workerId) return toolError('No such approval for this agent.', 'approval_not_found');
      return result({ approvalId: a.id, action: a.action, status: a.status.toLowerCase(), requestedAt: a.requestedAt, expiresAt: a.expiresAt, decidedAt: a.decidedAt, decisionNote: a.decisionNote });
    } catch (err) {
      if (err instanceof HttpError) return toolError(err.message, err.code);
      throw err;
    }
  }

  const found = (await toolsForAgent(db, agent)).find((t) => t.tool.name === name);
  if (!found) return toolError(`No tool ${name} for this agent: it is not offered here, not held, or suspended.`, 'tool_not_available');
  const { def, tool } = found;

  let input: { subjectType: string; subjectId: string | null; summary?: string; payload: Record<string, unknown> };
  if (tool.effect === 'propose') {
    const parsed = ProposalArgs.safeParse(args);
    if (!parsed.success) return toolError(`Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'} ${i.message}`).join('; ')}.`, 'invalid_arguments');
    input = { subjectType: parsed.data.subjectType, subjectId: parsed.data.subjectId ?? null, summary: parsed.data.summary, payload: parsed.data.payload };
  } else {
    if (!RunArgs.safeParse(args).success) return toolError('This tool takes no arguments.', 'invalid_arguments');
    input = { subjectType: 'Run', subjectId: null, payload: {} };
  }

  try {
    const r = await createProposal(db, agent, { capability: def.key as AgentCapabilityKey, ...input });
    if (r.approvalId) {
      return result(
        { approvalId: r.approvalId, status: 'pending', proposalId: r.proposal.id, created: r.created },
        `Filed for approval (${def.gate}). Nothing happens until a person approves; check with approval_status using approvalId ${r.approvalId}.`,
      );
    }
    return result({ proposalId: r.proposal.id, status: 'recorded' }, `Recorded as proposal ${r.proposal.id}.`);
  } catch (err) {
    if (err instanceof HttpError) return toolError(err.message, err.code);
    throw err;
  }
}

/**
 * One JSON-RPC message in, its answer out (null for a notification, which
 * gets 202 and no body). `agent` is the authenticated caller.
 */
export async function handleMcpMessage(db: Db, agent: AgentContext, raw: unknown): Promise<JsonRpcResponse | null> {
  if (Array.isArray(raw)) return fail(null, RPC.invalidRequest, 'Batches are not supported; send one message per request.');
  const parsed = MessageSchema.safeParse(raw);
  if (!parsed.success) {
    // A response or a malformed message from the client: nothing to answer by id.
    const id = raw && typeof raw === 'object' && 'id' in raw ? ((raw as { id: Id }).id ?? null) : null;
    if (raw && typeof raw === 'object' && ('result' in raw || 'error' in raw)) return null;
    return fail(id, RPC.invalidRequest, 'Not a JSON-RPC 2.0 request.');
  }
  const { id, method, params = {} } = parsed.data;
  if (id === undefined) return null; // notifications/initialized, notifications/cancelled, …

  switch (method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : LATEST;
      const protocolVersion = (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : LATEST;
      return ok(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: MCP_SERVER_INFO,
        instructions:
          'Alto People. Tools are this agent’s capabilities. A tool that proposes files an approval and returns its id with status "pending": nothing happens until a person approves it in Alto. Use approval_status to follow it. Never retry a pending proposal to hurry it.',
      });
    }
    case 'ping':
      return ok(id, {});
    case 'tools/list': {
      const tools = await toolsForAgent(db, agent);
      return ok(id, { tools: [...BUILT_IN_TOOLS, ...tools.map((t) => wire(t.tool))] });
    }
    case 'tools/call': {
      const p = z.object({ name: z.string().min(1), arguments: z.record(z.string(), z.unknown()).default({}) }).safeParse(params);
      if (!p.success) return fail(id, RPC.invalidParams, 'tools/call needs a name and an arguments object.');
      return ok(id, await callTool(db, agent, p.data.name, p.data.arguments));
    }
    default:
      return fail(id, RPC.methodNotFound, `Method not found: ${method}`);
  }
}
