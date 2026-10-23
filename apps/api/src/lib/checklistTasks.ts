import type { TaskKind } from '@prisma/client';

/**
 * Checklist instantiation policy — applied wherever a template becomes a
 * real checklist (invite flow, bulk invite, CSV invite, recruiting hire).
 *
 * The live profile photo is PRODUCT POLICY, not a template opinion: every
 * checklist carries the task even when the template predates the feature
 * or an admin edited it out. The gap this closes: the task originally
 * shipped only in seed data, which never runs in production, so real
 * templates never had it, associates onboarded photo-less, and the
 * 100%-checklist approval gate had nothing to hold.
 */

export interface ChecklistTaskCreate {
  kind: TaskKind;
  title: string;
  description: string | null;
  order: number;
  dueOffsetDays?: number | null;
}

export const PROFILE_PHOTO_TASK: Omit<ChecklistTaskCreate, 'order'> = {
  kind: 'PROFILE_PHOTO',
  title: 'Take your profile photo',
  description:
    'A quick headshot taken with your camera — shown next to your name across the app.',
  dueOffsetDays: null,
};

/** WOTC pre-screening — added when the tenant screens (WotcSettings.enabled)
 *  and the hire is a W-2 employee. Voluntary: declining completes it. */
export const WOTC_SCREENING_TASK: Omit<ChecklistTaskCreate, 'order'> = {
  kind: 'WOTC_SCREENING',
  title: 'Answer a few tax credit questions',
  description:
    'Optional questions that help your employer claim a federal tax credit. Your answers don’t affect whether you’re hired.',
  dueOffsetDays: null,
};

/** When they can work (role walk supervisor 11). A new hire used to land
 *  "fully unavailable" and the schedule could never offer them a shift
 *  until someone noticed; the checklist asks, with one-tap presets. */
export const AVAILABILITY_TASK: Omit<ChecklistTaskCreate, 'order'> = {
  kind: 'AVAILABILITY',
  title: 'Tell us when you can work',
  description: 'Pick the days and hours you are available — a preset is one tap, and you can change it any time from your schedule.',
  dueOffsetDays: null,
};

/** Returns the task list with every mandatory task present (appended at
 *  max order + 1 when missing, so template ordering is untouched). */
export function withMandatoryTasks(tasks: ChecklistTaskCreate[], opts: { wotc?: boolean } = {}): ChecklistTaskCreate[] {
  const out = [...tasks];
  const next = () => Math.max(0, ...out.map((t) => t.order)) + 1;
  if (!out.some((t) => t.kind === 'PROFILE_PHOTO')) out.push({ ...PROFILE_PHOTO_TASK, order: next() });
  if (!out.some((t) => t.kind === 'AVAILABILITY')) out.push({ ...AVAILABILITY_TASK, order: next() });
  if (opts.wotc && !out.some((t) => t.kind === 'WOTC_SCREENING')) out.push({ ...WOTC_SCREENING_TASK, order: next() });
  return out;
}
