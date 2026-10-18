import { describe, expect, it } from 'vitest';
import { IN_CHUNK, findInChunks } from '../../lib/chunkedIn.js';

/** Postgres stops at 32,767 bind parameters; one-id-per-person lists go in chunks. */
describe('findInChunks', () => {
  it('runs once for a list under the chunk size', async () => {
    const calls: number[] = [];
    const out = await findInChunks(['a', 'b'], async (chunk) => {
      calls.push(chunk.length);
      return chunk;
    });
    expect(calls).toEqual([2]);
    expect(out).toEqual(['a', 'b']);
  });

  it('splits 50,000 ids into chunks under the parameter cap and keeps every row', async () => {
    const ids = Array.from({ length: 50_000 }, (_, i) => `id${i}`);
    const sizes: number[] = [];
    const out = await findInChunks(ids, async (chunk) => {
      sizes.push(chunk.length);
      return chunk.map((id) => ({ id }));
    });
    expect(Math.max(...sizes)).toBeLessThanOrEqual(IN_CHUNK);
    expect(Math.max(...sizes)).toBeLessThan(32_767);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(50_000);
    expect(out).toHaveLength(50_000);
    expect(out[49_999]).toEqual({ id: 'id49999' });
  });
});
