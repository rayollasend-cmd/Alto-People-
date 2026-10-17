import { ApiError } from '@/lib/api';

/**
 * The sentence to show when a request fails. The API's own message wins
 * when there is one (it names the rule that refused the change); otherwise
 * the caller's fallback, which should say what did not happen
 * ("Couldn't save the pay rule."), never a bare "Failed.".
 */
export function errorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.message.trim()) return err.message;
  return fallback;
}
