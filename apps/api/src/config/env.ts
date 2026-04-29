import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  // Comma-separated list of allowed origins. Browser sends Origin without
  // path/query, so each entry is just scheme + host (+ optional port).
  // Examples: "https://altohr.com,https://www.altohr.com,http://localhost:5173".
  CORS_ORIGIN: z
    .string()
    .default('http://localhost:5173')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    )
    .pipe(z.array(z.string().url()).min(1)),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  // DIRECT_URL is consumed by Prisma migrate, not by app code — but we
  // still validate it's present so devs aren't surprised.
  DIRECT_URL: z.string().min(1).optional(),
  JWT_SECRET: z
    .string()
    .min(32, 'JWT_SECRET must be at least 32 chars (use openssl rand -base64 48)'),
  JWT_TTL_SECONDS: z.coerce.number().int().positive().default(86400),
  PAYOUT_ENCRYPTION_KEY: z
    .string()
    .min(44, 'PAYOUT_ENCRYPTION_KEY must be base64-encoded 32 bytes (use openssl rand -base64 32)'),
  // Optional: ping the DB every N seconds to keep Neon's serverless compute
  // from suspending. 0 (default) disables. 240 = every 4 min, comfortably
  // under Neon's 5-min idle threshold. Each ping is a single SELECT 1, but
  // it does count against your Neon compute hours — leave at 0 in production.
  KEEP_ALIVE_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(0),
  // Phase 16 invitation flow.
  // Base URL the magic link in invitation emails points to. In dev this is
  // the Vite dev server; in prod it's wherever the web app is hosted.
  APP_BASE_URL: z.string().url().default('http://localhost:5173'),
  // Default invite token lifetime in seconds. 7 days = 604800.
  INVITE_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(7 * 24 * 60 * 60),
  // Optional: real Resend API key. If unset, EMAIL notifications stay
  // stubbed — the body (with magic link) prints to the API console and a
  // STUB-EMAIL-... ref is returned so the UI flow still works end-to-end.
  RESEND_API_KEY: z.string().optional(),
  // Sender shown in real Resend emails. Required only when RESEND_API_KEY is set.
  RESEND_FROM: z.string().optional(),
  // Phase 17 — invite reminder cron. 0 (default) disables. Set e.g. 1800
  // (every 30 min) in production. The threshold for "stale" is hard-coded
  // at 48h in lib/inviteReminder.ts; this only controls scan cadence.
  INVITE_REMINDER_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(0),
  // Phase 22 — payroll disbursement adapter. STUB (default) returns
  // synthetic refs; WISE / BRANCH attempt the real provider when the
  // matching API key is also set. Falls back to STUB if the chosen
  // provider's key is missing.
  PAYROLL_DISBURSEMENT_PROVIDER: z.enum(['STUB', 'WISE', 'BRANCH']).default('STUB'),
  WISE_API_KEY: z.string().optional(),
  BRANCH_API_KEY: z.string().optional(),
  // Phase 45 — Branch payments rail. BRANCH_API_BASE_URL lets ops point
  // at sandbox vs production without a code change; BRANCH_WEBHOOK_SECRET
  // is the shared HMAC secret Branch signs status-change webhooks with.
  // When the secret is missing, the webhook endpoint refuses every
  // request — never run unauthenticated in any environment.
  BRANCH_API_BASE_URL: z.string().url().default('https://api.branchapp.com'),
  BRANCH_WEBHOOK_SECRET: z.string().optional(),
  // Phase 44 — QuickBooks Online (Intuit). When both client id and secret
  // are set, OAuth is wired and JournalEntry POSTs hit Intuit's v3 API.
  // Otherwise the integration runs in stub mode: connect/disconnect work
  // for the UI flow but actual posting just logs the would-be JE payload
  // to the API console (and stamps a STUB-QBO-... id on the run).
  // Sandbox vs production routing is controlled by INTUIT_ENV; sandbox
  // hits the apidev URL, production hits the prod URL. The OAuth redirect
  // URI must be registered in the Intuit developer dashboard and equal to
  // {APP_BASE_URL}/api/quickbooks/connect/callback.
  INTUIT_CLIENT_ID: z.string().optional(),
  INTUIT_CLIENT_SECRET: z.string().optional(),
  INTUIT_ENV: z.enum(['sandbox', 'production']).default('sandbox'),
  // Phase 99 — server-side secret used to HMAC kiosk PINs. Defaults to
  // PAYOUT_ENCRYPTION_KEY in dev so we don't bloat .env; production
  // should set its own (rotation invalidates all existing PINs).
  KIOSK_PIN_SECRET: z.string().min(32).optional(),
  // Phase 109 — pulse survey responder hash secret. Defaults to
  // PAYOUT_ENCRYPTION_KEY if unset.
  PULSE_HASH_SECRET: z.string().min(32).optional(),
  // HMAC secret used to mint per-associate iCal feed URLs. The token
  // embedded in /scheduling/calendar/:token.ics is HMAC(secret, associateId);
  // rotating this secret revokes every outstanding subscription. Defaults
  // to JWT_SECRET so dev environments don't need a second key.
  CALENDAR_FEED_SECRET: z.string().min(32).optional(),
});

export type Env = z.infer<typeof EnvSchema>;

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('[alto-people/api] invalid environment:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env: Env = parsed.data;
