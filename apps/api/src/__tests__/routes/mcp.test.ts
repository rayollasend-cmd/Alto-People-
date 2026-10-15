import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../app.js';
import { grantCapability, suspendCapability } from '../../lib/agentCapabilities.js';
import { resetAgentRateLimits } from '../../lib/agents.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';
import { invalidateTenantProfile } from '../../lib/tenantProfile.js';
import { agent, loginAs } from '../../../test/http.js';
import { createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { createForwarder } from '../../../../../packages/mcp-stdio/forwarder.mjs';

/**
 * Brief 2-7 — the MCP server.
 *
 *   Agent credentials only; tools are the capabilities the tenant offers and
 *   the agent holds (a suspended one disappears); a gated tool files an
 *   approval and returns its id with status "pending", and nothing else
 *   happens: the shift stays open until a person decides. Protocol mistakes
 *   are JSON-RPC errors; tool failures are results with isError. The stdio
 *   forwarder runs a sample agent end to end against a listening server.
 */

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

beforeEach(async () => {
  await truncateAll();
  resetAgentRateLimits();
  invalidateTenantProfile();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function world() {
  const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
  const admin = await loginAs(agent(), hr.email);
  const reg = await admin.post('/agents').send({ name: 'Fill helper', ownerUserId: hr.id, purpose: 'Proposes cover for open shifts', vendor: 'Anthropic', model: 'claude', modelVersion: '1', scopes: ['view:scheduling', 'view:org', 'manage:scheduling'], status: 'ACTIVE' });
  expect(reg.status, JSON.stringify(reg.body)).toBe(201);
  const workerId = reg.body.id as string;
  await grantCapability(prisma, workerId, 'shift.fill', ALTO_TENANT_ID);
  const cred = await admin.post(`/agents/${workerId}/credentials`).send({ ttlHours: 24 });
  expect(cred.status).toBe(201);
  const client = await createClient('Harbor Hotel');
  const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  const shift = await prisma.shift.create({ data: { clientId: client.id, locationId: site.id, position: 'Houseman', startsAt: new Date(Date.now() + 2 * 86_400_000), endsAt: new Date(Date.now() + 2 * 86_400_000 + 8 * 3_600_000), status: 'OPEN' } });
  return { hr, workerId, token: cred.body.plaintext as string, shift };
}

const rpc = (token: string, body: unknown) => agent().post('/mcp').set(bearer(token)).send(body as object);

describe('the MCP server', () => {
  it('initializes, lists the held tools, and a gated call returns a pending approval and changes nothing', async () => {
    const { token, shift, workerId } = await world();

    const init = await rpc(token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    expect(init.status).toBe(200);
    expect(init.body.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'alto-people' } });

    const note = await rpc(token, { jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(note.status).toBe(202);

    const list = await rpc(token, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = (list.body.result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toEqual(['whoami', 'approval_status', 'shift_fill']);

    const call = await rpc(token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'shift_fill', arguments: { subjectType: 'Shift', subjectId: shift.id, summary: 'Put Tess on the Houseman shift', payload: { shiftId: shift.id } } } });
    expect(call.status).toBe(200);
    const out = call.body.result.structuredContent as { approvalId: string; status: string };
    expect(out.status).toBe('pending');
    expect(call.body.result.isError).toBeUndefined();

    const approval = await prisma.agentApprovalRequest.findUniqueOrThrow({ where: { id: out.approvalId } });
    expect(approval).toMatchObject({ workerId, action: 'SHIFT_ASSIGN', status: 'PENDING' });
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: shift.id } })).assignedAssociateId).toBeNull();

    const status = await rpc(token, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'approval_status', arguments: { approvalId: out.approvalId } } });
    expect(status.body.result.structuredContent).toMatchObject({ approvalId: out.approvalId, status: 'pending' });
  });

  it('a suspended capability is not a tool, and calling it is a tool error', async () => {
    const { token, hr, workerId } = await world();
    await suspendCapability(prisma, workerId, 'shift.fill', ALTO_TENANT_ID, hr.id, 'Review');
    const list = await rpc(token, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect((list.body.result.tools as Array<{ name: string }>).map((t) => t.name)).not.toContain('shift_fill');
    const call = await rpc(token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'shift_fill', arguments: {} } });
    expect(call.body.result).toMatchObject({ isError: true, structuredContent: { error: 'tool_not_available' } });
  });

  it('bad arguments are a tool error the model can read; protocol mistakes are JSON-RPC errors', async () => {
    const { token } = await world();
    const bad = await rpc(token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'shift_fill', arguments: { subjectType: 'Shift' } } });
    expect(bad.body.result.isError).toBe(true);
    expect(bad.body.result.content[0].text).toMatch(/summary/);

    expect((await rpc(token, { jsonrpc: '2.0', id: 2, method: 'resources/read' })).body.error.code).toBe(-32601);
    expect((await rpc(token, [{ jsonrpc: '2.0', id: 3, method: 'ping' }])).body.error.code).toBe(-32600);
    expect((await rpc(token, { id: 4, method: 'ping' })).body.error.code).toBe(-32600);
    expect((await rpc(token, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: {} })).body.error.code).toBe(-32602);
    expect((await rpc(token, { jsonrpc: '2.0', id: 6, method: 'ping' })).body).toEqual({ jsonrpc: '2.0', id: 6, result: {} });
  });

  it('only an agent credential gets in; a foreign Origin is refused; GET opens no stream', async () => {
    const { token } = await world();
    expect((await agent().post('/mcp').send({ jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(401);
    expect((await rpc('alto_agent_' + '0'.repeat(64), { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(401);
    expect((await agent().post('/mcp').set(bearer(token)).set('Origin', 'https://evil.example').send({ jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(403);
    expect((await agent().get('/mcp').set(bearer(token))).status).toBe(405);
  });

  it('every call is logged under the agent as mcp.<method>', async () => {
    const { token, workerId } = await world();
    await rpc(token, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const { flushPendingAudits } = await import('../../lib/audit.js');
    await flushPendingAudits();
    const rows = await prisma.auditLog.findMany({ where: { workerId, action: 'mcp.tools/list' } });
    expect(rows).toHaveLength(1);
  });
});

describe('a sample agent through the stdio forwarder', () => {
  it('initializes, finds its tool, files a proposal and follows it, all over stdio lines', async () => {
    const { token, shift } = await world();
    const server = createApp().listen(0);
    await new Promise<void>((r) => server.once('listening', () => r()));
    try {
      const out: string[] = [];
      const forward = createForwarder({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, token, write: (l) => out.push(l), log: () => {} });
      const send = async (msg: unknown) => {
        await forward(JSON.stringify(msg));
        return out.length ? JSON.parse(out[out.length - 1]!) : null;
      };

      await send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'sample-agent', version: '1' } } });
      const before = out.length;
      await forward(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
      expect(out.length).toBe(before); // a notification writes nothing

      const tools = await send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      const fill = (tools.result.tools as Array<{ name: string; annotations: { readOnlyHint: boolean } }>).find((t) => t.name === 'shift_fill');
      expect(fill?.annotations.readOnlyHint).toBe(false);

      const filed = await send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'shift_fill', arguments: { subjectType: 'Shift', subjectId: shift.id, summary: 'Cover the Houseman shift', payload: {} } } });
      const approvalId = filed.result.structuredContent.approvalId as string;
      const followed = await send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'approval_status', arguments: { approvalId } } });
      expect(followed.result.structuredContent.status).toBe('pending');

      await forward('not json');
      expect(JSON.parse(out[out.length - 1]!).error.code).toBe(-32700);

      // A revoked credential: the agent API's 401 reaches the client as a JSON-RPC error.
      const bad = createForwarder({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, token: 'alto_agent_' + 'f'.repeat(64), write: (l) => out.push(l), log: () => {} });
      await bad(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping' }));
      expect(JSON.parse(out[out.length - 1]!)).toMatchObject({ id: 9, error: { code: -32001, data: { status: 401 } } });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
