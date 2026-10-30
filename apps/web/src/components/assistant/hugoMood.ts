import type { HugoSummary } from '@alto-people/shared';
import type { HugoPose } from '@/components/hugo/HugoMascot';
import { useAssistant } from '@/lib/assistantContext';

/**
 * What Hugo is up to, outside his panel — the same on every way in to him
 * (the top bar, the phone button, the home seat), so a glance says it:
 *
 *   answering a question asked right now               → reads the records (the step he is on)
 *   needsYou  a task of his is waiting on the person   → points at them
 *   working   a task is running                         → headphones on, at the laptop
 *   done      finished something they haven't seen     → a small celebration
 *   news      noticed something for them                → holds it out
 *   coffee / reading   nothing going on: on a break — a morning or 3 o'clock
 *                      coffee, otherwise catching up on his reading
 *
 * The question in front of him comes first; then needing the person
 * outranks working: what they can unblock comes before what he's doing.
 */
export type HugoMood = 'answering' | 'needsYou' | 'working' | 'done' | 'news' | 'coffee' | 'reading';

export function hugoMoodOf(summary: HugoSummary | null | undefined, hour: number, answering = false): HugoMood {
  if (answering) return 'answering';
  if (summary?.needsYou) return 'needsYou';
  if (summary?.working) return 'working';
  if (summary?.unseenDone) return 'done';
  if (summary?.newNotes) return 'news';
  return hour < 11 || hour === 15 ? 'coffee' : 'reading';
}

/** The whole figure, for the home seat. */
export const MOOD_POSE: Record<HugoMood, HugoPose> = {
  answering: 'reading',
  needsYou: 'pointing',
  working: 'working',
  done: 'celebrate',
  news: 'handoff',
  coffee: 'coffee',
  reading: 'reading',
};

/** The face, for a button: his headphones on while he works. */
export const moodFace = (mood: HugoMood): HugoPose => (mood === 'working' || mood === 'answering' ? 'faceWork' : 'face');

export function useHugoMood(): HugoMood {
  const { summary, live } = useAssistant();
  return hugoMoodOf(summary, new Date().getHours(), live !== null);
}
