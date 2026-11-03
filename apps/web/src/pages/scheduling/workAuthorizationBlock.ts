import { useContext, useMemo } from 'react';
import { WORK_AUTH_OVERRIDE_MIN_REASON, type NotAuthorizedToWorkDetails } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { AuthContext } from '@/lib/auth';
import { usePromptIfMounted, type PromptOptions } from '@/lib/confirm';

/**
 * Cleared to work — the scheduling side (owner, 2026-11-03).
 *
 * The server refuses a shift on or after the day someone's work
 * authorization or J-1 program ended (or after an E-Verify final
 * nonconfirmation) with 409 `not_authorized_to_work`, and its message says
 * so in plain words. A scheduler without manage:compliance sees that message
 * ("… Ask HR."). Someone who holds manage:compliance gets "Assign anyway"
 * with a required reason of 10+ characters; the server audits it.
 */

export interface WorkAuthAsk {
  prompt: (o: PromptOptions) => Promise<string | null>;
  /** The signed-in user holds manage:compliance. */
  canOverride: boolean;
}

/** The prompt and the capability, for the assign flows. */
export function useWorkAuthAsk(): WorkAuthAsk | undefined {
  const prompt = usePromptIfMounted();
  // Read without throwing: the assign dialog renders in tests (and shells) with no signed-in user.
  const auth = useContext(AuthContext);
  const canOverride = auth?.can('manage:compliance') ?? false;
  // No prompt to ask with (rendered outside the app shell): no override offered.
  return useMemo(() => (prompt ? { prompt, canOverride } : undefined), [prompt, canOverride]);
}

export function isNotAuthorizedToWork(err: unknown): err is ApiError {
  return err instanceof ApiError && err.code === 'not_authorized_to_work';
}

/**
 * Ask for the "Assign anyway" (or "Approve anyway") reason. Returns the
 * reason; null when the person declined; 'not_allowed' when this user can't
 * override (the caller shows the server's message, which tells them to ask HR).
 */
export async function askWorkAuthOverride(
  err: ApiError,
  ask: WorkAuthAsk | undefined,
  who: string | null,
  opts: { verb?: 'Assign' | 'Approve' } = {},
): Promise<{ reason: string } | null | 'not_allowed'> {
  const details = (err.details ?? null) as Partial<NotAuthorizedToWorkDetails> | null;
  if (!ask || !ask.canOverride || details?.canOverride === false) return 'not_allowed';
  const verb = opts.verb ?? 'Assign';
  let note = '';
  for (let tries = 0; tries < 3; tries++) {
    const reason = await ask.prompt({
      title: who ? `${who} is not cleared to work then` : 'Not cleared to work then',
      description: `${err.message}${note} ${verb === 'Assign' ? 'Assigning' : 'Approving'} anyway is recorded with your reason on the Cleared to work tab.`,
      confirmLabel: `${verb} anyway`,
      destructive: true,
      reasonLabel: 'Why they may work this shift',
      reasonPlaceholder: 'E.g. EAD renewal receipt on file, 180-day automatic extension',
      reasonMaxLength: 500,
    });
    if (reason === null) return null;
    if (reason.trim().length >= WORK_AUTH_OVERRIDE_MIN_REASON) return { reason: reason.trim() };
    note = ` Give a reason of at least ${WORK_AUTH_OVERRIDE_MIN_REASON} characters.`;
  }
  return null;
}

/** Thrown when HR declined the "Approve anyway" prompt: the caller says nothing. */
export class WorkAuthDeclined extends Error {
  constructor() {
    super('Not approved.');
    this.name = 'WorkAuthDeclined';
  }
}

/**
 * Run an approval (a pickup, a swap); when the server refuses it because
 * someone is not cleared to work that day, ask HR for "Approve anyway" with a
 * reason and run it once more with the override (owner, 2026-11-03). A
 * scheduler without manage:compliance gets the server's error ("… Ask HR.").
 * Throws WorkAuthDeclined when HR declines the prompt.
 */
export async function withWorkAuthOverride<T>(
  run: (override?: { reason: string }) => Promise<T>,
  ask: WorkAuthAsk | undefined,
  who: string | null = null,
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (!isNotAuthorizedToWork(err)) throw err;
    const answer = await askWorkAuthOverride(err, ask, who, { verb: 'Approve' });
    if (answer === 'not_allowed') throw err;
    if (!answer) throw new WorkAuthDeclined();
    return run(answer);
  }
}

/** A bulk create's skip reason in words (the toast used to show the raw code). */
export function bulkSkipReasonWords(reason: string): string {
  switch (reason) {
    case 'not_authorized_to_work':
      return 'not cleared to work that day';
    case 'already_scheduled':
      return 'already scheduled then';
    case 'day_unavailable':
      return 'off that day';
    case 'inactive':
      return 'no longer active';
    case 'program_client':
      return 'H-2B petition is for another client';
    case 'not_found':
      return 'not found';
    default:
      return reason.replace(/_/g, ' ');
  }
}
