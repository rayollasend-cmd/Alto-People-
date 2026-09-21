import { describe, expect, it } from 'vitest';
import { sampleMemory } from '../../lib/memoryWatch.js';

/**
 * The crash left no evidence: a container OOM is a SIGKILL, so no handler
 * runs and nothing reaches Sentry. Everything anyone knew came from a
 * memory figure Sentry happened to attach to an unrelated error.
 *
 * What this sample has to carry is the distinction that decides the next
 * move — heap versus external. 7.9 GiB of RSS against a ~4 GiB default
 * heap ceiling meant most of it was Buffers, which is why
 * --max-old-space-size would have changed nothing.
 */
describe('the memory sample', () => {
  it('separates the heap from the Buffers, which is the whole point', () => {
    const s = sampleMemory();
    // Objects.
    expect(s.heapUsedMb).toBeGreaterThan(0);
    expect(s.heapLimitMb).toBeGreaterThan(0);
    expect(s.heapFraction).toBeGreaterThan(0);
    // Bytes. Reported separately because they count toward the container
    // limit but NOT toward the heap ceiling — a heap that looks healthy
    // can sit beside an RSS that is about to be killed.
    expect(s).toHaveProperty('externalMb');
    expect(s).toHaveProperty('arrayBuffersMb');
    // RSS is the number the container actually enforces.
    expect(s.rssMb).toBeGreaterThanOrEqual(s.heapUsedMb);
  });

  it('remembers the peak, so a restart shows what it reached', () => {
    const first = sampleMemory();
    const second = sampleMemory();
    // Never falls: the last sample before a kill is often a dip, and the
    // peak is the number worth knowing.
    expect(second.peakRssMb).toBeGreaterThanOrEqual(first.peakRssMb);
    expect(second.peakRssMb).toBeGreaterThanOrEqual(second.rssMb - 1);
  });
});
