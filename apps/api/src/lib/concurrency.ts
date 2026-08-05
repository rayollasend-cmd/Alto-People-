/**
 * Run `fn` over `items` with at most `limit` in flight at once.
 *
 * The house middle ground between a fully-serial `for..await` (blocks a
 * request for minutes on long external-call loops) and an unbounded
 * `Promise.all` (exhausts the Prisma connection pool / provider rate
 * limits). Rejections propagate: the first error aborts scheduling of new
 * work and rejects the whole call — callers that want per-item error
 * isolation should catch inside `fn`.
 */
export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const width = Math.max(1, Math.min(limit, items.length));
  let next = 0;
  let failed: unknown = null;
  const workers = Array.from({ length: width }, async () => {
    while (failed === null) {
      const i = next++;
      if (i >= items.length) return;
      try {
        await fn(items[i]!, i);
      } catch (err) {
        failed = err ?? new Error('runWithConcurrency task failed');
        throw err;
      }
    }
  });
  await Promise.all(workers);
}
