/**
 * Postgres caps a prepared statement at 32,767 bind parameters, and Prisma
 * sends `{ in: ids }` as one parameter per id — so a payroll for 50,000
 * people failed outright ("too many bind variables"). Every query that
 * takes one id per person goes through here: it runs in chunks well under
 * the cap and concatenates the rows.
 */
export const IN_CHUNK = 10_000;

export async function findInChunks<T>(ids: readonly string[], run: (chunk: string[]) => Promise<T[]>, size = IN_CHUNK): Promise<T[]> {
  if (ids.length <= size) return run([...ids]);
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += size) {
    out.push(...(await run(ids.slice(i, i + size))));
  }
  return out;
}
