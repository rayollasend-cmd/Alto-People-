# Brief 2-3 investigation: single sign-on, provisioning, RBAC and the audit log

Investigation only (2026-10-13). No code, no schema. Brief 2-3 touches access and security, so by the owner's standing rule it is reported before anything is built.

## 1. Summary

1. **Half of Brief 2-3 already exists, built for one employer.** OIDC sign-in (authorization code + PKCE, Entra-tested), SCIM 2.0 Users (Entra/Okta subset, soft deprovision that kills sessions), passkeys, TOTP MFA, an append-only audit table with a CSV export, and audited sign-ins are all live. Each is configured once for the whole platform: one IdP from environment variables, one SCIM bearer token, one MFA rule on the `OrgSetting` singleton.
2. **The gaps are tenancy, SAML, custom roles and audit completeness.** No SAML. No per-tenant IdP or SCIM credential. SSO matches users by email claim with no subject binding. Roles are a fixed enum of 15 with 58 capabilities; there is no tenant-defined role and no permission matrix page. The audit log covers 54 of 93 route files that mutate data; 155 mutating handlers in 39 files write no audit row, most audits are fire-and-forget, and the append-only trigger does not protect `tenantId` or block `TRUNCATE`.
3. **Headline recommendation:** make identity per tenant first (IdP connections, SCIM tokens, tenant discovery by verified email domain), then RBAC as **tenant roles layered on the existing role archetypes** (the enum stays as the behavioural class; capabilities resolve from a tenant role row), proven by a generated role-equivalence test before any gate reads the new source. Then audit completeness: a mutation-audit middleware on every write route, durable writes, before/after with masking for a named list of sensitive models, a per-tenant hash chain for tamper evidence, retention by archive (never delete), and a SIEM sink on the 2-4 webhook rails. SAML lands after OIDC is per tenant, on one maintained library.
4. **Sizing:** five steps, about five and a half weeks. Nothing in steps 1 to 4 waits on the 2-1 constraint rewrite; per-tenant MFA and email uniqueness per tenant do (§8).
5. **Ten owner decisions** in §9.

## 2. What exists

| Area | Where | State |
|---|---|---|
| OIDC sign-in | `lib/oidc.ts` (509 lines), `routes/oidcAuth.ts` (390), mounted `app.ts:363` at `/auth/oidc` | Code + PKCE, RS256 via JWKS, no new deps. One IdP from `OIDC_ISSUER_URL/CLIENT_ID/CLIENT_SECRET` (`config/env.ts:452-471`, all-or-nothing at boot `:607`). Matches the user by the `email` claim (`oidcAuth.ts:~302`). No auto-provisioning; INVITED → ACTIVE on first SSO; DISABLED gets the same page as unknown (no oracle). SSO is exempt from local TOTP. |
| SAML 2.0 | — | None. |
| SCIM 2.0 | `routes/scim.ts` (937 lines), mounted `app.ts:378` at `/scim/v2` | Users only (GET list/one, POST, PATCH, PUT, DELETE), ServiceProviderConfig/Schemas/ResourceTypes. One bearer `SCIM_TOKEN` (`env.ts:350`), constant-time, 503 when unset. Role from `roles[0].value` (an Alto enum name; ASSOCIATE default; LIVE_ASN and CLIENT_PORTAL refused). POST creates INVITED without mailing. DELETE = DISABLED + `tokenVersion` bump + `invalidateUserCache`. `User.scimExternalId`. Every mutation is a critical audit with `metadata.actor='scim'`. No Groups endpoint. Creates land in the default tenant. |
| Passkeys | `@simplewebauthn/server`, `routes/auth.ts`, `WebAuthnCredential`/`WebAuthnChallenge` (`schema.prisma:4067`) | For everyone; passkey sign-in is exempt from TOTP like SSO. |
| MFA | `otplib`, `User.mfaSecretEncrypted/mfaEnabledAt`, `MfaRecoveryCode`, rule `OrgSetting.mfaRequirement` OFF/ADMINS/ALL read at `routes/auth.ts:490` | Platform-wide rule (singleton). |
| Login and sessions | `routes/auth.ts:377` finds the user by email alone; JWT cookie with `tokenVersion`; `middleware/auth.ts` per-process user cache, 30 s TTL (`:73`) | `User.email` is globally `@unique`, which is what makes "email alone" unambiguous today. |
| Roles | `packages/shared/src/roles.ts`: 15 roles (`:1`), 58 capabilities (`:66`), `ROLE_CAPABILITIES` (`:263`), `hasCapability` (`:493`); multi-role accounts (`additionalRoles`, `activeRole`, max 3 extra, `:627-686`) | Fixed in code. Gates: 193 `requireCapability(` in routes, plus 114 direct role comparisons in API lib/routes (27 in `lib/scope.ts`: boundedness by role) and 104 in the web. |
| Role hiding by module | `apps/web/src/lib/modules.ts:422` `ROLE_MODULE`, `roleOfferedFor` | Web only (2-1b decision 12: "until 2-3"). The API does not refuse assigning a hidden role. |
| API keys and agents | `ApiKey` (`schema.prisma:6365`, per-key capability list, optional client scope); agent scopes `AGENT_SCOPES`; every `/agent/v1` call audited in `middleware/agentAuth.ts:25` | Separate credential systems; not RBAC roles. |
| Audit table | `AuditLog` (actor, clientId, tenantId, action, entityType, entityId, workerId, metadata, createdAt; 6 indexes) | Append-only trigger (`migrations/20261107090000_agent_registry`, lines 95-120) blocks DELETE and edits of id/action/entity/client/worker/metadata/createdAt; allows actor → NULL (user deletion). Does **not** cover `tenantId`; `TRUNCATE` bypasses row triggers (the test harness relies on that). |
| Audit writers | `lib/audit.ts`: `enqueueAudit` (fire-and-forget, `:37`; lost if the process dies before the insert), `recordCriticalAudit` (awaited, `:68`), helpers for login/logout/compliance/document/payroll/shift/time/onboarding | 198 `enqueueAudit` calls in 56 files, 30 critical, 3 direct creates. Sign-ins (success, failure, logout) and admin user mutations (`routes/users.ts:530,661,796`) are critical. |
| Audit coverage | 549 mutating handlers across 116 route files | 39 files with 155 mutating handlers write no audit row at the route (largest: `payrollTax91.ts` 16, `performance84.ts` 13, `lms94.ts` 9, `apiKeysWebhooks93.ts` 8, `timeOff.ts` 7). Some audit inside a lib; most do not. |
| Audit read/export | `routes/audit.ts`: `GET /audit/logs` (cursor, filters), `GET /audit/logs.csv` (50,000-row cap), gated `view:audit` (`app.ts:498`) | No tenant filter in its WHERE; no SIEM sink; no retention policy (rows are kept forever by default, which the trigger enforces). |
| Erasure | `lib/erasure.ts` | Anonymises in place; never deletes audit rows. |

## 3. Gaps against the brief

1. **SSO is one IdP for the platform.** A second tenant cannot bring its own Okta. Identity is matched on a mutable email claim, so a renamed mailbox at the IdP can sign in as someone else if the old address is reissued.
2. **No SAML.** Many hospitality and retail customers' IdPs (ADFS, older Okta apps) are SAML-only.
3. **SCIM is one token, one tenant, Users only, and maps roles by Alto enum name.** Okta and Entra map groups, not enum names; there is no Groups endpoint and no group → role mapping.
4. **No tenant-defined roles, no permission matrix page.** Capabilities are a compile-time map.
5. **Role identity is load-bearing outside capabilities.** Boundedness (`CLIENT_BOUNDED_ROLES`), MFA admin classes, portal/associate behaviour and 218 direct role comparisons depend on *which* role a user holds, not only on what it can do. A custom role must say which of those behaviours it inherits.
6. **Audit completeness.** 155 mutating handlers unaudited; fire-and-forget loses rows on a crash; no before/after; no masking rules; the viewer is not tenant-filtered; `tenantId` editable; `TRUNCATE` unblocked; no tamper evidence beyond the trigger (a superuser can drop it); no retention policy; no SIEM.
7. **Module-hidden roles** are hidden in the web only.

## 4. Design

### 4.1 Identity per tenant

- `IdentityConnection { id, tenantId, kind OIDC|SAML, displayName, issuer/entityId, clientId, clientSecretEnc, samlCert, samlSsoUrl, jitPolicy NONE|INVITED_ONLY, enabled, createdBy }`. Secrets encrypted with the existing payout key machinery (`PAYOUT_ENCRYPTION_KEY`, as QuickBooks tokens are). The environment-variable IdP becomes connection #1 for Alto HR by a migration, then the env path is retired.
- `TenantDomain { tenantId, domain, verifiedAt, verificationToken }`, verified by DNS TXT. **Tenant discovery:** the login page asks for an email; its domain resolves to a verified tenant with an enabled connection → "Continue with <IdP>". A tenant slug route (`/login/<slug>`) is the fallback for shared domains (gmail). Discovery never reveals whether an account exists.
- `UserIdentity { userId, connectionId, subject, emailAtLink, linkedAt }`, unique `(connectionId, subject)`. First SSO sign-in links by verified email inside the tenant (today's behaviour); every later sign-in matches by `subject`, never by email again. A subject change is refused and audited.
- SAML via `@node-saml/node-saml` (maintained, passport-free): SP metadata per connection, signed assertions required, `InResponseTo` + replay cache, clock skew 5 min, no IdP-initiated flow unless the owner turns it on (§9).
- Passkeys stay for everyone who has them; a tenant may set "SSO required" for non-associate roles, which disables password sign-in for those roles (passkeys still allowed, decision 4).

### 4.2 SCIM per tenant

- `ScimToken { tenantId, connectionId?, hashedSecret, lastUsedAt, createdBy, revokedAt }` replaces the single env bearer (env token migrates to Alto HR's row). The token resolves the tenant (as API keys and kiosk devices already do in 2-1 step two), so creates land in the right tenant.
- Add `/Groups` (read, PATCH members) and a `GroupRoleMapping { tenantId, externalGroupId, displayName, tenantRoleId }`. A user's role = the highest-precedence mapped group, else the tenant default (least privilege: ASSOCIATE-archetype role). `roles[0].value` keeps working for Alto HR's existing Entra setup.
- Deprovision stays soft (DISABLED + `tokenVersion` bump + cache invalidation). The acceptance's "within one minute" holds today: the bump is immediate on the instance that served SCIM and the 30 s cache TTL bounds the others.

### 4.3 RBAC: tenant roles over archetypes

- Keep the `Role` enum as the **archetype**: the behavioural class (bounded or org-wide, portal, associate, driver, integration). It answers every direct role comparison exactly as today.
- New `TenantRole { id, tenantId, key, name, archetype Role, system Boolean, capabilities String[] }`. Each tenant gets 15 **system** rows seeded from `ROLE_CAPABILITIES`, one per archetype, read-only. A **custom** role picks an archetype and a capability set that must be a subset of the archetype's ceiling (decision 3), so a custom role can never be wider than the class it behaves as.
- `User.tenantRoleId` (nullable; null = the system row of `User.role`), and the same for `additionalRoles` (an array of tenant role ids alongside).
- One resolver: `capabilitiesOf(sessionUser)` reads the tenant role (cached with the user, same 30 s TTL); `hasCapability(role, cap)` keeps its signature for the archetype default and gains `can(user, cap)`. `requireCapability` switches to `can` in one change, after the equivalence test is green.
- Permission matrix page: rows = the 58 capabilities grouped by product, columns = the tenant's roles; system columns read-only; edits audited as `permission.changed` with before/after; module-gated capabilities greyed when the module is off; the API refuses assigning a module-hidden role (closes gap 7).
- **The equivalence proof (test first):** a generated test iterates every archetype × every capability and asserts `can(userWithSystemRole, cap) === hasCapability(archetype, cap)`, then walks the router (`lib/routeInventory.ts`) calling every gated route as each built-in role before and after the switch and asserts identical status classes. It must be green before `requireCapability` reads the new source, and it stays as a regression gate.

### 4.4 Audit log completeness

- **Every mutation:** a middleware on every `POST/PUT/PATCH/DELETE` (and every export route by name) writes `http.<method>` with actor, tenant, route pattern, target ids from params, status and request id, after the handler, awaited before the response is flushed. Domain audits keep their richer rows; the middleware row is the floor that guarantees "every create, update, delete, export".
- **Durability:** the floor and every security-class event (sign-in, permission change, role change, export, agent action, SCIM) are awaited (`recordCriticalAudit` path). Fire-and-forget stays only for high-volume operational events and is moved to a transactional outbox later if the owner wants (decision 7).
- **Before/after with masking:** a Prisma extension on a named list of sensitive models (User role/status/email, CompensationRecord, PayoutMethod, W-4, TIN, Employment, TenantRole, IdentityConnection, ShiftRateDefault, TransportRate) reads the row before update and records changed fields only; values of SSN, bank account, routing number, TOTP secret and similar are written as `••••1234` or `[changed]`, never in clear (standing rule).
- **Tamper evidence:** add `seq BIGINT` and `hash`/`prevHash` per tenant, computed in a `BEFORE INSERT` trigger under a per-tenant advisory lock (`sha256(prevHash || canonical row)`); a nightly verifier job walks each tenant's chain and alerts on a break. Extend the immutability trigger to `tenantId`. Add a `BEFORE TRUNCATE` trigger that refuses unless the session sets `alto.allow_audit_truncate = 'test'`, which only the test harness sets.
- **Retention:** default 7 years (payroll and I-9 horizons), tenant may raise, never lower below the legal floor. Rows past retention are exported to the tenant's archive (encrypted object storage, hash-chain head recorded) and stay in the table until a separate, owner-approved purge procedure exists (decision 8). Nothing is deleted in 2-3.
- **Export:** the CSV gains tenant filtering (a gap today) and a streamed, uncapped variant for admins; SIEM = per-tenant HTTPS sink (JSON lines, HMAC-signed, retries, delivery log) built on the 2-4 webhook delivery rails, plus syslog-over-TLS if a customer asks (decision 9).

## 5. Rollout

| Step | Content | Size |
|---|---|---|
| 1. Audit floor first | Mutation middleware on every write and export route; awaited security-class events; tenant filter on the audit viewer and CSV; trigger covers `tenantId` + TRUNCATE guard; the 20-action acceptance script as a test | 1 week |
| 2. Identity per tenant (OIDC) | `IdentityConnection`, `TenantDomain` + DNS verification, `UserIdentity` subject binding, discovery on the login page, Alto HR's env IdP migrated to a row; per-tenant `ScimToken`; SCIM resolves the tenant | 1.5 weeks |
| 3. RBAC | Equivalence test first; `TenantRole` + system rows; resolver; `requireCapability` switched; matrix page; custom roles; API refuses module-hidden roles; SCIM `/Groups` + group → role mapping | 1.5 weeks |
| 4. Audit depth | Before/after with masking on the sensitive list; hash chain + nightly verifier; retention setting + archive export; SIEM sink (after 2-4's delivery rails, or a minimal signed sink if 2-4 is later) | 1 week |
| 5. SAML + acceptance | `@node-saml/node-saml` connections, SP metadata, replay cache; Okta (SAML and OIDC) and Entra end-to-end with a real dev org; acceptance run | ½ week (+ IdP setup by the owner) |

Each step is additive: a feature flag per tenant (`identity.v2`) keeps Alto HR on today's paths until its connection row is verified working.

## 6. Risks

1. **Lock-out.** A wrong IdP connection or "SSO required" can lock a tenant's admins out. Mitigation: SSO-required never applies to the account that turned it on until that account has signed in through the connection once; a break-glass owner account with passkey + TOTP per tenant; every change audited and reversible.
2. **Privilege drift in the RBAC switch.** 193 capability gates, 218 direct role comparisons. Mitigation: archetypes keep every direct comparison exact; the generated equivalence test and route walk gate the switch; custom roles are subsets of their archetype.
3. **Email-claim takeover.** Today's email matching. Mitigation: subject binding from the first link; refuse subject change.
4. **Audit write latency.** Awaiting the floor adds ~5-15 ms to mutating requests (writes are a small share of traffic). Accepted by recommendation; measure on the reliability page.
5. **Hash-chain contention.** A per-tenant advisory lock serialises audit inserts per tenant. At current volume (hundreds of associates) negligible; revisit with a sharded chain if a tenant exceeds ~200 writes/s.
6. **Test harness.** `TRUNCATE "AuditLog"` must stay possible in tests only; the guard keys on a session setting the app never sets.
7. **Okta/Entra availability.** The acceptance needs real dev orgs; we have none today.

## 7. The 20 scripted actions (audit acceptance)

Run as one test against a fresh tenant; each must produce exactly the expected row(s) with actor, tenant, target, and masked before/after where marked (*), and then an attempted UPDATE, DELETE, TRUNCATE and chain edit must each be refused or detected.

1. Password sign-in success. 2. Password sign-in failure (wrong password). 3. SSO sign-in (OIDC). 4. Sign-out. 5. SCIM create user. 6. SCIM deactivate user (sessions ended). 7. Admin invites a user. 8. Admin changes a user's role* (permission change). 9. Admin edits a custom role's capabilities* (matrix). 10. Admin grants an additional role. 11. Associate's pay rate changed* (CompensationRecord). 12. Payout method revealed (read of a sensitive field). 13. Payout method changed* (bank masked). 14. W-4 updated*. 15. A shift created, then deleted. 16. A time entry approved. 17. Payroll run created and finalized. 18. Audit CSV exported. 19. An agent call on `/agent/v1` that requests a gated action (agent action + approval request). 20. A tenant setting changed (MFA requirement or identity connection)*.

## 8. Tenancy dependencies

- Builds now, on 2-1 step one's defaulted `tenantId`: identity connections, domains, user identities, SCIM tokens, tenant roles, the audit floor, chain and SIEM (all new tables carry `tenantId`; reads filter explicitly while `TENANCY_MODE` is observe, as the cross-tenant suite requires).
- Waits for the 2-1 constraint rewrite (sequenced after a clean 1A-1 run): `User.email` unique per tenant instead of globally (login by email alone becomes ambiguous then, which is why discovery is by domain/slug from the start); `OrgSetting.mfaRequirement` per tenant (the singleton conversion); RLS backing the audit viewer.

## 9. Owner decisions

1. **Tenant discovery by verified email domain, slug as fallback.** Recommendation: yes; no "pick your company" list (it leaks the customer list).
2. **Subject binding:** match by IdP subject after the first link, refuse a subject change. Recommendation: yes; it closes the email-reuse takeover.
3. **Custom roles are subsets of an archetype** (a custom role cannot exceed the built-in role it behaves as). Recommendation: yes; it is what makes the equivalence proof hold for custom roles too.
4. **"SSO required" per tenant for non-associate roles; passkeys still allowed; associates keep passwords and passkeys.** Recommendation: yes.
5. **JIT provisioning off by default** (SSO never creates accounts; SCIM or invite does), per-connection opt-in to "activate invited only". Recommendation: yes, as today.
6. **IdP-initiated SAML off by default.** Recommendation: yes; it is the replay-prone flow.
7. **Await the audit floor and every security-class event; keep fire-and-forget for operational events.** Recommendation: yes; a transactional outbox later only if a crash-loss is ever observed.
8. **Retention: 7-year default, archive past it, no deletion in 2-3.** Recommendation: yes; a purge procedure is a later, separate approval.
9. **SIEM: HTTPS JSON sink on the 2-4 delivery rails; syslog only on request.** Recommendation: yes.
10. **Order: audit floor before identity, identity before RBAC, SAML last.** Recommendation: yes; the floor makes every later step's changes visible, and SAML is the least-used path among current prospects.

## 10. Acceptance mapping

| Brief acceptance | Where it is proven |
|---|---|
| A user provisioned from Okta signs in by SSO, holds the mapped role, is deactivated by SCIM within one minute | Step 5 run against an Okta dev org (owner provides): SCIM POST with a group → mapped tenant role; OIDC (and SAML) sign-in; SCIM DELETE → `tokenVersion` bump; a test asserts the next request is 401 and the 30 s cache bound. An automated twin in CI uses a local fake IdP (signed JWTs/assertions) and the SCIM routes. |
| The audit log captures a scripted set of 20 actions completely and cannot be altered | §7 as one CI test from step 1 (rows present) and step 4 (masked before/after, chain intact, UPDATE/DELETE/TRUNCATE refused, a forged edit detected by the verifier). |

## Owner approval

**Approved 2026-10-13: every decision in this report, as recommended.** Building proceeds step by step in the order of the plan; each step lands with its tests and is reported before the next.
