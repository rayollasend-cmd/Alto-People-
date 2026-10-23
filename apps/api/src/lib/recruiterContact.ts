import type { Prisma, PrismaClient } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * The person a candidate can reach (F500 G5): offer and candidate pages said
 * "contact your recruiter" and never said who. A name (the person's own, or
 * the name their invite addressed — never an email's local part), their work
 * email, and the phone on their record when there is one. Nothing else.
 */
export interface RecruiterContact {
  name: string | null;
  email: string;
  phone: string | null;
}

export const RECRUITER_USER_SELECT = {
  email: true,
  displayName: true,
  status: true,
  deletedAt: true,
  associate: { select: { firstName: true, lastName: true, phone: true } },
} as const;

type RecruiterUserRow = {
  email: string;
  displayName: string | null;
  status: string;
  deletedAt: Date | null;
  associate: { firstName: string; lastName: string; phone: string | null } | null;
};

export function recruiterContactOf(u: RecruiterUserRow | null | undefined): RecruiterContact | null {
  if (!u || u.deletedAt || u.status !== 'ACTIVE') return null;
  const own = u.associate ? `${u.associate.firstName} ${u.associate.lastName}`.trim() : '';
  return { name: own || u.displayName?.trim() || null, email: u.email, phone: u.associate?.phone ?? null };
}

/**
 * The recruiter working a candidate: whoever last sent them their page link,
 * else whoever opened the posting they applied to.
 */
export async function candidateRecruiter(db: Db, candidateId: string): Promise<RecruiterContact | null> {
  const [sent, candidate] = await Promise.all([
    db.candidateEvent.findFirst({
      where: { candidateId, kind: 'PORTAL_LINK_SENT', actorUserId: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { actor: { select: RECRUITER_USER_SELECT } },
    }),
    db.candidate.findUnique({ where: { id: candidateId }, select: { jobPosting: { select: { createdBy: { select: RECRUITER_USER_SELECT } } } } }),
  ]);
  return recruiterContactOf(sent?.actor) ?? recruiterContactOf(candidate?.jobPosting?.createdBy);
}
