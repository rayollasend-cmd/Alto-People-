# Brief 1A-4 — Users & access cleanup and the QuickBooks reconnection

Built 2026-10-13. Nobody is deactivated by this brief: the report and the tooling exist, the owner approves the list.

## The access report

`GET /admin/users/access-report` (`?format=csv`), the Access report section of the Users page, and from the command line against production:

```
railway run --service api -- npx tsx scripts/access-report.ts
railway run --service api -- npx tsx scripts/access-report.ts --csv > access-report.csv
```

Every account that is not deleted, with role, additional roles, status, scope (client · store, region, or org-wide), the person behind it, the employment record (employed, separated, deactivated, erased, none, not applicable for office roles), created date, last sign-in (`User.lastSeenAt`, stamped at login and on activity; the activity-day table as the fallback), and whether the email is on a free-mail domain.

Flags, one account may carry several:

| Flag | Rule |
| --- | --- |
| Client portal login on a personal email | role CLIENT_PORTAL and the domain is in the free-mail list (gmail, yahoo, hotmail, outlook, icloud, aol, proton, the big ISPs) |
| Region scope | `regionId` set |
| Same person on more than one account | the same person's name (from the associate record or the display name) on two accounts, or the same mailbox under two addresses (gmail-style: dots and +tags ignored) |
| Workforce role with no employment record | ASSOCIATE, DRIVER, SHIFT_SUPERVISOR or FLOOR_SUPERVISOR with no associate record |
| Employment ended, account still on | the associate is separated, deactivated or erased and the account is not disabled |
| No sign-in in 90 days | account older than 90 days, not disabled, not the LIVE_ASN system role, with no sign-in in 90 days (never signed in counts) |
| Deactivated, deletion pending | in the 30-day reversible state |

Counts come first: total accounts, by status, by role, active associates by the one definition of active (Brief 1A-2), flagged accounts, and the count per flag. The acceptance report with production numbers is produced by running the script above; this repository has no production database access.

## Deactivation, reversible for 30 days

`POST /admin/users/deactivate { userIds, reason }` (manage:org). Each account: status DISABLED, `deactivatedAt`, `deactivationReason`, `deactivatedById`, `purgeAfter` = 30 days out, every session ended, one `admin.user_deactivated` audit row with the reason, the previous status, the IP and the user agent. Refused for the caller's own account, for LIVE_ASN, and for accounts already deactivated (returned as `skipped` with the reason, the rest proceed).

`POST /admin/users/:id/reactivate` (manage:org) within the 30 days: back to ACTIVE (INVITED when they never set a password), the fields cleared, `admin.user_reactivated` audited with the days that were left.

The sweep (`startAccessPurgeCron`, every 6 hours) soft-deletes accounts past `purgeAfter` (`deletedAt`, sessions ended, `admin.user_deleted_after_grace` audited). Nothing is hard-deleted; the row stays for the audit trail and the person can be invited again.

## Client portal scope

A store login is the default: `POST /clients/:id/portal-users` needs `locationId` unless `wholeClient: true` is sent by name (a market manager over one client). Region scope (`POST /regions/:id/portal-users`, or `PATCH /admin/users/:id` with a new `regionId`) needs `approvedByUserId`: an active account holding manage:org. The approver is recorded on the account (`regionApprovedById`, `regionApprovedAt`) and in the audit log (`portal.region_scope_approved` on invite; `regionApprover` inside `admin.user_updated` on a move), with `selfApproved: true` when the approver named is the person making the change.

## QuickBooks

The "needs reconnection" state and the reconnect flow already exist (shipped with the Sentry weekly fixes): `GET /quickbooks/status` returns `needsReconnect` when the stored tokens cannot be read under the current key; the client page shows "QuickBooks needs to be reconnected" with a Reconnect button; `POST /quickbooks/connect/start` → Intuit → `GET /quickbooks/connect/callback` stores the fresh token pair with the current `PAYOUT_ENCRYPTION_KEY` (`saveConnection`), keeping the account mapping; any read that meets unreadable tokens answers 409 `quickbooks_reconnect_required` instead of a raw decryption error.

What is left for a person with the Intuit login: open the client's QuickBooks section in production, choose Reconnect, sign in to Intuit, then confirm `GET /api/quickbooks/accounts/list` returns the chart of accounts. That is the acceptance step; it cannot be done from the repository.

## Written confirmation: what the key change touched

Every column encrypted with `PAYOUT_ENCRYPTION_KEY`, from the schema and `lib/crypto.ts` callers, as of 2026-10-13:

| Table.column | What |
| --- | --- |
| `W4Submission.ssnEncrypted` | Social Security numbers on W-4s |
| `Associate.tinEncrypted` | contractor TINs |
| `PayoutMethod.accountNumberEnc` | direct-deposit account numbers (`routingNumberEnc` holds plain bytes by design and is unaffected) |
| `I9Verification.alienRegistrationNumberEnc` | I-9 A-numbers |
| `KioskPin.pinEncrypted` | kiosk clock-in numbers |
| `QuickbooksConnection.accessTokenEnc` / `refreshTokenEnc` | QuickBooks OAuth tokens |

`User.mfaSecretEncrypted` uses `MFA_SECRET_ENCRYPTION_KEY` when set, else the same key.

Not affected: worker documents and their files. I-9 and E-Verify documents, signed agreements, pay stubs and every other `DocumentRecord` are files in the blob store addressed by key, not ciphertext under this key; no document bytes are encrypted with `PAYOUT_ENCRYPTION_KEY`. No other column in the schema is encrypted.

Which rows are still unreadable is a production question. `scripts/audit-encryption-key.ts` tries every column above against the running key and prints counts and date ranges only, never plaintext:

```
railway run --service api -- npx tsx scripts/audit-encryption-key.ts
```

Its output is the written confirmation of counts; the recovery path for each column is printed with it (W-4 SSN re-collection campaign, direct-deposit re-entry, I-9 re-entry from the document on file, kiosk number rotation, QuickBooks reconnect, MFA re-enrolment).
