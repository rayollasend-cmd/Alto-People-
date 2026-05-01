import { z } from 'zod';
import { env } from '../config/env.js';

/**
 * Thin client for ASN Nexus's compliance-metrics endpoint. Powers Tile 3
 * (Shift compliance) on the /compliance scorecard. We pull live aggregates
 * over a rolling window; ASN Nexus is the source of truth for shift events
 * (no-shows, MOD sign-off, temp logs, Fieldglass submissions).
 *
 * Auth: bearer token. The same key lives on both sides — we set
 * ASN_NEXUS_API_KEY here, ASN Nexus sets ALTO_PEOPLE_API_KEY.
 *
 * If either env var is missing, this module is dormant — `isConfigured()`
 * returns false and the scorecard falls back to its built-in placeholders.
 *
 * Spec: see the message sent to the ASN Nexus Replit agent on 2026-05-01
 * for the full endpoint contract.
 */

// Each metric is a percent (0–100, one decimal). value=null means ASN
// hasn't implemented the signal yet — UI shows "Coming soon".
const MetricSchema = z.object({
  value: z.number().min(0).max(100).nullable(),
  target: z.number(),
  sampleSize: z.number().int().nonnegative(),
  note: z.string().nullable().optional(),
});

const ResponseSchema = z.object({
  windowDays: z.number().int().positive(),
  windowStart: z.string(),
  windowEnd: z.string(),
  metrics: z.object({
    fillRate: MetricSchema,
    noShowRate: MetricSchema,
    shiftLeadPresent: MetricSchema,
    temperatureLogs: MetricSchema,
    modSignoff: MetricSchema,
    fieldglassTimesheetsOnTime: MetricSchema,
  }),
  generatedAt: z.string(),
});

export type AsnNexusShiftMetrics = z.infer<typeof ResponseSchema>;
export type AsnNexusMetric = z.infer<typeof MetricSchema>;

export function isConfigured(): boolean {
  return !!(env.ASN_NEXUS_BASE_URL && env.ASN_NEXUS_API_KEY);
}

interface FetchOptions {
  windowDays?: number;
  clientId?: string;
  /** Per-call abort timeout in ms. Default 5 s — Tile 3 can fall through to
   * placeholders rather than blocking the whole scorecard refresh. */
  timeoutMs?: number;
}

/**
 * Fetch shift-compliance metrics from ASN Nexus. Returns null when the
 * integration is unconfigured (env vars missing) — caller treats that the
 * same way as "ASN doesn't know about this signal yet" and shows the
 * placeholder UI. Throws on network / HTTP / parse errors so the caller
 * can decide whether to log + fall through or surface the failure.
 */
export async function getShiftMetrics(
  opts: FetchOptions = {},
): Promise<AsnNexusShiftMetrics | null> {
  if (!isConfigured()) return null;

  const url = new URL('/api/v1/compliance/shift-metrics', env.ASN_NEXUS_BASE_URL!);
  if (opts.windowDays) url.searchParams.set('windowDays', String(opts.windowDays));
  if (opts.clientId) url.searchParams.set('clientId', opts.clientId);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5000);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${env.ASN_NEXUS_API_KEY}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    // Drain the body for the error message so we don't leak a hung socket.
    const body = await res.text().catch(() => '');
    throw new Error(
      `ASN Nexus shift-metrics returned ${res.status}: ${body.slice(0, 200)}`,
    );
  }

  const json = await res.json();
  return ResponseSchema.parse(json);
}
