import { useI18n, type MessageKey } from '@/lib/i18n';

/**
 * The name a home greets someone by (design system §6, voice): their first
 * name when the account has one; otherwise the first word of the email's
 * local part, capitalised ("ana.r" → "Ana"), never the raw local part
 * ("workforce@…" greeted "workforce" on two homes in the first design walk).
 * Seven homes used five different versions of this; this is the one.
 */
export function greetingName(user: { firstName?: string | null; email?: string | null } | null | undefined, fallback = 'there'): string {
  const first = user?.firstName?.trim();
  if (first) return first;
  const local = user?.email?.split('@')[0] ?? '';
  const word = local.split(/[._+-]+/)[0] ?? '';
  return word ? word.charAt(0).toUpperCase() + word.slice(1) : fallback;
}

/**
 * The greeting for an hour of the day, as a message key: six homes carried
 * their own copy (two with a different afternoon boundary, two in English
 * only on surfaces a Spanish- or Turkish-speaking person opens).
 */
export function greetingKey(hour: number): MessageKey {
  if (hour < 5) return 'home.greetLate';
  if (hour < 12) return 'home.greetMorning';
  if (hour < 17) return 'home.greetAfternoon';
  if (hour < 22) return 'home.greetEvening';
  return 'home.greetNight';
}

/** The greeting word in the person's language: `const greet = useGreeting(); greet(hour)`. */
export function useGreeting(): (hour: number) => string {
  const { t } = useI18n();
  return (hour) => t(greetingKey(hour));
}
