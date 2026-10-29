import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * Is there anything on file behind a DONE onboarding task? (PEOPLE-17)
 *
 *   A task's status is a flag someone (or an import, or a seed) set; the
 *   evidence is the W-4, the payout method, the acknowledgments, the
 *   profile, the I-9. The application page showed "DONE" on a W-4 tile
 *   whose own panel said "Not submitted yet", and Approve stayed the
 *   primary action. The detail now carries, per DONE task of these kinds,
 *   whether the evidence is on file — the page says "Marked done — nothing
 *   on file" and Approve asks first.
 *
 *   'on_file' / 'missing' for DONE tasks of the kinds below; nothing for
 *   other kinds or other statuses (a SKIPPED task has a reason instead).
 */

type Db = PrismaClient | Prisma.TransactionClient;

export type TaskEvidence = 'on_file' | 'missing';

export const EVIDENCE_KINDS = new Set(['W4', 'DIRECT_DEPOSIT', 'POLICY_ACK', 'PROFILE_INFO', 'I9_VERIFICATION']);

/** The policies an application must acknowledge — the same rule as GET /onboarding/applications/:id/policies. */
async function requiredPolicyIds(db: Db, clientId: string | null): Promise<string[]> {
  const client = clientId ? await db.client.findFirst({ where: { id: clientId }, select: { industry: true } }) : null;
  const rows = await db.policy.findMany({
    where: {
      deletedAt: null,
      requiredForOnboarding: true,
      OR: [{ body: { not: null } }, { bodyUrl: { not: null } }],
      AND: {
        OR: [
          { clientId },
          { clientId: null, industry: client?.industry?.toLowerCase() ?? null },
          { clientId: null, industry: null },
        ],
      },
    },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

export async function taskEvidenceFor(
  db: Db,
  app: { associateId: string; clientId: string | null },
  tasks: ReadonlyArray<{ id: string; kind: string; status: string }>,
): Promise<Map<string, TaskEvidence>> {
  const out = new Map<string, TaskEvidence>();
  const checked = tasks.filter((t) => t.status === 'DONE' && EVIDENCE_KINDS.has(t.kind));
  if (checked.length === 0) return out;
  const kinds = new Set(checked.map((t) => t.kind));
  const a = app.associateId;
  const [w4, payout, person, i9, policyIds] = await Promise.all([
    kinds.has('W4') ? db.w4Submission.findUnique({ where: { associateId: a }, select: { id: true } }) : null,
    kinds.has('DIRECT_DEPOSIT') ? db.payoutMethod.findFirst({ where: { associateId: a, isPrimary: true }, select: { id: true } }) : null,
    kinds.has('PROFILE_INFO') ? db.associate.findUnique({ where: { id: a }, select: { dob: true, phone: true, addressLine1: true } }) : null,
    kinds.has('I9_VERIFICATION') ? db.i9Verification.findUnique({ where: { associateId: a }, select: { section1CompletedAt: true, section2CompletedAt: true } }) : null,
    kinds.has('POLICY_ACK') ? requiredPolicyIds(db, app.clientId) : Promise.resolve([] as string[]),
  ]);
  const acked = kinds.has('POLICY_ACK') && policyIds.length
    ? (await db.policyAcknowledgment.findMany({ where: { associateId: a, policyId: { in: policyIds } }, select: { policyId: true }, distinct: ['policyId'] })).length
    : 0;
  const onFile: Record<string, boolean> = {
    W4: !!w4,
    DIRECT_DEPOSIT: !!payout,
    // The profile panel's own "Not submitted yet": none of the three is there.
    PROFILE_INFO: !!person && !!(person.dob || person.phone || person.addressLine1),
    I9_VERIFICATION: !!i9?.section1CompletedAt && !!i9.section2CompletedAt,
    // Nothing to acknowledge is nothing missing.
    POLICY_ACK: acked >= policyIds.length,
  };
  for (const t of checked) out.set(t.id, onFile[t.kind] ? 'on_file' : 'missing');
  return out;
}
