#!/usr/bin/env node
// ALTO_MCP_URL=https://people.altohr.com/api/mcp ALTO_AGENT_TOKEN=alto_agent_… alto-mcp
import { createInterface } from 'node:readline';
import { createForwarder } from './forwarder.mjs';

const url = process.env.ALTO_MCP_URL;
const token = process.env.ALTO_AGENT_TOKEN;
if (!url || !token) {
  process.stderr.write('alto-mcp: set ALTO_MCP_URL and ALTO_AGENT_TOKEN.\n');
  process.exit(2);
}

const forward = createForwarder({ url, token, write: (line) => process.stdout.write(`${line}\n`) });
// Messages are answered in the order they arrive, one at a time.
let queue = Promise.resolve();
createInterface({ input: process.stdin }).on('line', (line) => {
  queue = queue.then(() => forward(line));
});
