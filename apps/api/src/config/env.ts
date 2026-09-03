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
  // Svix signing secret for Resend's inbound email-event webhook
  // (email.delivered / bounced / complained), as shown on the Resend
  // dashboard's webhook page — format "whsec_<base64>". When unset, the
  // /resend/webhook endpoint refuses every request with 503 — never run
  // an unauthenticated webhook in any environment.
  RESEND_WEBHOOK_SECRET: z.string().optional(),
  // Phase 17 — invite reminder cron. 0 (default) disables. Set e.g. 1800
  // (every 30 min) in production. The threshold for "stale" is hard-coded
  // at 48h in lib/inviteReminder.ts; this only controls scan cadence.
  // On by default (6h) — the sweep is the only automation keeping stalled
  // onboarding moving. Set 0 to disable.
  INVITE_REMINDER_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(21600),
  // Onboarding ghost purge (lib/onboardingPurge.ts): hard-deletes invites
  // unaccepted after 3 days and abandoned onboardings after 10 idle days
  // (final notice at 8). On by default (6h scan). Set 0 to disable.
  ONBOARDING_PURGE_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(21600),
  // Automatic stale-application nudge (lib/staleNudge.ts): the same
  // personalized "you're X% done" email as the manual Nudge-all-stale
  // button, on a timer, for in-flight applications past the 7-day
  // staleness rule. Per recipient: at most one automatic nudge per 72h
  // and 3 ever — the manual button stays uncapped. On by default (6h
  // scan). Set 0 to disable.
  STALE_NUDGE_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(21600),
  // Dormancy auto-deactivation (lib/dormancySweep.ts): associates with no
  // clock-ins, worked shifts, or upcoming schedule for DEACTIVATE_DAYS are
  // auto-deactivated (same pause as the manual button — one-click
  // Reactivate restores them), with an admin warning WARN_DAYS ahead.
  // Scan every 6h by default; either 0 disables the whole sweep.
  DORMANCY_SWEEP_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(21600),
  DORMANCY_DEACTIVATE_DAYS: z.coerce.number().int().min(0).default(30),
  DORMANCY_WARN_DAYS: z.coerce.number().int().min(1).default(7),
  // Store-ops evening digest (lib/opsDigest.ts): summarizes each store's
  // ops shifts once per org-day after 8pm. On by default (hourly scan).
  // Set 0 to disable.
  OPS_DIGEST_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(3600),
  // Manual compliance attestation reminder cron. 0 (default) disables;
  // production should set 3600 (hourly) so HR gets pinged the day a
  // weekly/monthly compliance attestation comes due. Per-signal de-dup
  // inside the sweep ensures a 1h cadence doesn't spam HR — each
  // (key, periodStart) reminder fires at most once per 24h.
  // On by default like the other compliance-hygiene sweeps (the 24h
  // per-signal de-dup makes hourly ticks safe). Set 0 to disable.
  ATTESTATION_REMINDER_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(3600),
  // Daily push of the scorecard's 0–30-day expirations (work auth, drug
  // tests, J-1 program ends, training certs). Set 0 to disable.
  EXPIRATION_DIGEST_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(86400),
  // Notification retention sweep (read bell rows >90d, delivery-audit
  // rows >365d). 0 disables. Daily is plenty — the windows are month-scale.
  NOTIFICATION_RETENTION_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(86400),
  // Daily compliance-score snapshot (org + per-client). The interval is only
  // how often we CHECK for today's row — one row/day/scope regardless. 0
  // disables (and with it the scorecard trend + week-delta features).
  COMPLIANCE_SNAPSHOT_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(3600),
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
  // Associate week-ahead digest: the evening before each CLIENT's week
  // start (Client.weekStartsOn — some clients run Sun–Sat weeks, others
  // Wed–Tue), every associate scheduled that week gets their shift list.
  // Sweep cadence in seconds; 0 (default) disables. Production: 1800.
  WEEK_AHEAD_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(0),
  // Local hour (deployment timezone) after which the "evening before"
  // send may fire. Default 17 (5 PM).
  WEEK_AHEAD_SEND_HOUR: z.coerce.number().int().min(0).max(23).default(17),
  // Kiosk maintenance cron: auto-closes forgotten clock-outs and purges
  // selfies past their retention window. 0 (default) disables; production
  // should set 3600 (hourly). Thresholds (18h forgotten-shift, 90d selfie
  // retention) are hard-coded in lib/kioskMaintenance.ts.
  KIOSK_MAINTENANCE_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(0),
  // Outbound webhook delivery worker (Phase 93 follow-up). Sweeps due
  // PENDING/RETRYING WebhookDelivery rows and POSTs them with the HMAC
  // X-Alto-Signature. On by default (60s) — subscriptions already exist
  // in the admin UI and silently never delivering is worse than a spare
  // query per minute. Set 0 to disable (e.g. one-off scripts). Backoff
  // and the 6-attempt cap are hard-coded in lib/webhookDispatch.ts.
  WEBHOOK_DELIVERY_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(60),
  // Document maintenance cron: purges blob bytes for REJECTED docs once
  // they've passed REJECTED_DOC_RETENTION_DAYS (30, hard-coded). Defaults
  // to 86400 (daily) — this is a compliance/storage-hygiene sweep we
  // want on by default; set to 0 only if a downstream job handles purges.
  // The DocumentRecord row stays for audit — only the file leaves disk.
  DOCUMENT_MAINTENANCE_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(86400),
  // Offer-letter backfill sweep (lib/offerLetters.ts): files the published
  // offer-letter template for every APPROVED associate with no OFFER_LETTER
  // document — the catch-all behind the approval hook, and the automatic
  // backfill for people approved before the hook existed. Letters with
  // unresolved template tokens are never filed. Default 6h; 0 disables.
  OFFER_LETTER_SWEEP_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(21600),
  // Org-wide labor-rate fallbacks, applied AFTER a shift's own rate and the
  // per-(client, position) defaults. Product owner (2026-08-17): standard
  // pay is $15/hr associates and $18/hr leads; the Walmart SOW bill rates
  // are $21.21 (associate) / $24.24 (lead). Set to 0 to disable a fallback.
  DEFAULT_ASSOCIATE_PAY_RATE: z.coerce.number().min(0).default(15),
  DEFAULT_LEAD_PAY_RATE: z.coerce.number().min(0).default(18),
  DEFAULT_ASSOCIATE_BILL_RATE: z.coerce.number().min(0).default(21.21),
  DEFAULT_LEAD_BILL_RATE: z.coerce.number().min(0).default(24.24),
  // Fully-loaded labor: employer-side statutory burden as a percentage on
  // top of wages (FICA 7.65 + FUTA ~0.6 + FL SUTA ~2.7 + workers' comp —
  // one knob, per the live-cost design; default 12) and an allocated
  // overhead per WORKED hour (housing + transport + supervision ÷ hours;
  // default 0 until the owner supplies it). Both drive the live floor
  // board's loaded cost. OT (past 40h/week, ALL clients combined) pays and
  // bills at 1.5× — $31.82 billed on the $21.21 SOW rate.
  LABOR_BURDEN_PERCENT: z.coerce.number().min(0).max(100).default(12),
  // Fully-loaded cost of losing one associate (recruiting + onboarding +
  // ramp gap) — drives the executive turnover-cost figure.
  EXEC_COST_PER_SEPARATION: z.coerce.number().min(0).default(400),
  LABOR_OVERHEAD_PER_HOUR: z.coerce.number().min(0).default(0),
  // Schedule gate on kiosk clock-ins (product owner, 2026-08-19): a fresh
  // CLOCK_IN requires an ASSIGNED shift covering the punch (2h early
  // allowance). Blocked punches park as a ClockInRequest for a supervisor
  // to approve (backdated entry) or deny. Clock-outs, breaks, and rejoins
  // are never gated. Explicit string parse — z.coerce.boolean() would
  // treat the string "false" as true.
  KIOSK_REQUIRE_SCHEDULED_SHIFT: z
    .string()
    .optional()
    .transform((v) =>
      v === undefined ? true : v === '1' || v.toLowerCase() === 'true',
    ),
  // Scheduled-report delivery sweep (lib/reportScheduleRunner.ts): runs
  // ReportSchedule rows whose nextRunAt has passed and emails the CSV to
  // the stored recipients. Ticks every N seconds; each tick only touches
  // due schedules, so a 5-minute cadence (default 300) is cheap. Set 0
  // to disable (schedules then accumulate as due until re-enabled).
  REPORT_SCHEDULE_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(300),
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
  PAYROLL_DISBURSEMENT_PROVIDER: z.enum(['STUB', 'WISE', 'BRANCH', 'CHECK']).default('STUB'),
  WISE_API_KEY: z.string().optional(),
  // Wise profile that owns the USD balance transfers fund from. Required
  // (with the API key) before the WISE provider makes real calls.
  WISE_PROFILE_ID: z.string().optional(),
  WISE_API_BASE_URL: z.string().url().default('https://api.wise.com'),
  // Tier-1 honesty guard: in production the STUB adapter refuses to mark
  // items paid unless this is explicitly true. A run that "disbursed" via
  // stub moves no money — that must be an opt-in, never a silent default.
  PAYROLL_ALLOW_STUB_DISBURSEMENT: z.coerce.boolean().default(false),
  // Tier-3 — four-eyes control: when true, a FINALIZED run must be
  // approved by someone other than its creator before it can disburse.
  PAYROLL_REQUIRE_SECOND_APPROVAL: z.coerce.boolean().default(false),
  // When the electronic provider reports no_payout_rail for an associate
  // (no Branch card, no bank account), fall back to issuing a paper check
  // from the check register instead of HELDing the item.
  PAYROLL_CHECK_FALLBACK: z.coerce.boolean().default(false),
  BRANCH_API_KEY: z.string().optional(),
  // Phase 45 — Branch payments rail. BRANCH_API_BASE_URL lets ops point
  // at sandbox vs production without a code change; BRANCH_WEBHOOK_SECRET
  // is the shared HMAC secret Branch signs status-change webhooks with.
  // When the secret is missing, the webhook endpoint refuses every
  // request — never run unauthenticated in any environment.
  BRANCH_API_BASE_URL: z.string().url().default('https://api.branchapp.com'),
  BRANCH_WEBHOOK_SECRET: z.string().optional(),
  // SCIM 2.0 provisioning bearer (Microsoft Entra ID / Okta). When unset,
  // every /scim/v2/* request answers 503 — the surface never runs
  // unauthenticated (same posture as BRANCH_WEBHOOK_SECRET above). Min 32
  // chars; generate with `openssl rand -base64 32` and paste the same value
  // into the IdP's provisioning credential. Rotating it revokes the old
  // token immediately — update the IdP at the same time.
  SCIM_TOKEN: z
    .string()
    .min(32, 'SCIM_TOKEN must be at least 32 chars — generate with `openssl rand -base64 32`')
    .optional(),
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
  // Blob storage driver for document/photo/PDF blobs. `local` (default)
  // keeps today's behavior: files under UPLOAD_ROOT on the filesystem.
  // `s3` stores blobs in an S3-compatible bucket (AWS S3, Backblaze B2,
  // Cloudflare R2) — object keys map 1:1 to the relative keys already in
  // DocumentRecord.s3Key, optionally under STORAGE_S3_PREFIX. Run
  // scripts/migrate-blobs-to-s3.ts BEFORE flipping this to `s3` on an
  // existing deployment. See apps/api/STORAGE.md.
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  // Required when STORAGE_DRIVER=s3 (fail-loud guard below); ignored for
  // local. ENDPOINT only for non-AWS providers. Credentials are optional —
  // when unset, the SDK default provider chain (IAM role / env) applies;
  // when set, both halves must be set together.
  STORAGE_S3_BUCKET: z.string().optional(),
  STORAGE_S3_REGION: z.string().optional(),
  STORAGE_S3_ENDPOINT: z.string().url().optional(),
  STORAGE_S3_ACCESS_KEY_ID: z.string().optional(),
  STORAGE_S3_SECRET_ACCESS_KEY: z.string().optional(),
  // Optional key prefix inside the bucket ("alto-uploads" stores objects
  // as "alto-uploads/<s3Key>"). Leading/trailing slashes are stripped.
  STORAGE_S3_PREFIX: z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined) return undefined;
      const trimmed = v.trim().replace(/^\/+|\/+$/g, '');
      return trimmed.length === 0 ? undefined : trimmed;
    }),
  // Path-style addressing ("https://endpoint/bucket/key"). Unset defaults
  // to true when STORAGE_S3_ENDPOINT is set (B2/R2 need it), false for
  // plain AWS. Accepts 1/0/true/false — explicit string parse because
  // z.coerce.boolean() would treat the string "false" as true.
  STORAGE_S3_FORCE_PATH_STYLE: z
    .string()
    .optional()
    .transform((v) =>
      v === undefined ? undefined : v === '1' || v.toLowerCase() === 'true',
    ),
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
  // Enterprise SSO — OIDC authorization-code + PKCE login (Microsoft
  // Entra ID-ready, but any spec-compliant IdP works). All three core
  // vars unset = the feature is fully off: the login page hides the SSO
  // button and /auth/oidc/start 404s. https is required — discovery and
  // the token exchange carry the client secret, and the ID token is
  // bearer material. Partial configuration is a boot error (see the
  // cross-field guard at the bottom of this file).
  OIDC_ISSUER_URL: z
    .string()
    .url()
    .refine((v) => v.startsWith('https://'), {
      message:
        'OIDC_ISSUER_URL must be an https:// URL (e.g. https://login.microsoftonline.com/<tenant-id>/v2.0)',
    })
    .optional(),
  OIDC_CLIENT_ID: z.string().min(1).optional(),
  OIDC_CLIENT_SECRET: z.string().min(1).optional(),
  // Login-page button copy, e.g. "Sign in with Contoso". Served by
  // GET /auth/oidc/config; never a secret.
  OIDC_BUTTON_LABEL: z.string().min(1).max(60).default('Sign in with SSO'),
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

// STORAGE_DRIVER=s3 with a half-configured bucket must never boot: every
// upload would throw and every download would 500 while the service looks
// healthy. Applies in every NODE_ENV — a broken s3 config is broken in dev
// too. Mirrors the WISE/BRANCH fail-loud pattern below.
if (parsed.data.STORAGE_DRIVER === 's3') {
  if (!parsed.data.STORAGE_S3_BUCKET || !parsed.data.STORAGE_S3_REGION) {
    console.error(
      'FATAL: STORAGE_DRIVER is set to s3 but STORAGE_S3_BUCKET and/or STORAGE_S3_REGION ' +
        'are not configured. The system will not start with blob storage half-wired. ' +
        'Set both (plus STORAGE_S3_ENDPOINT/credentials for non-AWS providers) or set ' +
        'STORAGE_DRIVER=local. See apps/api/STORAGE.md.',
    );
    process.exit(1);
  }
  if (
    Boolean(parsed.data.STORAGE_S3_ACCESS_KEY_ID) !==
    Boolean(parsed.data.STORAGE_S3_SECRET_ACCESS_KEY)
  ) {
    console.error(
      'FATAL: exactly one of STORAGE_S3_ACCESS_KEY_ID / STORAGE_S3_SECRET_ACCESS_KEY is set. ' +
        'Set both for static credentials, or neither to use the SDK default provider chain.',
    );
    process.exit(1);
  }
}

if (parsed.data.PAYROLL_DISBURSEMENT_PROVIDER === 'WISE') {
  if (!parsed.data.WISE_API_KEY || !parsed.data.WISE_PROFILE_ID) {
    console.error(
      'FATAL: PAYROLL_DISBURSEMENT_PROVIDER is set to WISE but WISE_API_KEY and/or ' +
        'WISE_PROFILE_ID are not configured. The system will not start to prevent ' +
        'silent payment failures.',
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

// OIDC SSO: all-or-nothing. A half-configured IdP either renders a dead
// SSO button (issuer without credentials) or crashes mid-flow in front of
// the user's browser (credentials without an issuer to validate against).
// Fail loud at boot instead — mirrors the WISE/BRANCH guards above.
{
  const oidcVars = {
    OIDC_ISSUER_URL: parsed.data.OIDC_ISSUER_URL,
    OIDC_CLIENT_ID: parsed.data.OIDC_CLIENT_ID,
    OIDC_CLIENT_SECRET: parsed.data.OIDC_CLIENT_SECRET,
  };
  const set = Object.entries(oidcVars).filter(
    ([, v]) => v !== undefined && v.trim() !== '',
  );
  if (set.length > 0 && set.length < 3) {
    const missing = Object.entries(oidcVars)
      .filter(([, v]) => v === undefined || v.trim() === '')
      .map(([k]) => k)
      .join(', ');
    console.error(
      `FATAL: OIDC SSO is partially configured — missing ${missing}. ` +
        'Set OIDC_ISSUER_URL, OIDC_CLIENT_ID, and OIDC_CLIENT_SECRET together, ' +
        'or unset all three to turn SSO off.',
    );
    process.exit(1);
  }
}

// Advisory, not fatal: bounce/complaint feedback is strongly recommended
// once real email is flowing (bad addresses are otherwise mailed forever,
// which erodes sender reputation), but email itself works exactly as
// before without it — so a deploy with today's Railway env must boot
// cleanly. Everything in this block is a log line only.
if (
  parsed.data.NODE_ENV === 'production' &&
  parsed.data.RESEND_API_KEY &&
  parsed.data.RESEND_API_KEY.trim() !== ''
) {
  if (
    !parsed.data.RESEND_WEBHOOK_SECRET ||
    parsed.data.RESEND_WEBHOOK_SECRET.trim() === ''
  ) {
    console.warn(
      'WARNING: RESEND_API_KEY is set but RESEND_WEBHOOK_SECRET is not — real ' +
        'email is being sent while bounce/complaint events cannot be received, ' +
        'so the suppression list never populates. When convenient, create a ' +
        'webhook endpoint at https://resend.com/webhooks pointing at ' +
        '/api/resend/webhook and set its signing secret (whsec_...) as ' +
        'RESEND_WEBHOOK_SECRET. Email sending works normally in the meantime.',
    );
  }
}

export const env: Env = parsed.data;
