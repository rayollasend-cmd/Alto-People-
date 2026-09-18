import type { Prisma } from '@prisma/client';
import { HttpError } from '../middleware/error.js';

/**
 * One guarded way to close an associate's open site assignment.
 *
 * `AssociateAssignment` carries a database CHECK constraint
 * (`AssociateAssignment_dates_chk`: endedAt IS NULL OR endedAt >= startedAt).
 * Four flows close an open row with a date the user chose — onboarding
 * approval (hire date), separation completion (last day worked), an org
 * transfer and the shift-team quick assign (effective date). Each of them
 * used to write the end date blind, so a date earlier than the row's start
 * hit the constraint and came back as a raw Postgres 23514 — a 500 with no
 * hint about which date was wrong.
 *
 * The real-world shape: someone is transferred with an effective date of
 * Sep 7, then separated with a last day worked of Aug 24. The end date
 * precedes the start of the assignment it is closing, which is not a
 * database problem — it is two dates that cannot both be true.
 *
 * So: read the open rows first, compare, and refuse with a 400 that names
 * both dates. The constraint stays as the last line of defence.
 */

/** Both the transaction client and the base client satisfy this. */
type AssignmentClient = Pick<Prisma.TransactionClient, 'associateAssignment'>;

export interface CloseAssignmentsInput {
  associateId: string;
  /** The date the open assignment(s) should end on. */
  endedAt: Date;
  /**
   * What the caller calls that date in its own UI — "last day worked",
   * "hire date", "transfer date". It goes into the error message so the
   * person reading it knows which field to fix.
   */
  endLabel: string;
}

function dateOnly(d: Date): string {
  // Assignment dates are stored as UTC midnight (date-only), so format in
  // UTC — toLocaleDateString in a western zone would show the day before.
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * Throws a 400 when `endedAt` precedes the start of an assignment it would
 * close. Exported for callers that want to validate before doing other
 * work in the same transaction.
 */
export async function assertCanCloseAssignments(
  client: AssignmentClient,
  input: CloseAssignmentsInput,
): Promise<void> {
  const open = await client.associateAssignment.findMany({
    where: { associateId: input.associateId, endedAt: null },
    select: {
      id: true,
      startedAt: true,
      location: { select: { name: true } },
    },
  });
  const conflict = open.find((a) => a.startedAt > input.endedAt);
  if (!conflict) return;
  const where = conflict.location.name ? ` to ${conflict.location.name}` : '';
  throw new HttpError(
    400,
    'assignment_date_conflict',
    `Their current assignment${where} started on ${dateOnly(conflict.startedAt)}, ` +
      `which is after the ${input.endLabel} (${dateOnly(input.endedAt)}). ` +
      `Change the ${input.endLabel} to ${dateOnly(conflict.startedAt)} or later, ` +
      `or correct the assignment's start date first.`,
    {
      assignmentId: conflict.id,
      assignmentStartedAt: conflict.startedAt.toISOString(),
      requestedEndedAt: input.endedAt.toISOString(),
    },
  );
}

/**
 * Validates, then closes every open assignment for the associate.
 * Returns how many rows were closed.
 */
export async function closeOpenAssignments(
  client: AssignmentClient,
  input: CloseAssignmentsInput,
): Promise<number> {
  await assertCanCloseAssignments(client, input);
  const { count } = await client.associateAssignment.updateMany({
    where: { associateId: input.associateId, endedAt: null },
    data: { endedAt: input.endedAt },
  });
  return count;
}
