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
