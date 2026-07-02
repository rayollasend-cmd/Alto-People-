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
    .min(44, 'JWT_SECRET must be at least 44 chars — generate with `openssl rand -base64 48`. 32-char passphrases decode to ~24 bytes of entropy, below NIST guidance for HS256.'),
  JWT_TTL_SECONDS: z.coerce.number().int().positive().default(86400),
  PAYOUT_ENCRYPTION_KEY: z
    .string()
    .min(44, 'PAYOUT_ENCRYPTION_KEY must be base64-encoded 32 bytes (use openssl rand -base64 32)'),
  // Independent key for encrypting TOTP secrets at rest. Defaults to
  // PAYOUT_ENCRYPTION_KEY in dev so we don't bloat .env. Production should
  // set its own — rotation invalidates every enrolled user's secret, so
  // keeping MFA on a separate key avoids dragging payouts along on rotation.
  MFA_SECRET_ENCRYPTION_KEY: z
    .string()
    .min(44, 'MFA_SECRET_ENCRYPTION_KEY must be base64-encoded 32 bytes (use openssl rand -base64 32)')
    .optional(),
  // Ping the DB every N seconds to keep Neon's serverless compute from
  // suspending mid-session. Each ping is a single SELECT 1. Defaults to 0
  // (off) everywhere — production runs Neon with auto-suspend disabled at
  // the branch level, so keep-alive pings would just burn compute hours
  // for no upside. Set to e.g. 240 to opt in if you move to a Neon tier
  // that suspends idle compute.
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
  // Web push (VAPID). All optional — with keys absent, push is cleanly
  // "not configured": the public-key endpoint 404s so clients never
  // subscribe, and the sender no-ops. Generate once with
  // `npx web-push generate-vapid-keys`; rotating keys orphans every
  // outstanding subscription (clients re-subscribe on next visit).
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  // Sender shown in real Resend emails. Required only when RESEND_API_KEY is set.
  // Must match Resend's accepted formats:
  //   - bare:        hr@altohr.com
  //   - with name:   Alto HR <hr@altohr.com>
  // Whitespace is trimmed; surrounding quotes are stripped (Railway / Heroku
  // dashboards sometimes preserve literal quotes when an env value contains
  // angle brackets, which breaks Resend with a 422 validation_error).
  RESEND_FROM: z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined) return undefined;
      const trimmed = v.trim().replace(/^["']|["']$/g, '').trim();
      return trimmed.length === 0 ? undefined : trimmed;
    })
    .refine(
      (v) =>
        v === undefined ||
        // Bare email: simple ASCII email check (Resend does its own).
        /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(v) ||
        // Name + angle-bracketed email: "Display Name <email@host>"
        /^[^<>]+\s+<[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>$/.test(v),
      {
        message:
          'RESEND_FROM must be either "email@example.com" or "Name <email@example.com>". ' +
          'Check for stray quotes, trailing whitespace, or smart quotes in the env value.',
      },
    ),
  // Reply-To header on all transactional email. Lets recipients write back
  // to a monitored mailbox even though Resend itself sends from the no-reply
  // hr@ address. Set to a real inbox in production (e.g. info@altohr.com).
  RESEND_REPLY_TO: z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined) return undefined;
      const trimmed = v.trim().replace(/^["']|["']$/g, '').trim();
      return trimmed.length === 0 ? undefined : trimmed;
    })
    .refine(
      (v) => v === undefined || /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(v),
      { message: 'RESEND_REPLY_TO must be a bare email like info@altohr.com.' },
    ),
  // Phase 17 — invite reminder cron. 0 (default) disables. Set e.g. 1800
  // (every 30 min) in production. The threshold for "stale" is hard-coded
  // at 48h in lib/inviteReminder.ts; this only controls scan cadence.
  INVITE_REMINDER_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(0),
  // Manual compliance attestation reminder cron. 0 (default) disables;
  // production should set 3600 (hourly) so HR gets pinged the day a
  // weekly/monthly compliance attestation comes due. Per-signal de-dup
  // inside the sweep ensures a 1h cadence doesn't spam HR — each
  // (key, periodStart) reminder fires at most once per 24h.
  ATTESTATION_REMINDER_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(0),
  // Day-before shift reminder cron. 0 (default) disables; production should
  // set 1800-3600. Each assigned+published shift starting within the next
  // 24h is reminded exactly once — Shift.reminderSentAt is claimed with a
  // guarded update, so overlapping sweeps/replicas can't double-send.
  SHIFT_REMINDER_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(0),
  // Daily schedule digest to admins (Sling-style morning summary: every
  // shift today, who's on it, fill/unconfirmed counts). The sweep runs
  // every N seconds but sends at most once per local day, after
  // SCHEDULE_DIGEST_HOUR in the deployment timezone. 0 (default)
  // disables; production should set 900 so the digest lands within
  // ~15 min of the hour.
  SCHEDULE_DIGEST_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(0),
  // Local hour (0-23, deployment timezone) after which the daily digest
  // may send. Default 6 → admins have it before the first shift.
  SCHEDULE_DIGEST_HOUR: z.coerce.number().int().min(0).max(23).default(6),
  // Kiosk maintenance cron: auto-closes forgotten clock-outs and purges
  // selfies past their retention window. 0 (default) disables; production
  // should set 3600 (hourly). Thresholds (18h forgotten-shift, 90d selfie
  // retention) are hard-coded in lib/kioskMaintenance.ts.
  KIOSK_MAINTENANCE_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(0),
  // Document maintenance cron: purges blob bytes for REJECTED docs once
  // they've passed REJECTED_DOC_RETENTION_DAYS (30, hard-coded). Defaults
  // to 86400 (daily) — this is a compliance/storage-hygiene sweep we
  // want on by default; set to 0 only if a downstream job handles purges.
  // The DocumentRecord row stays for audit — only the file leaves disk.
  DOCUMENT_MAINTENANCE_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(86400),
  // Multi-replica deployment hint. The kiosk rate limit keeps state
  // per-process (see lib/kioskRateLimit.ts). When MULTI_REPLICA=1 we
  // refuse to boot unless a shared rate-limit store has been wired up
  // via setKioskRateLimitStore() before the listener starts. Default
  // 0 covers the existing single-replica Railway deployment. Ops sets
  // it to 1 only after installing a Redis-backed (or equivalent)
  // adapter — leaving the default state-per-process behavior in a
  // multi-replica setup lets an attacker bypass the PIN lockout by
  // round-robin'ing replicas.
  MULTI_REPLICA: z.coerce.number().int().min(0).max(1).default(0),
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
  // ASN Nexus — Walmart-shift compliance metrics source. ASN Nexus is a
  // separate service (built on Replit) that owns the source-of-truth
  // shift data. The compliance scorecard's Tile 3 (shift compliance)
  // pulls live metrics from there. When either var is unset, Tile 3
  // falls back to its built-in fill-rate query against our local Shift
  // table and shows "Coming soon" for everything else.
  ASN_NEXUS_BASE_URL: z.string().url().optional(),
  ASN_NEXUS_API_KEY: z.string().optional(),
  // Phase 9 storage root — overrides `apps/api/uploads/` so a Railway
  // Volume (or any mounted disk) can hold the document blobs across
  // redeploys. When unset, falls back to the colocated default which
  // is fine for local dev but ephemeral on Railway. On Railway, attach
  // a Volume to this service and set UPLOAD_DIR to its mount path
  // (e.g. /data/uploads). See apps/api/STORAGE.md.
  UPLOAD_DIR: z.string().optional(),
  // Nightly off-site backup of UPLOAD_ROOT to any S3-compatible bucket
  // (AWS S3, Backblaze B2, Cloudflare R2). The Railway Volume protects
  // files against REDEPLOYS, not against deletion/corruption — Neon has
  // point-in-time recovery for the database; this is the equivalent for
  // the document blobs. All four BACKUP_S3_* must be set or the job
  // stays off (no half-configured surprises). ENDPOINT only for non-AWS
  // providers. See apps/api/BACKUPS.md.
  BACKUP_S3_BUCKET: z.string().optional(),
  BACKUP_S3_REGION: z.string().optional(),
  BACKUP_S3_ACCESS_KEY_ID: z.string().optional(),
  BACKUP_S3_SECRET_ACCESS_KEY: z.string().optional(),
  BACKUP_S3_ENDPOINT: z.string().url().optional(),
  BACKUP_INTERVAL_HOURS: z.coerce.number().int().positive().default(24),
  BACKUP_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  // Sentry DSN. When set, unhandled errors from the request pipeline +
  // any error reaching the global error handler get reported. Unset =>
  // no reporting, no SDK init, zero network calls. Reasonable default
  // for dev and CI; production should set it via Railway.
  SENTRY_DSN: z.string().url().optional(),
  // 0 -> off, 1 -> 100% sampling. Defaults to 0.1 (10%) which keeps
  // free-tier quotas reasonable while still capturing the long tail.
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.1),
});

export type Env = z.infer<typeof EnvSchema>;

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('[alto-people/api] invalid environment:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

// Cross-field guards. We exit fail-loud rather than fall back silently —
// a misconfigured production environment that quietly routes to STUB
// would not move money, and the failure mode is invisible until payday.
// Production must explicitly configure independent keys for MFA secrets
// and kiosk PIN HMACs. Both are documented as defaulting to
// PAYOUT_ENCRYPTION_KEY for dev convenience, but a prod environment that
// silently shares one secret across three sensitive data domains turns
// a single key compromise into a triple breach (MFA bypass + every kiosk
// PIN recoverable + all direct-deposit bank info decryptable). Mirrors
// the BRANCH fail-loud pattern below.
if (parsed.data.NODE_ENV === 'production') {
  if (
    !parsed.data.MFA_SECRET_ENCRYPTION_KEY ||
    parsed.data.MFA_SECRET_ENCRYPTION_KEY.trim() === ''
  ) {
    console.error(
      'FATAL: NODE_ENV=production but MFA_SECRET_ENCRYPTION_KEY is not configured. ' +
        'It cannot silently fall back to PAYOUT_ENCRYPTION_KEY in prod — one leaked secret ' +
        'would unlock MFA seeds AND direct-deposit bank info. Generate with `openssl rand -base64 32`.',
    );
    process.exit(1);
  }
  if (
    !parsed.data.KIOSK_PIN_SECRET ||
    parsed.data.KIOSK_PIN_SECRET.trim() === ''
  ) {
    console.error(
      'FATAL: NODE_ENV=production but KIOSK_PIN_SECRET is not configured. ' +
        'It cannot silently fall back to PAYOUT_ENCRYPTION_KEY in prod — one leaked secret ' +
        'would let an attacker forge every existing kiosk PIN HMAC. Generate with `openssl rand -base64 48`.',
    );
    process.exit(1);
  }
}

if (parsed.data.PAYROLL_DISBURSEMENT_PROVIDER === 'BRANCH') {
  if (!parsed.data.BRANCH_API_KEY || parsed.data.BRANCH_API_KEY.trim() === '') {
    console.error(
      'FATAL: PAYROLL_DISBURSEMENT_PROVIDER is set to BRANCH but BRANCH_API_KEY is not configured. ' +
        'The system will not start to prevent silent payment failures. ' +
        'Set BRANCH_API_KEY in your environment variables.',
    );
    process.exit(1);
  }
  if (!parsed.data.BRANCH_WEBHOOK_SECRET || parsed.data.BRANCH_WEBHOOK_SECRET.trim() === '') {
    console.error(
      'FATAL: PAYROLL_DISBURSEMENT_PROVIDER is set to BRANCH but BRANCH_WEBHOOK_SECRET is not configured. ' +
        'The system will not start to prevent silent payment failures. ' +
        'Set BRANCH_WEBHOOK_SECRET in your environment variables.',
    );
    process.exit(1);
  }
}

export const env: Env = parsed.data;
