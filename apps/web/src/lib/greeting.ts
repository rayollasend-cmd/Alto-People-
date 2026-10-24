import { useI18n, type MessageKey } from '@/lib/i18n';
import '@/lib/i18n/en/home';
import '@/lib/i18n/en/people';

/**
 * The name a home greets someone by (design system §6, voice): their first
 * name when the account has one, otherwise `fallback`. Never the email's
 * local part — "workforce@…" greeted "Workforce" on two homes, and a
 * "people.ops@" mailbox is nobody's name. Homes pass `''` and drop the
 * comma: "Good morning." reads better than "Good morning, there."
 * Seven homes used five different versions of this; this is the one.
 */
export function greetingName(user: { firstName?: string | null; email?: string | null } | null | undefined, fallback = 'there'): string {
  const first = user?.firstName?.trim();
  return first || fallback;
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
