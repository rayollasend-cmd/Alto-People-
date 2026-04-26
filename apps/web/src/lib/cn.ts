import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge Tailwind classes with proper precedence. Drop-in compatible with
 * the original signature (string | false | null | undefined) but also
 * accepts arrays/objects via clsx, and de-conflicts overlapping utility
 * classes via tailwind-merge (so "px-2 px-4" → "px-4", not both).
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
