# Interoperability runbook — operator actions

Some interoperability gaps cannot be closed from code alone: they need an
external enrollment, a tenant-side registration, or a vendor contract.
This runbook lists each one, what the code already provides, and exactly
what an operator must do. Keep it updated as items complete.

---

## 1. Tax e-file validation (BLOCKS filing season)

**What the code provides:** EFW2 (W-2/W-3, `lib/efw2.ts`), EFW2C
(`lib/efw2c.ts`), and IRS FIRE Pub 1220 1099 files (`lib/irsFire.ts`) are
generated for download but are self-documented **unvalidated drafts** —
field positions have never been run through the official validators.

**Operator actions:**
1. **AccuWage Online** (W-2/EFW2): create/log into an SSA Business
   Services Online account at <https://www.ssa.gov/bso/>, open AccuWage
   Online, and upload a generated `efw2.txt` for a representative payroll
   year. File every reported error against the positions in
   `apps/api/src/lib/efw2.ts` (the known-unsure fields are flagged inline:
   RA pos 31, RS FIPS-vs-USPS coding).
2. **IRS FIRE test system** (1099s): enroll for a TCC (Transmitter
   Control Code) via the IR-TCC application, then transmit a generated
   file to <https://fire.test.irs.gov> and correct against the results.
3. Re-run both after any change to the generators. Treat "passes the
   official validator" as the definition of done; until then, files must
   be reviewed by the payroll provider/CPA before submission.

## 2. Microsoft Entra ID app registration (for the OIDC login)

**What the code provides (once the OIDC feature lands):** an env-gated
OIDC authorization-code + PKCE login that discovers endpoints from the
issuer URL and signs in existing users matched by email.

**Operator actions (Entra admin center → App registrations):**
1. New registration → single tenant. Redirect URI (Web):
   `https://people.altohr.com/api/auth/oidc/callback` (the `/api` prefix
   is required — it is the one form that reaches the handler in both dev
   and prod routing).
2. Create a client secret (or certificate); note expiry and calendar the
   rotation.
3. API permissions: `openid`, `profile`, `email` (delegated) — admin
   consent.
4. Set the Railway env vars: `OIDC_ISSUER_URL`
   (`https://login.microsoftonline.com/<tenant-id>/v2.0`),
   `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`.
5. Optional hardening: Conditional Access policy requiring MFA for the
   app; restrict assignment to the staff groups that should reach Alto.

## 3. SAP Fieldglass automation (Walmart SOW — weekly, Mon 2pm PST)

**What the code provides:** a Fieldglass-shaped timesheet week builder,
XLSX workbook download, copy-paste grid, filing snapshots, and the
attestation tile. The re-key into Fieldglass itself is manual.

**Operator actions:** request integration access from the Walmart
Fieldglass program office (options, in order of typical availability):
1. **SFTP upload** of the timesheet file (Fieldglass "Integration
   Connector" flat-file spec) — ask for the supplier upload spec + SFTP
   credentials; the XLSX builder can then be adapted to their exact
   column contract.
2. Fieldglass REST APIs (rarely granted to suppliers).
Until granted, the weekly manual filing stands; the attestation tile is
the compliance record.

## 4. Background check / drug-test vendor (Checkr or Sterling)

**What the code provides:** stubbed initiation (`routes/compliance.ts`),
FCRA disclosure + consent capture, provider-CSV bulk ordering, manual
status updates, result-PDF uploads.

**Operator actions:** sign a vendor agreement (Checkr and Sterling both
have staffing-industry packages), obtain API credentials, and file a
ticket to swap the stub for the vendor client (webhook-driven status
updates). Until then the CSV bulk-order + manual status flow stands.

## 5. E-Verify

**What the code provides:** case status tracking fields, readiness
checks, result-packet uploads, scorecard surfacing. No API — E-Verify
Web Services access requires an MOU with USCIS and a certified software
interface, which is a significant program.

**Operator actions:** none short-term (manual casework in the E-Verify
portal is the standard path at this headcount). Revisit if case volume
makes the double-entry material.

## 6. Off-site backups + S3-primary storage

**What the code provides:** S3-compatible nightly backup of the uploads
volume (`BACKUP_S3_*` env vars); S3-primary document storage is a
tracked code task.

**Operator actions:** provision the bucket (R2/B2/S3), set the four
`BACKUP_S3_*` vars in Railway, and verify a restore once. When
S3-primary lands, the same bucket family serves both.

## 7. Resend webhook endpoint registration — REQUIRED BEFORE DEPLOY

**What the code provides:** a svix-signature-verified `/resend/webhook`
receiver for delivered/bounced/complained events plus a do-not-email
suppression list.

**⚠️ Deploy blocker:** production now refuses to boot when
`RESEND_API_KEY` is set without `RESEND_WEBHOOK_SECRET` (deliberate —
real sends without bounce feedback ruin sender reputation). Railway HAS
the API key set, so this step must happen BEFORE the branch merges to
main, or the next deploy crash-loops.

**Operator actions:** in the Resend dashboard (account
alto50278@gmail.com): Webhooks → Add endpoint →
`https://people.altohr.com/api/resend/webhook`, select the
`email.delivered`, `email.bounced`, `email.complained` events, copy the
signing secret (`whsec_…`) into `RESEND_WEBHOOK_SECRET` on Railway.
