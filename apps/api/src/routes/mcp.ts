import { Router, type NextFunction, type Request, type Response } from 'express';
import { prisma } from '../db.js';
import { env } from '../config/env.js';
import { recordAgentCalls, requireAgent } from '../middleware/agentAuth.js';
import { handleMcpMessage } from '../lib/mcpServer.js';

/**
 * Brief 2-7 — the MCP endpoint (lib/mcpServer has the protocol).
 *
 *   POST /mcp   one JSON-RPC message; the answer is application/json, or 202
 *               with no body for a notification. Bearer alto_agent_… only.
 *   GET  /mcp   405: this server opens no server-sent stream.
 *
 *   A browser Origin that is not the app's own is refused (the transport's
 *   DNS-rebinding rule); agents send none. Every call is logged under the
 *   agent as mcp.<method>, like any /agent/v1 call.
 */

export const mcpRouter = Router();

function checkOrigin(req: Request, res: Response, next: NextFunction): void {
  const origin = req.header('origin');
  if (origin && !env.CORS_ORIGIN.includes(origin)) {
    res.status(403).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Origin not allowed.' } });
    return;
  }
  next();
}

mcpRouter.use(checkOrigin);
mcpRouter.use(recordAgentCalls);

mcpRouter.post('/', requireAgent(), async (req, res, next) => {
  try {
    const body: unknown = req.body;
    const method = body && typeof body === 'object' && !Array.isArray(body) && typeof (body as { method?: unknown }).method === 'string' ? (body as { method: string }).method : 'invalid';
    res.locals.agentAction = `mcp.${method}`.slice(0, 80);
    const answer = await handleMcpMessage(prisma, req.agent!, body);
    if (!answer) {
      res.status(202).end();
      return;
    }
    res.json(answer);
  } catch (err) {
    next(err);
  }
});

const notHere = (_req: Request, res: Response) => {
  res.setHeader('Allow', 'POST');
  res.status(405).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Send JSON-RPC messages by POST; this server opens no stream.' } });
};
mcpRouter.get('/', notHere);
mcpRouter.delete('/', notHere);
