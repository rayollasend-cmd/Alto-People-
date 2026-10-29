import type { Prisma, PrismaClient } from '@prisma/client';
import { orgDateKey } from '../../timeAnomalies.js';

/** Small helpers the payables modules share. */

export type Db = PrismaClient | Prisma.TransactionClient;

// eslint-disable-next-line no-restricted-syntax -- UTC on purpose: @db.Date values and day keys at UTC midnight; today is todayYmd().
export const ymd = (d: Date): string => d.toISOString().slice(0, 10);
export const dateOnly = (s: string): Date => new Date(`${s}T00:00:00.000Z`);
/** Today on the company's calendar (deep audit MONEY-16): after 8 PM Eastern UTC is already tomorrow, and a payment, its aging and its "due" are company days. */
export const todayYmd = (now: Date = new Date()): string => orgDateKey(now);
export const addDays = (s: string, n: number): string => ymd(new Date(dateOnly(s).getTime() + n * 86_400_000));
export const daysBetween = (from: string, to: string): number => Math.round((dateOnly(to).getTime() - dateOnly(from).getTime()) / 86_400_000);
export const cents = (n: number | string | Prisma.Decimal | null | undefined): number => Math.round(Number(n ?? 0) * 100);
export const dollars = (c: number): number => Math.round(c) / 100;
export const money = (n: number): string => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** "Pat Lee" for a user id, else null. */
export async function userNames(db: Db, ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  if (want.length === 0) return new Map();
  const rows = await db.user.findMany({
    where: { id: { in: want } },
    select: { id: true, email: true, displayName: true, associate: { select: { firstName: true, lastName: true } } },
  });
  return new Map(rows.map((u) => [u.id, u.displayName ?? (u.associate ? `${u.associate.firstName} ${u.associate.lastName}`.trim() : u.email)]));
}
