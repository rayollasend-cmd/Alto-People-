import { afterEach, describe, expect, it, vi } from 'vitest';
import { askHugo } from '@/lib/hugoApi';
import { ApiError } from '@/lib/api';

/**
 * Asking with `onEvent`: the stream's lines as they land (steps, words), the
 * answer from its `done` line — and the plain ask when the stream itself is
 * the problem (an older server), never when the server said no.
 */
const ndjson = (lines: unknown[], status = 200) => {
  const enc = new TextEncoder();
  const text = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  // Split mid-line, as a network does.
  const cut = Math.floor(text.length / 2);
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode(text.slice(0, cut)));
      c.enqueue(enc.encode(text.slice(cut)));
      c.close();
    },
  });
  return new Response(body, { status, headers: { 'Content-Type': 'application/x-ndjson' } });
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('askHugo, live', () => {
  it('hands each step and word over as it lands, and resolves with the answer', async () => {
    const answer = { intent: 'MODEL', reply: 'Tomorrow 6–2.', linkUrl: null, source: 'model', tier: 'fast' };
    const fetch = vi.fn(async () => ndjson([{ t: 'step', step: 'schedule' }, { t: 'text', d: 'Tomorrow ' }, { t: 'text', d: '6–2.' }, { t: 'done', answer }]));
    vi.stubGlobal('fetch', fetch);
    const seen: unknown[] = [];
    const out = await askHugo('when do I work?', { onEvent: (e) => seen.push(e) });
    expect(out).toEqual(answer);
    expect(seen).toEqual([{ t: 'step', step: 'schedule' }, { t: 'text', d: 'Tomorrow ' }, { t: 'text', d: '6–2.' }]);
    expect(fetch).toHaveBeenCalledWith('/api/hugo/ask/stream', expect.objectContaining({ method: 'POST', credentials: 'include' }));
  });

  it('an older server without the stream: asks the plain way', async () => {
    const answer = { intent: 'PAYDAY', reply: 'Friday.', linkUrl: '/payroll' };
    const fetch = vi.fn(async (url: string) => (url.endsWith('/stream') ? json({ error: { code: 'not_found', message: 'Not found' } }, 404) : json(answer)));
    vi.stubGlobal('fetch', fetch);
    expect(await askHugo('payday?', { onEvent: () => {} })).toEqual(answer);
    expect(fetch.mock.calls.map((c) => c[0])).toEqual(['/api/hugo/ask/stream', '/api/hugo/ask']);
  });

  it('a refusal is the answer: no second ask', async () => {
    const fetch = vi.fn(async () => json({ error: { code: 'hugo_off', message: 'The assistant is switched off for now.' } }, 409));
    vi.stubGlobal('fetch', fetch);
    await expect(askHugo('hi', { onEvent: () => {} })).rejects.toBeInstanceOf(ApiError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('a stream cut off before its answer says so', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ndjson([{ t: 'text', d: 'Tomor' }, { t: 'error', message: 'The assistant could not answer.' }])));
    await expect(askHugo('when?', { onEvent: () => {} })).rejects.toMatchObject({ status: 502, message: 'The assistant could not answer.' });
  });
});
