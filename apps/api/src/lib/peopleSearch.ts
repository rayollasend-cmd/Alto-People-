import { Prisma, type PrismaClient } from '@prisma/client';

/**
 * Search people the way HR types (PEOPLE-6, PEOPLE-15).
 *
 *   "Maria Lopez", "lopez maria", "López, María", "Hector" for Héctor,
 *   "555-3183" or "555 3183" for (555) 555-3183. Every word must match
 *   SOME field (first name, last name, other last names, email, and —
 *   per table — phone digits or position), so a full name finds the
 *   person and two words never have to sit in one column. Accents are
 *   ignored on both sides; a word with three or more digits also matches
 *   the phone number by its digits.
 *
 *   Returns the matching ids inside the tenant; the caller ANDs
 *   `{ id: { in } }` with its own scope (scopeWhere), so reach is never
 *   widened here.
 */

type Db = PrismaClient | Prisma.TransactionClient;

/** Accented letters and what they fold to (same length, position by position). */
const FROM = 'áàâäãåāéèêëēíìîïīóòôöõøōúùûüūñçýÿ';
const TO = 'aaaaaaaeeeeeiiiiiooooooouuuuuncyy';

/** Lowercase, accents off: "María" → "maria". */
export function foldText(s: string): string {
  return s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

/** The words of a search, folded: split on spaces and commas, at most six. */
export function searchWords(q: string | null | undefined): string[] {
  return foldText(q ?? '')
    .split(/[\s,]+/)
    .map((w) => w.trim())
    .filter(Boolean)
    .slice(0, 6);
}

const likeEscape = (w: string) => w.replace(/[\\%_]/g, (c) => `\\${c}`);

export interface SearchTable {
  table: 'Associate' | 'Candidate';
  /** Text columns folded and matched by substring. */
  text: readonly string[];
  /** Text[] columns (joined) matched the same way. */
  arrays?: readonly string[];
  /** The phone column, matched by digits. */
  phone?: string;
}

export const ASSOCIATE_SEARCH: SearchTable = { table: 'Associate', text: ['firstName', 'lastName', 'email'], arrays: ['otherLastNames'], phone: 'phone' };
export const CANDIDATE_SEARCH: SearchTable = { table: 'Candidate', text: ['firstName', 'lastName', 'email', 'position'], phone: 'phone' };

const fold = (sql: Prisma.Sql) => Prisma.sql`translate(lower(${sql}), ${FROM}, ${TO})`;

/** Ids in `tenantId` whose fields match every word of `q` (accents and phone punctuation ignored). Not deleted. */
export async function idsMatching(db: Db, spec: SearchTable, tenantId: string, q: string): Promise<string[]> {
  const words = searchWords(q);
  if (words.length === 0) return [];
  const clauses = words.map((w) => {
    const like = `%${likeEscape(w)}%`;
    const ors: Prisma.Sql[] = [
      ...spec.text.map((c) => Prisma.sql`${fold(Prisma.sql`coalesce(${Prisma.raw(`"${c}"`)}, '')`)} LIKE ${like}`),
      ...(spec.arrays ?? []).map((c) => Prisma.sql`${fold(Prisma.sql`array_to_string(${Prisma.raw(`"${c}"`)}, ' ')`)} LIKE ${like}`),
    ];
    const digits = w.replace(/\D/g, '');
    if (spec.phone && digits.length >= 3) {
      ors.push(Prisma.sql`regexp_replace(coalesce(${Prisma.raw(`"${spec.phone}"`)}, ''), '\\D', '', 'g') LIKE ${`%${digits}%`}`);
    }
    return Prisma.sql`(${Prisma.join(ors, ' OR ')})`;
  });
  const rows = await db.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT "id"::text AS id FROM ${Prisma.raw(`"${spec.table}"`)} WHERE "tenantId" = ${tenantId}::uuid AND "deletedAt" IS NULL AND ${Prisma.join(clauses, ' AND ')}`,
  );
  return rows.map((r) => r.id);
}
