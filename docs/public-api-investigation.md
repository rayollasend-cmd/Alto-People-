# Public API, webhooks and the MCP server: investigation (Briefs 2-4 and 2-7)

Investigation only (2026-10-13). No code, no schema, no migrations. Brief 2-4 asks for a documented `/v1` REST API with OAuth 2 client credentials, rate limits, idempotency, five webhook events and an OpenAPI spec generated from code. Brief 2-7 asks for an MCP server that lets an external agent act under the registry's gates. This report covers both because 2-7 rides on 2-4's webhooks and on the agent capability catalog.

## 1. Summary

1. **Half of 2-4's plumbing already exists from Phase 93, and none of its surface does.** API keys (`altop_`, bcrypt-hashed, capability-scoped, tenant-resolved), a webhook model with a signed, retried, SSRF-guarded delivery worker and a delivery log, a database-backed Idempotency-Key middleware, per-key rate limiting and a hand-written OpenAPI 3.1 document with a drift test are all live. What is missing is the brief itself: no OAuth client credentials, no `/v1`, no writes, none of the five required events, a spec that is written by hand, and no developer page.
2. **One security finding needs fixing before anything else: webhook fan-out ignores the tenant.** `emitWebhookEvent` (`lib/webhookDispatch.ts:71`) selects every active webhook with `clientId: null`, in every tenant. With a second live tenant, its hires and payroll runs would be delivered to Alto HR's global webhooks, and the reverse. The admin lists `GET /api-keys` and `GET /webhooks` (`routes/apiKeysWebhooks93.ts:49`, `:120`) are also unfiltered; the cross-tenant suite did not flag them only because it seeds no keys or webhooks. Small fix, recommended now (step 0).
3. **The public resources must have their own schemas.** The internal zod shapes carry pay and location data the brief never asks to expose: `ShiftSchema` has `hourlyRate`, `payRate`, `effectivePayRate`; `TimeEntrySchema` has `payRate` and clock-in/out latitude and longitude; documents carry `s3Key` and I-9 list data; programs carry SEVIS and DS-2019 numbers. `/v1` gets a small set of public schemas with an explicit exclusion list (§5.3), and those schemas are what the OpenAPI spec is generated from.
4. **Recommendation:** build `/v1` as a new router beside `/integrations/v1` (which stays frozen for the ASN bridge), on OAuth client credentials that mint 15-minute tokens carrying the tenant and scopes, with every route declared once through a `defineRoute` helper that both mounts it and registers it in a `@asteasolutions/zod-to-openapi` registry, so the spec cannot drift. Writes are allowed, audited under the API client with a named human owner. Webhooks gain the five events, a timestamped signature and encrypted secrets. The MCP server (2-7) is a thin layer over `/agent/v1`, authenticated by agent credentials, its tools generated from `capabilitiesFor`. About six weeks for 2-4 after the step-0 fix, then one and a half for 2-7. Fourteen owner decisions in §8.

## 2. What exists

| Piece | Where | State |
|---|---|---|
| API keys `altop_<64 hex>` | `middleware/apiKeyAuth.ts:40-140`, admin routes `routes/apiKeysWebhooks93.ts:48-115` | bcrypt hash, `last4` bucket lookup, `capabilities String[]`, optional `clientId` scope, `expiresAt`/`revokedAt`, `lastUsedAt`; the key's tenant becomes the request's (`runWithTenant(matched.tenantId, 'api-key', …)`, `apiKeyAuth.ts:118`). No OAuth, no token exchange |
| `/integrations/v1` | `routes/integrationsV1.ts` (441 lines), mounted `app.ts:370` behind `requireModule('payrollSync')` | Six read-only endpoints for the ASN bridge: `/me`, `/stores`, schedule, roster, clocked-in, KPIs. Its header states "writes intentionally stay on the human-session API so audit logs always carry a real user identity" |
| OpenAPI | `lib/integrationsOpenapi.ts` (500 lines), served unauthenticated at `/integrations/v1/openapi.json` | Hand-written OpenAPI 3.1; `__tests__/routes/integrationsOpenapi.test.ts` asserts documented paths and router paths match both ways |
| Rate limits | `middleware/rateLimit.ts:311` (`integrationsApiKeyLimiter`, 60/min/key), `:448` (anon) | express-rate-limit, in-process memory store; correct on one replica (`MULTI_REPLICA=0`, `config/env.ts:320`) |
| Idempotency | `middleware/idempotency.ts` (201 lines), sweep cron `index.ts:172` | Stripe-style, DB-backed, 24 h, 409 on body mismatch or in-flight; keyed on `(userId, method, path, key)` (`:60-76`), so it needs `req.user` and cannot serve an API client today. Applied per route in payroll, onboarding, org, communications, holidays |
| Webhooks | models `Webhook` (url, `secret` in plain text, `eventTypes[]`, `clientId?`, tenantId), `WebhookDelivery` (status, attempts, `nextAttemptAt`, response status and body) | Admin CRUD, toggle, delivery log and test-fire in `apiKeysWebhooks93.ts:117-200`; web page `pages/integrations/IntegrationsHome.tsx` |
| Delivery worker | `lib/webhookDispatch.ts` | `emitWebhookEvent` fans out to PENDING rows and never throws; `deliverOne` POSTs with `X-Alto-Signature` = HMAC-SHA256(hex) of the body, `X-Alto-Event`, `X-Alto-Delivery`; 6 attempts, backoff 1/5/30/120/720 min; SSRF re-check per attempt (`lib/safeOutboundUrl.ts`); claim by guarded `updateMany` so replicas never double-post; runs under `tenantJob` |
| Events emitted today | `onboarding.ts:1226` onboarding.completed, `:1236` associate.hired, `payroll.ts:1295` payroll.finalized, `positions.ts:303/365` position.opened/filled, `separation119.ts:341` associate.terminated, time_off.requested/approved/denied (`timeOff.ts`, `team.ts`, `lib/timeOffRequests.ts`), `lib/documentMaintenance.ts:143` compliance.expiring | Ten types, listed again in the web page (`IntegrationsHome.tsx:62`). None of the five 2-4 asks for |
| Agent API | `routes/agentApi.ts` (11 endpoints), `middleware/agentAuth.ts` | `alto_agent_` credentials, scopes, per-agent rate tokens, hours, spend cap, kill switch read on every call, every call on the agent's audit trail, gated approval requests |
| Route inventory and tenancy gate | `lib/routeInventory.ts` (`listRoutes`), `__tests__/tenancy/crossTenant.test.ts` + baseline | Every mounted route is called as a second tenant; a new leaking route fails CI |
| Contracts | `packages/shared/src/contracts.ts` (8,735 lines, 503 zod schemas, zod 3.23.8) | No OpenAPI generator dependency anywhere |
| Developer page | none | |

## 3. Gaps against the briefs

| Brief asks | Gap |
|---|---|
| OAuth 2 client credentials per tenant | Static bearer keys only; no client model, no token endpoint |
| `/v1` covering workers, schedules, time entries, sites, documents (metadata), programs, agent registry | Only stores, schedule, roster, clock-ins, KPIs, all read-only, under the payroll-sync module gate |
| Idempotency keys on writes | The middleware exists but keys on a session user |
| Rate limits | Exist per key; need per-client limits and a tenant ceiling |
| Webhooks: shift created/changed, time entry approved, worker status changed, program alert, agent approval requested | None emitted. Signature has no timestamp (a captured delivery can be replayed); the secret is stored in plain text |
| Signed payloads, retries, delivery log | Done (Phase 93) |
| OpenAPI generated from code, matches every live endpoint | Hand-written; the drift test covers only `/integrations/v1` |
| Developer page with examples | None |
| Sample script: create worker, schedule shift, receive webhook | None |
| 2-7: MCP server over registry credentials, capability-mapped tools, gated tools return an approval id | No MCP code; the capability catalog and proposals arrive with agent-families step 0 |
| Tenancy | Webhook fan-out and the two admin lists are not tenant-filtered (§1.2) |

## 4. Design: authentication, authorization, audit

**API clients.** A new `ApiClient` model per tenant: `id`, `tenantId`, public `clientId` (`altc_` + 24 chars), `secretHash` (bcrypt, shown once), `name`, `scopes String[]`, `ownerUserId` (a named, accountable person, the same rule as every agent and robot), `status ACTIVE|REVOKED`, `lastUsedAt`, `expiresAt?`, `createdById`. Rotation keeps the previous secret valid for five minutes, as agent credentials do.

**Token.** `POST /v1/oauth/token` with `grant_type=client_credentials` (HTTP Basic or form fields) returns a 15-minute signed JWT (`sub` = client id, `tid` = tenant, `scope`, `jti`). `requireApiToken(scopes)` verifies it, re-reads the client's status (a revoked client stops within one request, not one token lifetime), and runs the request in the client's tenant through `runWithTenant`. The JWT secret is separate from session signing (`API_TOKEN_SECRET`).

**Scopes.** `workers:read`, `workers:write`, `workers:contact` (email, phone), `sites:read`, `schedules:read`, `schedules:write`, `time:read`, `documents:read` (metadata), `programs:read`, `agents:read`, `webhooks:manage`, `pay:read` (rates; off by default, granted explicitly). A route declares its scopes once in `defineRoute`; the token must carry all of them.

**Audit.** Every `/v1` write writes an AuditLog row with a new nullable `apiClientId` beside `actorUserId` and `workerId`, plus the owner's user id in metadata. This answers Phase 93's reason for keeping writes off the public API: the actor is a registered client with a named human owner, not an anonymous key.

**Tenancy.** Every `/v1` handler filters `tenantId: tenantIdForWrite()` explicitly (the pattern from the leak work) and is called by the cross-tenant suite with a second tenant's token. Module gates apply: a resource whose module is off answers 404 (programs without `programs`, scheduling without `scheduling`).

## 5. Design: the API surface

### 5.1 Routes

| Resource | Routes | Scopes |
|---|---|---|
| Token | `POST /v1/oauth/token` | none (client credentials) |
| Workers | `GET /v1/workers`, `GET /v1/workers/:id`, `POST /v1/workers` (a PERSON worker + associate, placed at a site; no SSN, no bank, no tax data accepted) , `PATCH /v1/workers/:id` (name, phone, email, status ACTIVE/INACTIVE) | `workers:read` / `workers:write` |
| Sites | `GET /v1/sites`, `GET /v1/sites/:id` | `sites:read` |
| Schedules | `GET /v1/shifts?siteId&from&to`, `GET /v1/shifts/:id`, `POST /v1/shifts`, `PATCH /v1/shifts/:id`, `POST /v1/shifts/:id/assign`, `POST /v1/shifts/:id/cancel` | `schedules:read` / `schedules:write` |
| Time entries | `GET /v1/time-entries?workerId&from&to&status`, `GET /v1/time-entries/:id` | `time:read` |
| Documents | `GET /v1/workers/:id/documents`, `GET /v1/documents/:id` (metadata only) | `documents:read` |
| Programs | `GET /v1/programs?type`, `GET /v1/programs/:id` | `programs:read` |
| Agent registry | `GET /v1/agents`, `GET /v1/agents/:id` (profile, owner, status, scopes, capabilities; never credentials) | `agents:read` |
| Webhooks | `GET/POST /v1/webhooks`, `PATCH/DELETE /v1/webhooks/:id`, `GET /v1/webhooks/:id/deliveries`, `POST /v1/webhooks/:id/deliveries/:deliveryId/redeliver` | `webhooks:manage` |
| Spec | `GET /v1/openapi.json` (no token, anon limiter) | none |

Writes reuse the domain code the session routes call (shift creation's client-or-site rules, `site_required`, the H-2B rule on assignment, notice rules), never a parallel path.

### 5.2 Conventions

Cursor pagination (`?cursor&limit≤200`), ISO 8601 UTC timestamps, the existing error envelope `{ error: { code, message, requestId } }`, `Idempotency-Key` **required** on every POST (400 `idempotency_key_required`), the middleware re-keyed on a principal (`user:<id>` or `client:<id>`) so one implementation serves both. Rate limit 600/min per client and 3,000/min per tenant across its clients, draft-7 headers; a Postgres-backed store when `MULTI_REPLICA=1`.

### 5.3 What each resource never exposes

| Resource | Fields exposed | Excluded |
|---|---|---|
| Worker (person) | id, type, name, status, employment type, site, position, hire date, separation date | SSN and `ssnLast4`, `tinEncrypted`, date of birth, home address, W-4, bank and payout methods, pay rates (unless `pay:read`), passport last 4, face and kiosk PIN data; email and phone only with `workers:contact` |
| Worker (agent/robot) | id, type, name, status, owner, capabilities | credentials, spend detail |
| Shift | id, site, position, starts/ends, timezone, status, assigned worker id, published/acknowledged times | `hourlyRate` (bill rate), `payRate`, `effectivePayRate` (unless `pay:read`), notes, late-notice reason, cancellation reason text |
| Time entry | id, worker, site, shift, clock in/out, status, net minutes, breaks, approved at | latitude and longitude of clock-in and clock-out (never), `payRate` (unless `pay:read`), anomaly detail, rejection reason text, approver email |
| Document | id, worker, kind, status, expires at, uploaded at, verified at | file bytes and any download URL, `s3Key`, filename (often carries names or numbers), `i9DocTitle`, `i9List`, `side`, rejection reason; I-9, E-Verify, W-4 and SSN-card kinds are not listed at all |
| Program | id, worker, type (J-1/H-2B), sponsor name, program start/end, status | SEVIS id, DS-2019 number, visa number, passport, country, notes |
| Site | id, name, type, timezone, state, org unit, active | client billing data, geofence detail |

## 6. Design: webhooks

**Tenant fan-out (step 0).** `emitWebhookEvent` filters webhooks by the emitting context's tenant (`currentTenantId()`, or an explicit `tenantId` option for jobs); `deliverPendingDeliveries` claims only the running tenant's rows; the two admin lists filter by tenant. A test emits in tenant two and asserts tenant one's global webhook gets no delivery.

**The five events and where they fire.**

| Event | Emit point |
|---|---|
| `shift.created`, `shift.changed` (including assigned, unassigned, cancelled, published) | the shift create, update, assign, unassign, cancel, publish and bulk paths in `routes/scheduling.ts`, one emit per committed change, payload = the public Shift |
| `time_entry.approved` | `POST /time/admin/entries/:id/approve` and bulk approve in `routes/time.ts` |
| `worker.status_changed` | approval to ACTIVE (`onboarding.ts`), separation (`separation119.ts`), deactivation and reactivation (`lib/deactivation.ts`), Worker status changes for agents and robots |
| `program.alert` | the program alert sweep (`lib/programs.ts`, `lib/programDigest.ts`), payload = alert kind, program id, due date, never document numbers |
| `agent.approval_requested` (and `agent.approval_decided`) | `createApprovalRequest` and `decideApproval` in `lib/agents.ts` |

Payloads carry the §5.3 public shape, never internal rows. Existing event names stay; the new ones join the catalog the web page and the spec both read from one shared list.

**Signature v2.** `Alto-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "t.body">`, receivers reject timestamps older than five minutes; the old `X-Alto-Signature` keeps being sent for 90 days for existing subscriptions. **Secrets encrypted at rest** with a dedicated `WEBHOOK_SECRET_KEY` (the QuickBooks lesson: never share a key across domains), re-encrypting existing rows in a backfill. **Redeliver** a delivery by id. A per-webhook "last 7 days success rate" on the page.

## 7. Design: OpenAPI and the developer page

**Generated, so it cannot drift.** Add `@asteasolutions/zod-to-openapi` (zod v3 line). `/v1` routes are declared through one helper, `defineRoute({ method, path, scopes, params, query, body, responses, summary, example })`, which mounts the Express handler with validation and registers the operation in an `OpenAPIRegistry`. The spec is built from the registry at boot and served at `/v1/openapi.json`. A test (a) validates it with `@apidevtools/swagger-parser`, (b) compares `listRoutes()` for `/v1` with the spec's paths in both directions, (c) checks every operation's example against its response schema. `/integrations/v1` keeps its hand-written document and drift test.

**Developer page.** `/developers` in the web app, public: getting a client, the token call, scopes, pagination, idempotency, errors, rate limits, webhook verification (Node and Python snippets for signature v2), the event catalog with sample payloads, and the reference rendered from the spec by our own components (no third-party viewer: the CSP blocks eval, the OpenCV lesson). Client and webhook management stays on the Integrations page for admins.

**Sample integration.** `scripts/sample-integration.ts`: token, `POST /v1/workers`, `POST /v1/shifts`, a local receiver that verifies the signature and prints the `shift.created` delivery. The same flow runs in CI as an API test with a capturing sender in `deliverOne` (a test seam like `setWhatsAppSenderForTests`).

## 8. Brief 2-7: the MCP server

**Shape.** An HTTP endpoint in the API at `/mcp` (Streamable HTTP transport) plus a small stdio package (`packages/mcp`, using `@modelcontextprotocol/sdk`) that forwards to it, so desktop agents and hosted agents use the same server. Authentication is an `alto_agent_` credential only (never an API client): `requireAgent` already enforces scopes, rate tokens, hours, spend cap and the kill switch, and writes every call to the agent's trail.

**Tools generated from the catalog.** `capabilitiesFor(tenant modules)` (agent-families §8) intersected with the agent's granted capabilities becomes the tool list; each tool carries its capability key, scopes and gate, and its call writes an AuditLog row naming the scope used and, for gated tools, the approval id. Tools: `read_schedule` (schedules, no gate), `propose_shift_fill` (an `AgentProposal` with a SHIFT_ASSIGN approval, never a direct assignment), `open_case` (CASE_OPEN proposal, under the agent-only `open:hr-case` scope proposed in agent-families §8), `request_approval`, `my_scorecard`, `my_requests`. A gated tool returns `{ approvalId, status: "pending" }` and does nothing else; the agent polls `my_requests` or subscribes to `agent.approval_decided` through 2-4's webhooks.

**Catalog page.** The developer page lists the tools from the same catalog with an example call each.

**Acceptance mapping.** A sample external agent script connects with a registry credential, calls `read_schedule` for a week, calls `propose_shift_fill` and gets an approval id that appears in the queue, and after the credential is revoked gets 401 on the next call; the trail shows each call with the scope and the approval id.

## 9. Rollout

| Step | Content | Size |
|---|---|---|
| 0. Webhook tenancy fix | tenant filter on fan-out, the delivery sweep and the two admin lists, with the cross-tenant test; can ship now, independent of everything else | 1 day |
| 1. API clients and tokens | `ApiClient`, token endpoint, `requireApiToken`, scopes, AuditLog `apiClientId`, admin UI on the Integrations page, rotation and revoke | 1 week |
| 2. `defineRoute` and the spec | registry, `/v1/openapi.json`, the validator and route-match tests, idempotency re-keyed on a principal, the per-client and per-tenant limiters | ½ week |
| 3. Read resources | workers, sites, shifts, time entries, documents metadata, programs, agents, with the §5.3 schemas and the cross-tenant suite over a tenant-two token | 1 week |
| 4. Writes | workers create and update, shifts create, update, assign, cancel, through the session routes' domain code, audited | 1 week |
| 5. Webhooks | the five events, signature v2, encrypted secrets with backfill, redeliver, `/v1/webhooks` | 1 week |
| 6. Developer page and acceptance | `/developers`, the sample script, the CI version of the acceptance flow | ½ week |
| 7. MCP (2-7) | after agent-families step 0 (capabilities, proposals) and step 5 above: `/mcp`, the stdio package, the generated tools, the sample agent | 1½ weeks |

## 10. Risks

| Risk | Mitigation |
|---|---|
| Sensitive data leaks through a public shape | Dedicated public schemas, never the internal ones; a test asserts the excluded field names never appear in any `/v1` response or webhook payload |
| Public writes bypass a business rule | Writes call the same domain functions as the session routes; the session routes' tests are reused against `/v1` where the rule matters (site required, H-2B, notice) |
| Token theft | 15-minute tokens, client status re-read per request, secrets hashed and shown once, rotation with a five-minute overlap |
| Webhook receivers replay captured deliveries | Signature v2 with a timestamp; delivery id for dedupe |
| Spec drift | Routes exist only through `defineRoute`; the route-match test fails CI on any `/v1` route outside the registry |
| Rate limits per process under several replicas | Postgres-backed store behind `MULTI_REPLICA`, the same switch the other shared limiters use |
| MCP tools outrun the gates | Tools only call `/agent/v1` code paths; gated capabilities can only create proposals; the kill switch is read on every call |
| A second tenant before step 0 | Step 0 is first and small |

## 11. Owner decisions

1. **A new `/v1` beside `/integrations/v1`**, which stays frozen for the ASN bridge and is retired once ASN moves. Recommendation: yes.
2. **OAuth client credentials with 15-minute tokens for `/v1`; no new static `altop_` keys after `/v1` ships** (existing ones keep working on `/integrations/v1`). Recommendation: yes.
3. **Public writes are allowed**, reversing Phase 93's "writes stay on the session API", because each write is audited under a registered client with a named human owner. Recommendation: yes.
4. **Pay rates leave `/v1` by default**, available only under a `pay:read` scope a tenant admin grants explicitly; **clock-in coordinates never leave**. Recommendation: yes.
5. **Documents expose kind, status and dates only**; I-9, E-Verify, W-4 and SSN-card kinds are not listed at all; no filenames, no file access. Recommendation: yes.
6. **Programs expose type, sponsor and dates only**; never SEVIS, DS-2019, visa or passport numbers. Recommendation: yes.
7. **"Workers" means the Worker model: people, agents and robots**, matching the hybrid-workforce positioning; personal contact fields only under `workers:contact`. Recommendation: yes.
8. **Webhook signature v2 with a timestamp**, the old header kept 90 days. Recommendation: yes.
9. **Webhook secrets encrypted at rest with their own key**, not the payout key. Recommendation: yes, in step 5 (the key rotation runbook itself belongs to 2-5).
10. **Idempotency-Key required on every `/v1` POST.** Recommendation: yes.
11. **Rate limits: 600/min per client, 3,000/min per tenant**, plan-based limits later with billing (2-6). Recommendation: yes.
12. **Spec generator: `@asteasolutions/zod-to-openapi` with a `defineRoute` helper**; `/integrations/v1` keeps its hand-written document. Recommendation: yes.
13. **MCP over HTTP in the API plus a stdio package, agent credentials only.** Recommendation: yes.
14. **Sequencing:** step 0 now; 2-4 steps 1 to 6 after agent-families step 0, because the agent-registry resource and the approval webhooks read its capability and proposal records; 2-7 last. Recommendation: yes.

## 12. Acceptance mapping

| Acceptance | How it is shown |
|---|---|
| 2-4: a sample script creates a worker, schedules a shift and receives the webhook | `scripts/sample-integration.ts` against a deployed tenant, and the same flow as an API test in CI with a capturing sender |
| 2-4: the OpenAPI spec validates and matches every live endpoint | the validator test and the `listRoutes()` ↔ spec test, both directions |
| 2-7: an external agent connects, reads a week, proposes a fill that lands in the queue, is refused after revocation | the sample agent script and its CI twin |
| 2-7: every tool call on the trail with the scope and the approval | an AuditLog assertion per tool call in the same test |
