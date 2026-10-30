import type { HugoSummary } from '@alto-people/shared';
import type { HugoPose } from '@/components/hugo/HugoMascot';
import { useAssistant } from '@/lib/assistantContext';

/**
 * What Hugo is up to, outside his panel — the same on every way in to him
 * (the top bar, the phone button, the home seat), so a glance says it:
 *
 *   needsYou  a task of his is waiting on the person   → points at them
 *   working   a task is running                         → headphones on, at the laptop
 *   done      finished something they haven't seen     → a small celebration
 *   news      noticed something for them                → holds it out
 *   coffee / reading   nothing going on: on a break — a morning or 3 o'clock
 *                      coffee, otherwise catching up on his reading
 *
 * Needing the person outranks working: what they can unblock comes first.
 */
export type HugoMood = 'needsYou' | 'working' | 'done' | 'news' | 'coffee' | 'reading';

export function hugoMoodOf(summary: HugoSummary | null | undefined, hour: number): HugoMood {
  if (summary?.needsYou) return 'needsYou';
  if (summary?.working) return 'working';
  if (summary?.unseenDone) return 'done';
  if (summary?.newNotes) return 'news';
  return hour < 11 || hour === 15 ? 'coffee' : 'reading';
}

/** The whole figure, for the home seat. */
export const MOOD_POSE: Record<HugoMood, HugoPose> = {
  needsYou: 'pointing',
  working: 'working',
  done: 'celebrate',
  news: 'handoff',
  coffee: 'coffee',
  reading: 'reading',
};

/** The face, for a button: his headphones on while he works. */
export const moodFace = (mood: HugoMood): HugoPose => (mood === 'working' ? 'faceWork' : 'face');

export function useHugoMood(): HugoMood {
  const { summary } = useAssistant();
  return hugoMoodOf(summary, new Date().getHours());
}
