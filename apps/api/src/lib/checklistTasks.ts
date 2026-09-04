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

/** Returns the task list with every mandatory task present (appended at
 *  max order + 1 when missing, so template ordering is untouched). */
export function withMandatoryTasks(tasks: ChecklistTaskCreate[]): ChecklistTaskCreate[] {
  if (tasks.some((t) => t.kind === 'PROFILE_PHOTO')) return tasks;
  return [
    ...tasks,
    {
      ...PROFILE_PHOTO_TASK,
      order: Math.max(0, ...tasks.map((t) => t.order)) + 1,
    },
  ];
}
