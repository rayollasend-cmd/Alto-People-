# Brief 2-6 investigation: the agent registry as a product, and billing

Investigation only (2026-10-13). No code, no schema. It builds on the agent families report (`docs/agent-families-investigation.md`): the owner's seven decisions in §6 and the step 0 design in §8 (AgentCapability, AgentProposal, per-tenant built-ins, AgentTenantControl).

## 1. Summary

1. **Most of "register and govern an agent" already exists, for one tenant.** 1D-2 and 1D-3 give an admin with `manage:org` a registry: profile, owner, scopes, spend cap, hours, credentials, approval queue, kill switch, certification, scorecard and drift (§2). Step 0 adds capabilities, proposals and the per-tenant switch. What 2-6 adds is **the customer's own control**: its agents isolated from every other tenant's, its own approval gates on top of ours, and the compliance record for automated decisions about people.
2. **The compliance target moved this year.** New York City's Local Law 144 is in force: an independent bias audit within one year before use, a published summary, and notice to candidates 10 business days ahead. Colorado's SB 24-205 never took effect. It was delayed to 2026-06-30, then **repealed and reenacted by SB 26-189 (signed 2026-05-14)** as a narrower automated-decision-making regime with duties from 2027-01-01. The record we keep has to serve both, and counsel has to sign off before we claim compliance (§5).
3. **Nothing in the product is an automated employment decision tool today.** Interview scores are human, autofill broadcasts to everyone eligible, and every agent action on a person is behind a human approval. The record matters the moment a customer registers a screening agent, or our own `shift.fill` proposes a named person (§5.3).
4. **Billing has nothing to stand on yet.** There is no Stripe code. The billing page is a stub, and the active rule counts people only. The billable count must come from `lib/activeDefinition.ts` (the owner's one rule), extended to agents and robots, and snapshotted daily so an invoice can be traced to the worker counts the acceptance asks for.
5. **Recommendation:** six steps after agent-families step 0, about five weeks: registry isolation, customer gates, the decision record, usage and invoices in Stripe test mode, the customer-success basics, then acceptance. Eleven owner decisions in §8; prices, the billable-month rule and the agent/robot active rule come first, because billing cannot be built without them.

## 2. What exists

| Piece | Where | State for 2-6 |
|---|---|---|
| Worker (PERSON, AGENT, ROBOT; owner required; ONBOARDING, ACTIVE, SUSPENDED, OFFBOARDED) | `prisma/schema.prisma:9774`, enums `:9761`, `:9767` | Ready: the billing types are the Worker types |
| AgentProfile (purpose, vendor, model and version, scopes, spend cap, rate limit, hours, family, capability, `builtInKey @unique`, certification, suspension, drift) | `schema.prisma:9856` | Ready; step 0 makes `builtInKey` unique per tenant |
| Registry routes: list, create, update, credentials, spend, suspend and resume, scenarios, certify, scorecard, drift | `routes/agents.ts:40–268` (`view:org` to read, `manage:org` to write) | A customer admin can already register an agent. **`listAgents` (`lib/agents.ts:332`) and the approval count are not tenant-filtered.** |
| Approval queue (four fixed actions: PAY_CHANGE, SEPARATION, CLIENT_MESSAGE, DATA_EXPORT; 72-hour TTL; the owner is notified) | `lib/agents.ts:608` `createApprovalRequest`, `:648` `decideApproval`, `:665` `claimApproval`; enum `schema.prisma` AgentGatedAction | Gates are a fixed enum the agent asks for. No per-tenant policy decides what needs approval. |
| Kill switch (one agent, all agents) | `lib/agentControls.ts:61–98`; `AgentControl` singleton `schema.prisma:9972` | Step 0 adds `AgentTenantControl` |
| Audit trail, append-only at the database | trigger `audit_log_immutable`, `migrations/20261107090000_agent_registry/migration.sql:95` | The pattern to reuse for decision records |
| Active rule (people only: employed, placed, worked in the window or scheduled) | `lib/activeDefinition.ts:164` `activeAssociateIds`, `:194` `activeBreakdown` (takes `tenantId` since 7904aff8) | Counts persons. **No rule for agents or robots.** |
| Tenant (`plan` default "internal", `status`, `features`) | `schema.prisma:10170` | No billing fields (Stripe customer, billing contact) |
| Per-tenant jobs | `lib/tenantJobs.ts:49` `runForEachTenant`, `:71` `tenantJob` | Ready for a daily usage snapshot |
| Billing page | `apps/web/src/pages/admin/BillingHome.tsx` ("Stripe integration is deferred… every interactive control is intentionally a stub") | Stub. **Its nav entry is gated on the `billRates` module (`apps/web/src/lib/modules.ts:406`)**, which means a hotel tenant with bill rates off cannot see its own subscription billing. |
| Stripe | none (the only mention is a comment, "Stripe-style", in `middleware/idempotency.ts:11`) | Not started. The idempotency middleware is ready for invoice writes. |
| Client statements (Alto bills its clients for labor) | `ClientStatement` `schema.prisma:1497` | A different thing: the tenant billing its customers, not Alto People billing the tenant. Not reused. |
| Release notes | `ReleaseNote` `schema.prisma:9121`, `routes/releaseNotes.ts` (`manage:org` writes), the WhatsNew card | Exists, but rows are tenant-scoped. There is no platform-authored note every tenant sees. |
| Help center | `/help-center` knowledge base with article feedback (`KbFeedback` `schema.prisma:7751`) | The tenant's own knowledge base for its employees. **No way to ask Alto People for support from inside the app.** |
| Status page | none (`/reliability` is an internal page) | Not started |

## 3. Gaps

1. **Registry isolation.** The agent list, the pending-approval count and the worker list read every tenant. The cross-tenant baseline did not flag them because the suite seeds no agents for tenant one. Explicit tenant filters are needed before a second customer registers an agent.
2. **Customer-defined gates.** The approval requirement is the agent's request plus four fixed actions. A tenant cannot say "every SHIFT_ASSIGN by this agent needs the site manager", "this agent may message clients without approval", or "approvals expire after 24 hours".
3. **Automated-decision records.** No model records the decision type, the person affected, the human reviewer, the notice given, the bias audit in force, the explanation sent after an adverse outcome, or a request for human review.
4. **Active agents and robots.** The billable count for AGENT and ROBOT has no rule.
5. **Usage and invoices.** No usage snapshot, no invoice, no Stripe customer, no billing contact.
6. **Support, status and platform release notes.** Each is missing (§2).
7. **The billing page's module gate** hides it from tenants with bill rates off.

## 4. Design

### 4.1 The registry as the customer's

- Every registry read and write is filtered on the tenant: `listAgents`, `listApprovals`, the pending count, `listWorkers({ type: 'AGENT' })` and the scenario and spend reads. The cross-tenant suite gets an agent fixture for tenant one, so a regression shows as a leak.
- A customer registers its own agent through the existing form, now with the family and capability pickers from step 0's catalog plus **"Custom"** for an agent outside the catalog. A custom agent gets scopes only, no catalog capability. Its gated actions come from the tenant's gates (§4.2).
- Ownership stays as 1D-1 has it: a named owner, the database refuses null, and only the owner resumes a suspended agent.

### 4.2 Customer-defined gates

`AgentGatePolicy`: `tenantId`, `scope` (TENANT, FAMILY, CAPABILITY or AGENT, with its key or id), `action` (an AgentGatedAction or a capability key), `requirement` (REQUIRED or NOT_REQUIRED), `approver` (OWNER, ROLE with a role, DESK meaning the subject's desk per the handoff spine, or USER), `ttlHours` (1–168), `createdById`, effective dates, and an audit row on every change.

The **resolver**, `gateFor(agent, action, subject)`, reads the most specific policy, with AGENT beating CAPABILITY beating FAMILY beating TENANT, over the platform floor. **The floor cannot be lowered.** PAY_CHANGE and SEPARATION stay human-only. Every action on a person that is tagged as a decision about employment (§5) is REQUIRED. A tenant can add a requirement or narrow the approver, never remove a floor requirement. `createApprovalRequest` and step 0's `/agent/v1/proposals` call the resolver. The decided approver gets the desk item in place of today's owner-only notice.

The Agents page gains a **Gates** tab: one table of the tenant's policies, each with its scope, action, approver and expiry, plus a "what would happen" preview for an agent and action.

### 4.3 The automated-decision record

| Model | Fields | Notes |
|---|---|---|
| `AgentDecisionProfile` | per agent capability: `decisionTypes` (SCREENING, HIRING, PROMOTION, SCHEDULING, COMPENSATION, DISCIPLINE, TERMINATION, OTHER), `jurisdictions` (NYC_LL144, CO_ADMT), `assesses` (the qualifications or characteristics the tool evaluates, for the NYC notice), `dataSources`, `retentionPolicy`, `humanReview` (ALWAYS or ON_REQUEST) | Set when the agent is registered. A catalog capability ships with defaults. |
| `AgentBiasAudit` | `workerId`, `auditorName`, `independenceAttested` (bool + text), `conductedAt`, `validUntil` (conductedAt + 1 year), `distributionDate`, `summaryUrl`, `results` JSON (selection or scoring rates and impact ratios by sex, race/ethnicity and intersectional categories), `dataKind` (HISTORICAL or TEST, with a reason when TEST) | What LL144 asks of the audit and its published summary (§5.1) |
| `AutomatedDecisionRecord` (append-only, the same trigger pattern as AuditLog) | `tenantId`, `workerId`, `capabilityKey`, `decisionType`, `subjectAssociateId` (or an applicant id), `jurisdictionTags`, `proposalId`/`approvalId`, `humanReviewerId`, `humanDecidedAt`, `outcome` (FAVORABLE, ADVERSE, NONE), `noticeGivenAt`, `noticeChannel`, `noticeTextVersion`, `auditId` (the AgentBiasAudit in force), `explanationSentAt` (Colorado: 30 days after an adverse outcome), `reviewRequestedAt`/`reviewResolvedAt`, `dataRequestAt`/`dataSentAt` (NYC: 30 days; Colorado: access and correction) | One row per decision about a person. Corrections append a new row that points to the old one. Kept at least 3 years (Colorado), longer if counsel says so. |

**Compliance hold.** A capability tagged SCREENING, HIRING or PROMOTION for a position in New York City cannot run when no bias audit is in force, or when notice went out fewer than 10 business days ago. The gate refuses with `compliance_hold`, names what is missing, and links to the record page.

**Notices** reuse the communications rails (email layout, EN/ES/TR) with a versioned notice text per profile. The NYC notice states that a tool is used, what it assesses, and how to request an alternative process or accommodation. The Colorado notice is given at the point of interaction, plus the adverse-outcome explanation.

**Where it shows.** A **Compliance record** tab on each agent lists its decisions, the audit in force with an expiry warning at 30 days, and the notices sent, with a CSV export. The acceptance line, "the test tenant… sees the compliance record", is this tab.

### 4.4 Billing

**The billable count** comes from the one active rule, extended in `lib/activeDefinition.ts` and not anywhere else (decision 2):
- PERSON: today's rule, `activeAssociateIds({ tenantId })`.
- AGENT: a Worker of type AGENT, status ACTIVE, with at least one audited action in the day (`AuditLog.workerId`, already written for every agent call).
- ROBOT: a Worker of type ROBOT, status ACTIVE, with an open `WorkerAssignment` at a site or an assigned shift that day. Robots arrive in 3-1, so the rule ships now and counts zero until then.

**Usage.** A daily job, `tenantJob('usageSnapshot')`, writes `UsageSnapshot` rows: `tenantId`, `day`, `type`, `count`, and `workerIds` (an array kept as evidence and never sent to Stripe). It runs at the org's day end and is idempotent per tenant, day and type. The monthly `UsageRecord` holds `tenantId`, `month`, `type`, `billableCount` (decision 1: distinct workers active on at least one day of the month), `evidenceHash` and `computedAt`.

**Invoices.** `BillingInvoice` holds `tenantId`, `month`, the lines (`type`, `quantity`, `unitPriceCents` from the tenant's plan, `amountCents`), `status` (DRAFT, OPEN, PAID, VOID), `stripeInvoiceId` and `hostedUrl`. It is unique per tenant and month and written through the idempotency key. The Stripe adapter sends **counts and prices only** (one Stripe customer per tenant, invoice items, finalize), never a worker's name or id. It runs in test mode (`STRIPE_SECRET_KEY` = `sk_test_…`) until the owner switches. The webhook (`invoice.paid`, `invoice.payment_failed`) is signature-checked and mounted before `express.json`, like the WhatsApp webhook. The `internal` plan (Alto HR) is never invoiced.

**The billing page** (`/admin/billing`) shows the plan, this month's running counts by type with a link to the daily snapshot, the invoices with their hosted links, the billing contact and the payment method from Stripe. It is visible with `manage:org` or the Finance role. The nav gate moves off `billRates` to always-on for those roles.

### 4.5 Customer-success basics

- **Support requests:** an in-app "Contact Alto People support" form in the help menu writes a `SupportRequest` (tenant, requester, category, subject, body, page URL, app version, status). It notifies the platform inbox, which is Alto staff under the audited platform scope, by email. The requester sees status updates in the bell. No worker PII is attached automatically.
- **Status page:** `STATUS_PAGE_URL` (env) is linked from the help menu and the sign-in page. The page itself is a hosted provider (decision 9). `/reliability` stays internal.
- **Release notes:** a note with `tenantId` null is platform-authored and shown to every tenant, written by Alto staff under the platform scope. Tenant notes stay as today. The WhatsNew card reads both, newest first.

## 5. The law, as of 2026-10-13 (to confirm with counsel)

### 5.1 New York City, Local Law 144 of 2021 (automated employment decision tools)

- **Scope.** An AEDT is a computer-based tool that uses machine learning, statistical modeling, data analytics or AI, helps make employment decisions, and substantially assists or replaces discretionary decision-making. "Employment decision" includes screening. It applies to a job located in a New York City office, at least part time, or a remote job tied to one ([DCWP FAQ, 2023-06-29](https://www.nyc.gov/assets/dca/downloads/pdf/about/DCWP-AEDT-FAQ.pdf)).
- **Dates.** In effect since 2023-01-01. DCWP enforcement began 2023-07-05 ([DCWP AEDT page](https://www.nyc.gov/site/dca/about/automated-employment-decision-tools.page)).
- **Bias audit.** An audit by an independent auditor no more than one year before use. It is the employer's responsibility, though a vendor may commission one. It must include selection or scoring rates and impact ratios by sex, race/ethnicity and intersectional categories. Test data is allowed only when historical data is insufficient (DCWP FAQ).
- **Publish.** A summary of the latest audit and the tool's distribution date go on the employment section of the website.
- **Notice.** NYC-resident candidates and employees are told that a tool is used and what qualifications or characteristics it assesses, with instructions to request an accommodation. Notice is given 10 business days before use, in the job posting, by mail or email, or on the careers page for applicants (DCWP FAQ).
- **Data request.** The type of data, its source and the retention policy must be on the website or provided within 30 days of a written request; this is from the rule text as quoted in DCWP's published comment record, not a page opened here, so it is to confirm with counsel.
- **Penalties:** per violation under the Administrative Code. The amounts are to confirm with counsel, since the DCWP pages opened do not state them.

### 5.2 Colorado

- **SB 24-205** (the Colorado AI Act) would have applied from 2026-02-01. **SB 25B-004**, approved by the Governor 2025-08-28, moved its requirements to 2026-06-30 ([leg.colorado.gov/bills/sb25b-004](https://leg.colorado.gov/bills/sb25b-004)).
- **SB 26-189**, signed 2026-05-14 (2026 session laws ch. 131), **repeals and reenacts** those provisions as an automated decision-making technology (ADMT) law. Employment is a "consequential decision", including access to, eligibility for or compensation related to employment. Deployer duties ([leg.colorado.gov/bills/sb26-189](https://leg.colorado.gov/bills/sb26-189)):
    - clear and conspicuous notice at the point of interaction;
    - within 30 days of an adverse outcome, a plain-language description of the ADMT's role;
    - on request, the personal data used, with correction of factual errors;
    - meaningful human review and reconsideration on request;
    - records sufficient to show compliance, kept at least 3 years.
- Developer documentation is due from 2027-01-01, and the Attorney General must adopt the adverse-outcome disclosure rules by the same date. Enforcement is by the Attorney General, with a 60-day cure period before 2030-01-01.
- Secondary sources report a federal court pause of SB 24-205 enforcement on 2026-04-27. **Not confirmed on an official page: to confirm with counsel.**

### 5.3 What this means for us

- **We are the developer and the customer is the deployer**, under both laws. Our catalog capabilities ship with the developer documentation Colorado will require from 2027-01-01 (intended use, data categories, limitations, human review) on each capability's page.
- **Our own capabilities.** `shift.fill`, `schedule.repair` and `attendance.confirm` propose who works a shift, and a human approves each one. Whether shift assignment is "compensation related to employment" (Colorado), or screening (NYC), is a question for counsel. The design records them as SCHEDULING decisions either way (decision 7).
- **Customer-registered agents** that screen, hire or promote are the clear case. That is why the compliance hold exists.

## 6. Plan

| Step | Content | Size |
|---|---|---|
| 0 | Agent families step 0 (the §8 design in the families report), prerequisite | 1 week, already planned |
| 1. Registry isolation | Tenant filters on every registry read and write; agent fixtures in the cross-tenant suite; capability and family pickers plus "Custom" on the register form | 2 days |
| 2. Customer gates | `AgentGatePolicy`, the resolver over the floor, the desk item to the chosen approver, the Gates tab and its preview; tests: floor not lowerable, most-specific-wins, cross-tenant | 1 week |
| 3. Decision record | `AgentDecisionProfile`, `AgentBiasAudit`, append-only `AutomatedDecisionRecord`, the compliance hold, notices EN/ES/TR, adverse explanation, review and data requests, the record tab and CSV | 1.5 weeks |
| 4. Usage and invoices | The agent and robot active rule in `activeDefinition.ts`, the daily snapshot, monthly usage, `BillingInvoice`, the Stripe test-mode adapter and webhook, the billing page and its gate | 1.5 weeks |
| 5. Customer success | `SupportRequest` and the platform inbox, the status link, platform release notes | 3 days |
| 6. Acceptance | The test tenant registers an agent, sets a gate, a tagged decision produces a record it can see; a month of snapshots produces an invoice whose lines equal the distinct-active counts by type | 2 days |

## 7. Risks

| Risk | Handling |
|---|---|
| A billing count that disagrees with Headcount | One rule (`activeDefinition.ts`); the invoice stores its evidence hash and the snapshot holds the ids, and a test recomputes the month from the snapshots |
| Double billing or the wrong tenant billed | Usage written per tenant inside `runWithTenant`; invoice unique per tenant and month; the cross-tenant suite covers `/admin/billing` |
| Worker PII leaving for Stripe | Counts and prices only, enforced by the adapter's types and a test that inspects the payload |
| Claiming legal compliance | The product says "records to support your NYC LL144 and Colorado ADMT obligations"; counsel reviews notice texts and record fields before any customer sees them |
| A customer lowering our safety floor | The resolver can only add requirements; a test tries to waive PAY_CHANGE and is refused |
| Live charges in test | Test-mode key only; switching to live is an owner action with a written runbook |
| Real second tenants need per-tenant settings | Invoices need the tenant's legal name and billing contact. Those go on Tenant now (`billingName`, `billingEmail`, `stripeCustomerId`, nullable), independent of 2-1's Migration C. |

## 8. Owner decisions

1. **What is a billable month?** Recommendation: distinct workers active on at least one day of the month, by type, from daily snapshots. Alternatives are the month's peak day and a month-end snapshot.
2. **Active agents and robots, added to `lib/activeDefinition.ts`.** Recommendation: an agent with status ACTIVE and at least one audited action that day; a robot with status ACTIVE and on a site or an assigned shift that day.
3. **Prices.** Per person, per agent and per robot per month, by plan. I need the numbers. Recommendation: Alto HR's `internal` plan is never invoiced.
4. **Stripe shape.** Recommendation: we compute usage and send Stripe invoice items with quantities (Stripe collects), rather than Stripe usage meters. Test mode until you approve live. You confirm the Stripe account to use.
5. **Customer gates only add.** Recommendation: yes. PAY_CHANGE and SEPARATION stay human-only, and every tagged decision about a person needs a human.
6. **The decision record's scope.** Recommendation: a record for every agent action on a person whose capability carries a decision type; jurisdiction tags NYC_LL144 and CO_ADMT; the compliance hold for screening, hiring and promotion in NYC; counsel reviews the texts and fields before release.
7. **Our scheduling capabilities.** Recommendation: record them as SCHEDULING decisions and ask counsel whether Colorado's "compensation related to employment" reaches shift assignment.
8. **Support requests.** Recommendation: the in-app form to a platform inbox plus email, rather than a third-party helpdesk for now.
9. **Status page.** Recommendation: a hosted status page linked through `STATUS_PAGE_URL`. Which provider is your call.
10. **Release notes.** Recommendation: platform-authored notes for every tenant (`tenantId` null), plus tenant notes as today.
11. **Who sees billing.** Recommendation: `manage:org` and the Finance role; the nav entry no longer depends on the bill-rates module.

## 9. Acceptance mapping

| Acceptance line | Where it is proved |
|---|---|
| The test tenant registers an agent | Step 1: tenant two's admin registers a Custom agent; tenant one's list does not show it (cross-tenant suite) |
| …sets a gate | Step 2: tenant two adds a REQUIRED policy for its agent's action; the agent's call files an approval to the chosen approver |
| …and sees the compliance record | Step 3: a tagged decision approved by a human produces an `AutomatedDecisionRecord` on the agent's Compliance record tab, with the notice and audit in force |
| An invoice is generated from usage and matches the worker counts | Steps 4 and 6: a seeded month of snapshots gives a `BillingInvoice` (and a Stripe test invoice) whose quantities equal the distinct active PERSON, AGENT and ROBOT counts recomputed from `activeDefinition.ts` |

Sources opened 2026-10-13: [NYC DCWP AEDT page](https://www.nyc.gov/site/dca/about/automated-employment-decision-tools.page); [DCWP AEDT FAQ (2023-06-29)](https://www.nyc.gov/assets/dca/downloads/pdf/about/DCWP-AEDT-FAQ.pdf); [Colorado SB25B-004](https://leg.colorado.gov/bills/sb25b-004); [Colorado SB26-189](https://leg.colorado.gov/bills/sb26-189).

## Owner approval

**Approved 2026-10-13: every decision in this report, as recommended.** Building proceeds step by step in the order of the plan; each step lands with its tests and is reported before the next.
