/**
 * Brief 2-7 — the stdio forwarder. An MCP client that only speaks stdio
 * (a desktop app, an agent runtime) launches this; each newline-delimited
 * JSON-RPC message on stdin is POSTed to the Alto People MCP server with the
 * agent's credential, and each answer is written to stdout as one line.
 * Notifications (202, no body) write nothing. No dependencies.
 *
 * The forwarder holds no state and decides nothing: the server applies the
 * agent's scopes, hours, rate limit and kill switches on every message.
 */

/**
 * @param {{ url: string; token: string; fetch?: typeof fetch; write: (line: string) => void; log?: (line: string) => void }} o
 * @returns {(line: string) => Promise<void>}
 */
export function createForwarder(o) {
  const doFetch = o.fetch ?? fetch;
  const log = o.log ?? ((l) => process.stderr.write(`${l}\n`));
  return async function forward(line) {
    const text = line.trim();
    if (!text) return;
    let id = null;
    try {
      const msg = JSON.parse(text);
      id = msg && typeof msg === 'object' && 'id' in msg ? msg.id : null;
    } catch {
      o.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
      return;
    }
    try {
      const res = await doFetch(o.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${o.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: text,
      });
      if (res.status === 202) return;
      const body = await res.text();
      if (res.headers.get('content-type')?.includes('application/json')) {
        const parsed = JSON.parse(body);
        if (parsed && parsed.jsonrpc === '2.0') {
          o.write(JSON.stringify(parsed));
          return;
        }
        // The agent API's own refusals (401 revoked, 403 suspended, 429 rate limit) as a JSON-RPC error.
        const err = parsed?.error ?? {};
        if (id !== null) o.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32001, message: err.message ?? `HTTP ${res.status}`, data: { status: res.status, code: err.code ?? null } } }));
        return;
      }
      if (id !== null) o.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32001, message: `HTTP ${res.status}`, data: { status: res.status } } }));
    } catch (err) {
      log(`alto-mcp: ${err instanceof Error ? err.message : String(err)}`);
      if (id !== null) o.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32002, message: 'The Alto People server could not be reached.' } }));
    }
  };
}
