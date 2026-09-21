import v8 from 'node:v8';
import { logger } from './logger.js';
import { captureException } from './sentry.js';

/**
 * WHY THE PROCESS DIED, RECORDED BEFORE IT DIES.
 *
 * The app was being OOM-killed with nothing to show for it. A container
 * OOM is a SIGKILL: no stack, no exit handler, no Sentry event — just a
 * restart, and `restartPolicyMaxRetries: 3` means the fourth one leaves
 * the service down. Everything anyone knew came from a memory figure
 * Sentry happened to attach to an unrelated error (2.6 GiB after 19
 * minutes; 7.9 GiB after five hours), which is enough to know there is a
 * problem and not enough to say what it is.
 *
 * The distinction this exists to settle:
 *
 *   heapUsed climbing and never falling  → a reference leak; something is
 *                                          retained. A heap snapshot will
 *                                          name it.
 *   external/arrayBuffers climbing       → BUFFERS, not objects. Every
 *                                          document download reads the
 *                                          whole file into memory
 *                                          (blobStore.get → res.send), so
 *                                          concurrency multiplies, and
 *                                          --max-old-space-size does not
 *                                          bound it because Buffers live
 *                                          outside V8's heap.
 *   rss high, heapUsed flat              → high-water mark, not a leak:
 *                                          Node is slow to return freed
 *                                          pages to the OS.
 *
 * Logged as one line per sample so it can be grepped straight out of the
 * platform logs, and escalated to Sentry once per threshold crossing so
 * the alarm arrives while the process is still alive to explain itself.
 */

const SAMPLE_MS = 60_000;

/**
 * The ceiling is explicit now — 16GB of a 24GB container — which leaves
 * roughly 8GB for everything outside the heap.
 *
 * That headroom is the number to watch, because `external` counts toward
 * the CONTAINER limit but NOT toward the heap ceiling: heap and Buffers
 * can each look reasonable while their sum is not. If externalMb starts
 * eating into it, the answer is to bound concurrency, not to raise the
 * ceiling again — there is nothing left to raise it into.
 */

/** Fraction of the heap ceiling that counts as "about to be a problem". */
const HEAP_WARN = 0.75;
const HEAP_ALARM = 0.9;

/** External (Buffer) bytes worth shouting about regardless of the heap. */
const EXTERNAL_WARN_BYTES = 512 * 1024 * 1024;

const MB = 1024 * 1024;
const mb = (bytes: number) => Math.round(bytes / MB);

let timer: NodeJS.Timeout | null = null;
/** Highest RSS seen, so a restart's logs show the peak, not the last dip. */
let peakRss = 0;
/** One alarm per crossing, not one a minute for the rest of the process. */
let warned = false;
let alarmed = false;

export interface MemorySample {
  rssMb: number;
  heapUsedMb: number;
  heapLimitMb: number;
  /** Buffers and other native allocations — NOT part of the V8 heap. */
  externalMb: number;
  arrayBuffersMb: number;
  heapFraction: number;
  peakRssMb: number;
  uptimeMin: number;
}

export function sampleMemory(): MemorySample {
  const m = process.memoryUsage();
  const limit = v8.getHeapStatistics().heap_size_limit;
  peakRss = Math.max(peakRss, m.rss);
  return {
    rssMb: mb(m.rss),
    heapUsedMb: mb(m.heapUsed),
    heapLimitMb: mb(limit),
    externalMb: mb(m.external),
    arrayBuffersMb: mb(m.arrayBuffers),
    heapFraction: Math.round((m.heapUsed / limit) * 100) / 100,
    peakRssMb: mb(peakRss),
    uptimeMin: Math.round(process.uptime() / 60),
  };
}

function check(): void {
  const s = sampleMemory();
  logger.info({ memory: s }, 'memory');

  // Buffers first: they are outside the heap, so the heap fraction can
  // look healthy while RSS is running away.
  if (s.externalMb * MB > EXTERNAL_WARN_BYTES && !warned) {
    warned = true;
    logger.warn(
      { memory: s },
      'memory: external/Buffer memory is high — this is file bytes, not objects',
    );
  }

  if (s.heapFraction >= HEAP_ALARM && !alarmed) {
    alarmed = true;
    logger.error({ memory: s }, 'memory: heap at 90% of its ceiling');
    // Reported while the process can still answer for itself — an OOM
    // kill sends SIGKILL and no handler runs.
    captureException(new Error('Heap at 90% of its ceiling'), {
      memory: JSON.stringify(s),
    });
  } else if (s.heapFraction >= HEAP_WARN && !warned) {
    warned = true;
    logger.warn({ memory: s }, 'memory: heap at 75% of its ceiling');
  }
}

export function startMemoryWatch(): void {
  if (timer) return;
  check();
  timer = setInterval(check, SAMPLE_MS);
  timer.unref?.();
  const s = sampleMemory();
  // Expect ~16000MB (railway.json passes --max-old-space-size=16000 for a
  // 24GB container). Seeing ~4096 instead means the flag did not reach
  // this process — Node's default ceiling is ~4GB however large the
  // machine, so the app can throw a V8 heap OOM with most of the
  // container still free.
  logger.info({ memory: s }, `memory watch armed — heap ceiling ${s.heapLimitMb}MB`);
}

export function stopMemoryWatch(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Test seam. */
export function resetMemoryWatchForTests(): void {
  peakRss = 0;
  warned = false;
  alarmed = false;
}
