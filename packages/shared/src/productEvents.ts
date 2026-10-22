import { z } from 'zod';

/**
 * Product analytics, the three behaviour events (ux-upgrade §6): how long a
 * session takes to reach its first decision, decisions per session by role,
 * and palette searches that end on a settings page ("I could not find it").
 * The browser emits them; the API rolls them up per day, role and kind. No
 * event carries who did what — a count and, for the first decision, a
 * duration.
 */

export const PRODUCT_EVENT_KINDS = ['session_start', 'decision', 'first_decision', 'settings_search'] as const;
export type ProductEventKind = (typeof PRODUCT_EVENT_KINDS)[number];

export const ProductEventSchema = /* @__PURE__ */ (() =>
  z.object({
    kind: z.enum(PRODUCT_EVENT_KINDS),
    /** first_decision: milliseconds from sign-in to the decision. Others: omitted. A day is already a lost session. */
    value: z.number().finite().min(0).max(86_400_000).optional(),
  }))();

export const ProductEventsBodySchema = /* @__PURE__ */ (() =>
  z.object({
    events: z.array(ProductEventSchema).min(1).max(50),
  }))();
export type ProductEventsBody = z.infer<typeof ProductEventsBodySchema>;

export interface ProductEventsResponse {
  days: number;
  /** Time from sign-in to the first decision, over the sessions that took one. */
  firstDecision: { sessions: number; avgMs: number | null };
  /** Sessions and decisions per role, with the ratio the doc asks for. */
  decisionsPerSession: Array<{ role: string; sessions: number; decisions: number; perSession: number | null }>;
  /** Palette searches that ended on a settings page, against every session. */
  settingsSearches: { count: number; sessions: number; perHundredSessions: number | null };
}
