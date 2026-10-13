# Agent families investigation: Workforce and Compliance, orchestrated by Hugo

Investigation only (2026-10-13). No code, no schema. It precedes the next item in the owner's order after Brief 2-1b: the first two agent families from the product taxonomy, on the registry (1D-2) and its controls (1D-3).

## 1. Summary

1. **Alto People already runs eleven automations that are agents in all but name.** Open-shift broadcast, no-show risk, stale-application nudges, expiration digests, document maintenance, attestation reminders, I-9 Section 2 deadlines in the decision queue, OSHA incident closure, E-Verify readiness, the compliance snapshot. Each is a timed sweep under `tenantJob()` or a decision-queue item under `lib/roleDecisions.ts`, with a `notifyUser` at the end and no registry record, no scorecard, no scenarios and no kill switch.
2. **The families are a governance wrapper first, new behaviour second.** The first release of each family registers those sweeps as capabilities of one agent per family, gives each capability a scope, a gate, a scorecard and a certification scenario, and routes it through Hugo's queue. The behaviour change is small and deliberate: the Workforce agent proposes (a fill, a backup, a confirmation text) instead of only broadcasting; the Compliance agent chases (a document, a Section 2, an incident) instead of only listing.
3. **The registry needs five additions before a family can stand on it:** capability-level scopes and gates (today scopes are per agent and only four actions are gated); a proposal action type for shift assignment and case opening (Brief 2-7 asks for exactly this); per-tenant built-in records and a per-tenant kill switch (today both are platform singletons); scorecard metrics per capability; and scenarios that run against fixtures, not only against the in-process WhatsApp assistant.
4. **Hugo is the one front door.** Every family capability is reachable three ways, all logged under the capability: on a timer (the sweep), on request (a person asks Hugo in the app or on WhatsApp), and on a desk's queue (the decision item). Hugo routes an intent to the capability, refuses a capability whose module is off, names the accountable owner on the item, and hands the result to the right desk by the handoff-spine anatomy (event → queue → deep link → attributed action → closure).
5. **Recommendation:** ship Workforce first (four capabilities, three weeks), Compliance second (four capabilities, two weeks), with one registry step in front of both (one week). Seven owner decisions in §6.

## 2. What exists

### 2.1 The registry and its controls (1D-2, 1D-3)

| Piece | Where | State |
|---|---|---|
| Agent record = Worker AGENT + AgentProfile (purpose, vendor, model, version, environment, scopes, spend cap, rate limit, hours, family, capability, builtInKey) | `prisma/schema.prisma` (Worker, AgentProfile), `lib/agents.ts` | Done; `family`/`capability` are one string each per agent |
| Credentials `alto_agent_…`, rotation with grace, revoke | `lib/agents.ts`, `middleware/agentAuth.ts` | Done; the agent's tenant becomes the request's tenant (`runWithTenant`) |
| Scopes | `AGENT_SCOPES` in `packages/shared/src/contracts.ts` | Seven read scopes + write messages. No scheduling write, no case write, no compliance write |
| Gated actions | `AgentGatedActionSchema`: PAY_CHANGE, SEPARATION, CLIENT_MESSAGE, DATA_EXPORT | Two executable by the agent after approval, two human-only. No SHIFT_ASSIGN, CASE_OPEN or NOTICE_SEND |
| Approval queue | `createApprovalRequest`, `decideApproval`, `claimApproval`, 72 h TTL, `/agents` page | Done; the request notifies the agent's owner |
| Audit trail | AuditLog by `workerId`, append-only trigger | Done |
| Kill switch | `suspendAgent` (owner resumes), `suspendAllAgents` on `AgentControl id='singleton'` | Done, but the global switch is one row for the platform, not one per tenant |
| Certification | `AgentScenario` + runs; `runBuiltIn` answers scenarios for the WhatsApp assistant in process; external agents answer through `/agent/v1/certification` | Done for one built-in; a new family's capabilities have no runner |
| Scorecard | `scorecard()`: tasks, errors, escalations, approvals requested/rejected, spend, cost per task, over 7 days | Done per agent, not per capability |
| Drift | `sweepAgentDrift` every 6 h, thresholds per agent, owner notified | Done |
| Built-ins at boot | `BUILT_IN_AGENTS`: deployment workflow, boardroom, Hugo on WhatsApp | `builtInKey` is `@unique` → one record platform-wide, owned by the oldest org admin |
| Agent API | `/agent/v1`: me, rotate, spend, schedule, executive summary, messages (gated to clients), schedule.csv (gated), requests, certification | Read-mostly |

### 2.2 Hugo today

`lib/whatsappAssistant.ts`: eight intents by regex (OPT_OUT, OPT_IN, LANGUAGE, WHO, PAYDAY, RIDE, SCHEDULE, HANDOFF). RIDE becomes HANDOFF when `transportation` is off (Brief 2-1b). Every reply is logged under the `whatsapp-assistant` record. The handoff opens a message thread with the first supervisor at the associate's store. Hugo answers only associates, only on WhatsApp, only from their own records. He has no presence in the app for managers, no notion of a capability, and no routing beyond the switch statement.

### 2.3 The sweeps that are the families' first capabilities

Workforce (all under `tenantJob`, module `scheduling` unless noted):

| Today | File | What it does | What it lacks |
|---|---|---|---|
| Open-shift broadcast | `lib/shiftAutofill.ts` | Every published OPEN shift within 48 h is offered once to the bench placed at that client, one-tap pickup link; the supervisor's queue item stays only for unfilled shifts | Client-less shifts get no autofill (the comment says placement by site is pending); no proposal of a named fill; no record of fill rate |
| No-show risk | `lib/noShowRisk.ts` | Tomorrow's assigned shifts held by a 2.5+ point attendee → one digest per supervisor with backups | Suggests "a confirmation text"; sends none; no outcome tracking |
| Coverage alert (portal) | `lib/portalCoverageAlert.ts`, module `clientPortal` | Store short against target → portal alert | Client portal only |
| Week-ahead and schedule digests | `lib/weekAheadDigest.ts`, `lib/scheduleDigest.ts` | Summaries to supervisors and associates | Informational |
| Time-off vs coverage | `notifyCoverageImpact` in the time-off approve path | Warns WFM and supervisors of overlaps | Reactive, no repair |
| Rebalance strip | `workforceOverview` | Next-3-day short stores vs bench, org-wide | Read-only |
| Ready to schedule / ready to work | `lib/readyToWork.ts`, module `clientPortal`; `workforceOverview.readyToSchedule` | Approved hires with no upcoming shift | Nudge only on the portal path |

Compliance (module `compliance` unless noted):

| Today | File | What it does | What it lacks |
|---|---|---|---|
| Expiration digest | `lib/expirationDigest.ts` | Daily: everything expiring within 30 days to admins; agreements sweep | Pushes a list; chases nobody |
| Document maintenance | `lib/documentMaintenance.ts` | Expires lapsed documents, purges rejected blobs after 30 days | Housekeeping |
| Attestation reminders | `lib/attestationReminder.ts` | Reminds on due attestations | Reminder only |
| I-9 Section 2 | `lib/roleDecisions.ts:335`, `lib/everifyReadiness.ts` | Decision item "N Section 2 verifications pending, federal deadline 3 business days"; E-Verify queue says why a case cannot open | A queue item, not a chase; no deadline-ordered worklist pushed to the verifier |
| OSHA incident loop | `routes/oshaWcEeo.ts` + handoff seam 3 | Resolve notifies the reporter once; dashboard counts open incidents | No ageing, no chase of the open ones |
| Vaccination / certification coverage | the compliance scorecard tiles, `routes/complianceScorecard.ts` | Coverage % per kind, expiring-soon | Pull only |
| Compliance snapshot | `lib/complianceSnapshot.ts` | Daily score per scope for trend and executive alerts | The memory a scorecard needs; keep |
| Stale-application nudge | `lib/staleNudge.ts` | Chases stalled onboarding with a cooldown and a cap | Onboarding, shared with Workforce |

### 2.4 Queues and handoffs

`lib/roleDecisions.ts` generates "needs your decision" items per capability holder, clamped by scope, auto-clearing when the condition resolves. The relay board (`lib/relayBoard.ts`) and `lib/relayEscalation.ts` are the structural layer: lanes, batons, one bell per overdue baton per org-day to the holding desk. The handoff spine's rule: a new cross-role moment is a lane stage or a baton, never a new dashboard card and never a `notifyAllAdmins`.

## 3. Gaps

1. **Capability is a label, not a unit.** `AgentProfile.capability` is one string. Scopes, gates, scorecards and scenarios attach to the agent. The taxonomy says every capability has its own scopes, gates and scorecard; Brief 2-7 maps each tool to a capability "with its own scopes, approval gate and scorecard".
2. **No write scopes and no proposal gate.** An agent cannot propose a shift assignment, open a case, send a notice to an associate or chase a document. The gated list is money, separation, client messages and exports. A Workforce agent that only reads is a report.
3. **Platform singletons.** `builtInKey @unique` gives one Hugo record for every tenant; `AgentControl id='singleton'` is one "suspend all" for the platform; `defaultOrgOwner` is the oldest admin anywhere. Brief 2-6 wants a tenant-scoped registry; 2-1b already runs crons per tenant.
4. **Scenarios need fixtures.** `runBuiltIn` can answer for the WhatsApp assistant only because its inputs are a text and a language. A Workforce capability's scenario is "given this schedule and this bench, propose this fill". The runner needs a fixture loader and an allowed-actions check, which `evaluateScenario` already half has (`expected` allows actions).
5. **Hugo has no intent registry.** Intents are regexes in one file; capabilities are not discoverable; a manager cannot ask Hugo anything. The taxonomy's rule "a capability that depends on a disabled module is not offered" is implemented for RIDE only.
6. **Outcomes are not recorded.** The sweeps notify and forget. A scorecard needs "fill proposed → accepted/rejected → shift covered", "document chased → uploaded by the deadline", "Section 2 chased → completed in time". Nothing stores the proposal, so nothing can score it.
7. **Client-less shifts have no autofill.** `shiftAutofill` benches by client; a direct employer's bench is by site (Brief 2-1b step 5 landed `siteFilter`, the autofill was not re-pointed).

## 4. Design

### 4.1 The capability as the unit

A `AgentCapability` row per (agent, capability key): key from a shared catalog (`AGENT_CAPABILITIES`), family, `requiresModule`, scopes, the gate it files (or none), the scorecard metrics it reports, its scenarios, `enabled`. The agent's effective scopes are the union of its enabled capabilities; `requireAgent(scope)` stays as it is. The Agents page lists capabilities under the agent with each one's own scorecard and kill switch (suspend one capability, not the agent).

Catalog, first release:

| Family | Capability key | Trigger | Does | Gate | Module |
|---|---|---|---|---|---|
| workforce | `shift.fill` | sweep 15 min; on request | For each OPEN shift inside 48 h: broadcast to the bench (as today, by client or by site) and, when nobody picks up within the window, propose one named fill ranked by distance, hours this week, reliability | SHIFT_ASSIGN (new): the supervisor approves in one tap; the agent then assigns, citing the approval | scheduling |
| workforce | `attendance.confirm` | sweep nightly | For tomorrow's high-risk holders: send the confirmation text (WhatsApp if opted in, else in-app), record the answer, propose a backup when the answer is no or silent by a cut-off | NOTICE_SEND to associates is ungated (it is what the shift reminder does today); the backup is SHIFT_ASSIGN | scheduling + time |
| workforce | `coverage.forecast` | sweep daily; on request | Next 7 days per site: demand vs assigned vs bench, with the gaps on the relay board as a baton to WFM; feeds the season planner's actuals | none (read) | scheduling |
| workforce | `schedule.repair` | event: time-off approved, separation, emergency suspension | For every shift the event un-covers: run `shift.fill` immediately, name the overlap on the item | SHIFT_ASSIGN | scheduling |
| compliance | `document.chase` | sweep daily | For each document or authorization expiring within 30 days: notify the person in their language with the upload link, remind at 14 and 3 days, escalate to HR at expiry as a decision item; stop when the document is uploaded | NOTICE_SEND; escalation files a decision, no gate | compliance |
| compliance | `i9.section2` | sweep hourly | For each approved hire: the Section 2 deadline (3 business days from start, org calendar) as a dated worklist to the verifier desk, climbing to HR the day before, with the E-Verify readiness reason | none; a human completes Section 2 | compliance |
| compliance | `incident.loop` | sweep daily | Open OSHA incidents older than N days: chase the owner, propose closure when the reporter has nothing to add, assemble the 300A line | CASE_OPEN (new) when an incident needs an HR case; closure stays human | compliance |
| compliance | `coverage.credentials` | sweep weekly; on request | Vaccination, certification and training coverage per site vs the site's requirement; the gap list to the desk; chase the holders through `document.chase` | none | compliance |

Not in the first release: pay or separation proposals (gated today, stay human-only), anything that writes a client message (stays CLIENT_MESSAGE-gated), recruiting (Talent family), robots.

### 4.2 New gates and scopes

| Addition | Where |
|---|---|
| Gated actions `SHIFT_ASSIGN`, `CASE_OPEN` (both executable once approved) | `AgentGatedActionSchema`, `AGENT_EXECUTABLE_ACTIONS`, `claimApproval` |
| Scopes `manage:scheduling` (assign only through a claimed approval), `manage:hr-cases` (open only), `manage:compliance` (notices and reminders), `view:org` (bench, people) | `AGENT_SCOPES` |
| Approval decided from the desk's own queue, not only from `/agents`: a SHIFT_ASSIGN request is a decision item for the shift's supervisor, with the shift's facts on the row, one-tap approve | `roleDecisions.ts`, the handoff spine |
| An outcome record per proposal: `AgentProposal` (capability, subject, proposed payload, approvalId, outcome: ACCEPTED/REJECTED/EXPIRED/SUPERSEDED, outcomeAt) | new model; the scorecard reads it |

### 4.3 Scorecard per capability

| Capability | Metrics |
|---|---|
| `shift.fill` | shifts seen, broadcast pickup rate, proposals made, approved, filled before start, median time to fill |
| `attendance.confirm` | texts sent, answered, no-shows among confirmed vs unconfirmed, backups accepted |
| `coverage.forecast` | forecast error at 7 and 1 days (assigned vs forecast) |
| `document.chase` | items chased, uploaded before expiry, expired anyway, escalations |
| `i9.section2` | hires, completed in time, late, E-Verify opened in time |
| `incident.loop` | open incidents, median age, closed after chase |
| `coverage.credentials` | sites below requirement, closed gaps |

All on top of the registry's generic tasks, errors, escalations, approvals and cost per task. Drift thresholds per capability, same sweep.

### 4.4 Certification scenarios

A scenario = a fixture (a small seeded world: sites, bench, shifts, documents) + an input + expected output or allowed actions. The runner loads the fixture into a test tenant, runs the capability once with `now` fixed, and compares. Scenarios ship with the capability in the shared catalog; the owner may add tenant-specific ones. A model version change sends the agent back to ONBOARDING as today; a rule-based capability's "model version" is its code version, stamped at build.

### 4.5 Hugo as orchestrator

1. **Intent registry.** `HUGO_INTENTS`: each intent names the capability it routes to, the audiences (associate, manager, admin), the channels (WhatsApp, app), the module it requires, the phrases in EN/ES/TR. The WhatsApp switch becomes a lookup; the app gets a Hugo panel (ask, see what he is doing, see his proposals) under the agents page first, then on the dashboards.
2. **Offer only what is on.** `capabilitiesFor(tenant)` filters by `moduleOn` and by the tenant's enabled capabilities; a disabled capability is absent from Hugo's help text, the MCP catalog and the Agents page, never a 403.
3. **Owner on every item.** Every proposal and decision item names the accountable owner of the capability's agent (the Worker's `ownerUserId`); the owner is the escalation path when the desk does not act.
4. **Desk routing by the handoff spine.** A proposal lands as a decision item on the desk that owns the subject (supervisor for a shift, verifier for Section 2, HR for an expired authorization, Finance never unless payroll), as a baton on the relay board when it has a due date, with a deep link to the record and closure back to the capability (which records the outcome).
5. **Vocabulary.** Hugo's app and WhatsApp text reads the tenant's terminology through `termsIn`, with the forbidden-word test extended to every new reply.
6. **Hugo's own record** stays `associate-self-service`; each family is its own agent (Worker) with Hugo as the router, so a family can be suspended without silencing Hugo.

### 4.6 Tenancy

- Built-ins per tenant: `builtInKey` unique per (tenantId, key); `ensureBuiltInAgents` runs inside `runForEachTenant`; the owner defaults to the tenant's oldest admin.
- Kill switch per tenant: `AgentControl` keyed by tenantId (platform row kept for the operator's "suspend everything").
- Sweeps run under `tenantJob(name, fn, { module })` as today; each sweep becomes a capability run, which logs under the tenant's agent record.
- The approval queue, scorecard and trail are already tenant-filtered by the enforcing read filter (TENANCY_MODE=enforce) and by `tenantId` on the rows.

### 4.7 The hotel vs Alto HR

| | Alto HR (WORKFORCE_PROVIDER) | The Grand Hotel (DIRECT_EMPLOYER) |
|---|---|---|
| Workforce agent | All four capabilities; bench by client; coverage by store and client; backups across the client's stores | All four; bench by site; no client portal alerts; "property manager" on every item |
| Compliance agent | All four; vaccination requirements by client SLA | `document.chase`, `i9.section2`, `incident.loop`; `coverage.credentials` only if the property sets a requirement |
| Hugo | WhatsApp + app; RIDE intent | WhatsApp + app; RIDE absent; no "store", "client", "van", "Alto" in any reply (the existing forbidden-word harness extends to the new intents) |
| Owner | Named per agent, defaulted to the oldest admin | Same, within the hotel's tenant |

## 5. Risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | An agent assigns a shift nobody approved | SHIFT_ASSIGN is executable only through `claimApproval` with the payload hash; the test from 1D-2 ("does nothing until approved") is extended to the new actions before any capability code |
| 2 | Notice fatigue: chases and confirmations on top of today's digests | One agent message per person per day per capability, the `staleNudge` cooldown pattern; the shift reminder and the confirmation text merge into one message |
| 3 | The sweeps double-run (old cron + new capability) | Each sweep is moved, not copied: the cron starter calls the capability runner; one commit per capability with the old test kept green |
| 4 | Scorecard without outcomes | `AgentProposal` lands with the first capability; a capability without an outcome record is not scored and says so |
| 5 | Scenarios that pass on the fixture and fail in a tenant | Scenarios run against a copy of the tenant's own data in the certification step (read-only, in a transaction rolled back) as a second tier, owner-triggered |
| 6 | The global kill switch silences the wrong tenant | Per-tenant control row before the first family runs in the hotel |
| 7 | Hugo offers a capability the tenant turned off | `capabilitiesFor(tenant)` is the only source for help text, MCP catalog and the Agents page; the forbidden-word test gains a "capability off → not mentioned" case |
| 8 | Compliance chases a person about a document a human already waived | The chase reads the same waiver and exemption flags the scorecard reads; a waived item is never chased; a test per exemption kind |

### Workday, and where this surpasses it

Checked against Workday's own pages on 2026-10-13 (sources inline). Workday ships named agents: Recruiting, Expenses, Succession and Optimize ([source](https://newsroom.workday.com/2024-09-17-Workday-Announces-New-AI-Agents-to-Transform-HR-and-Finance-Processes)); Payroll, Contracts, Financial Auditing and Policy ([source](https://newsroom.workday.com/2025-02-11-The-Next-Generation-of-Workforce-Management-is-Here-Workday-Unveils-New-Agent-System-of-Record)); and a Frontline Agent ([source](https://en-gb.newsroom.workday.com/2025-05-19-Workday-Unveils-Next-Generation-of-Illuminate-Agents-to-Transform-HR-and-Finance-Operations)). Its Agent System of Record registers Workday and third-party agents, sets their roles, access and cost, records what they do, and can deactivate an agent ([source](https://www.workday.com/en-us/ai-platform/agent-system-of-record.html), [source](https://doc.workday.com/admin-guide/en-us/workday-ai/agents/setup-considerations--agent-system-of-record.html)). Every action is logged with who approved it ([source](https://newsroom.workday.com/2026-10-13-Workday-Launches-Autopilot-Agents-That-Get-Real-Work-Done-Across-HR,-Finance,-and-IT)). The overlap with 1D-2/1D-3 is real. Where Alto People goes further:

- **Frontline, before the gap.** Workday's Frontline Agent takes absences by text, routes shift swaps and suggests replacements ([source](https://newsroom.workday.com/2026-01-08-Workday-Accelerates-Retail-and-Hospitality-Momentum-with-New-Customer-Wins-and-AI-Innovations-for-the-Frontline)). Ours also texts the at-risk attendee the night before and repairs coverage the moment time off is approved.
- **Seasonal and international.** Our Compliance agent tracks the I-9 Section 2 clock, E-Verify readiness, J-1 and H-2B program dates and site vaccination rules, in the person's language, over WhatsApp. Workday's published agents cover policy answers, payroll compliance and regulatory-change flags; none covers work authorization or visa programs.
- **A named owner and per-capability control.** Each of our agents has an accountable person, one capability can be paused alone, and certification resets when the model version changes. Workday's published material describes approvals and deactivating a whole agent, not these.
- **Hybrid.** The same registry governs people, agents and robots (1D-1 Worker type); Workday's registry covers agents.
- **Vocabulary and modules per tenant.** A direct employer's agents speak its words and never offer a module it has off (Brief 2-1b).

"Not found" above means not in the pages opened, not proof that Workday lacks the feature. Naming: Workday announced a "Trusted Agent Platform" on 2026-10-13 ([source](https://newsroom.workday.com/2026-10-13-Workdays-Trusted-Agent-Platform-Now-Delivers-Headless-Access-to-HR-and-Finance,-Letting-Customers-Build-and-Run-Lawful-AI-Agents)), the same name docs/product-taxonomy.md gives our platform layer; the owner decides whether ours is renamed.

## 6. Owner decisions

**Approved 2026-10-13: all seven, as recommended.** The registry step (§7, step 0) starts when Brief 2-1b closes.

1. **Capability as the unit of governance** (scopes, gate, scorecard, scenarios, kill switch per capability; agent = family). Recommendation: yes; it is what the taxonomy and Brief 2-7 already say.
2. **Two new gated actions, SHIFT_ASSIGN and CASE_OPEN, executable by the agent once approved.** Recommendation: yes; a fill that a supervisor approves in one tap is the whole point. Pay, separation and client messages stay as they are.
3. **The agent may send notices to associates (reminders, confirmations, document chases) without a gate**, under the one-per-day rule, logged. Recommendation: yes; the shift reminder already does this; gating it would bury the queue.
4. **One agent per family, Hugo as the router** (not one agent per capability, not one Hugo that does everything). Recommendation: yes; a family can be suspended without silencing Hugo, and the scorecard reads at family level.
5. **Per-tenant built-ins and kill switch.** Recommendation: yes, in the registry step, before the hotel runs a family.
6. **Scenario fixtures as code in the shared catalog**, with owner-added scenarios per tenant. Recommendation: yes; plus the read-only second tier against tenant data, owner-triggered.
7. **Order: Workforce before Compliance.** Recommendation: yes; Workforce has the outcome loop that proves the scorecard (fill → covered), and Compliance's chases reuse its notice path.

## 7. Plan

| Step | Content | Size |
|---|---|---|
| 0. Registry additions | `AgentCapability` + catalog, two gated actions + scopes, `AgentProposal`, per-tenant built-ins and kill switch, desk-side approval items, fixture-based scenario runner, capability scorecard; the "nothing until approved" test extended first | 1 week |
| 1. Workforce: `shift.fill` | Move `shiftAutofill` under the capability, bench by site for client-less shifts, named proposal after the broadcast window, SHIFT_ASSIGN item on the supervisor's queue, outcome recorded, scenario: "two open shifts, three on the bench, one overlapping → proposes the free one" | 1 week |
| 2. Workforce: `attendance.confirm`, `schedule.repair` | Confirmation text with answer capture; repair hooked to time-off approve, separation and emergency suspension | 1 week |
| 3. Workforce: `coverage.forecast` + Hugo in the app | Forecast baton on the relay board; `HUGO_INTENTS`, the app panel, capabilitiesFor(tenant), forbidden-word cases | 1 week |
| 4. Compliance: `document.chase`, `i9.section2` | Chase ladder with waivers respected; Section 2 worklist with E-Verify readiness; scenarios | 1 week |
| 5. Compliance: `incident.loop`, `coverage.credentials` | Ageing chase, CASE_OPEN, 300A line; coverage vs requirement | 1 week |
| 6. Acceptance | Both agents live in Alto HR for a week with scorecards; the hotel tenant runs both with the forbidden-word harness green; MCP catalog (2-7) generated from the capability catalog as a read-only preview | ½ week |

Acceptance for the brief, proposed: every sweep in §2.3 appears under a capability with an owner, a scope and a scorecard; a fill proposal reaches the supervisor's queue and assigns only after approval; the hotel sees nothing from a module it has off; suspending one capability stops its next run within one sweep interval; a week of scorecard numbers for both agents in Alto HR.

## 8. Step 0 design (registry additions)

Ready to build once Brief 2-1b's CI is green. One migration, additive; no product behaviour changes until a capability is wired in step 1. Everything below lands in `apps/api` and `packages/shared` unless named.

### 8.1 Schema

| Model / field | Shape | Why |
|---|---|---|
| `AgentCapability` (new) | `id uuid`, `workerId uuid → AgentProfile`, `key varchar(60)` (from `AGENT_CAPABILITIES`), `enabled bool default true`, `suspendedAt`, `suspendedById`, `suspendReason`, `driftErrorRatePct int? default 25`, `lastDriftAlertAt`, `createdAt`, `updatedAt`, `tenantId` (the defaulted nullable column, like the other 265 models). Unique `(workerId, key)` | Capability = unit of governance (decision 1): own switch, own drift, scorecard keyed by it |
| Catalog `AGENT_CAPABILITIES` (code, not a table) | `{ key, family, label, requiresModule: TenantModule[], scopes: AgentScope[], gate: AgentGatedAction or null, metrics: string[], scenarios: ScenarioFixture[] }` in `packages/shared/src/agentCapabilities.ts` | Ships with the code; certification compares against it; the MCP catalog (2-7) reads it later |
| `AgentProposal` (new) | `id`, `workerId`, `capabilityKey varchar(60)`, `subjectType varchar(40)` (`Shift`, `HrCase`, `Document`…), `subjectId uuid?`, `payload jsonb`, `approvalId uuid? → AgentApprovalRequest` (unique), `status AgentProposalStatus default PROPOSED`, `statusAt`, `outcome jsonb?` (e.g. `{ filled: true, filledAt }`), `outcomeAt`, `createdAt`, `tenantId` (defaulted nullable). Indexes `(workerId, capabilityKey, createdAt desc)`, `(subjectType, subjectId)` | The outcome record a scorecard needs (gap 6). States: PROPOSED → APPROVED, REJECTED or EXPIRED; APPROVED → EXECUTED or FAILED; PROPOSED → SUPERSEDED when the subject resolves on its own |
| `enum AgentProposalStatus` (new) | `PROPOSED APPROVED REJECTED EXPIRED EXECUTED FAILED SUPERSEDED` | |
| `enum AgentGatedAction` | add `SHIFT_ASSIGN`, `CASE_OPEN` (`ALTER TYPE … ADD VALUE`) | Decision 2 |
| `AgentProfile.builtInKey` | drop the global unique index; add a partial unique `(tenantId, builtInKey) WHERE builtInKey IS NOT NULL`, plus `(builtInKey) WHERE tenantId IS NULL AND builtInKey IS NOT NULL` for the nullable-tenant case | Per-tenant built-ins (decision 5). Code: `findUnique({ builtInKey })` becomes `findFirst({ builtInKey, tenantId })` in `lib/agents.ts` (`builtInAgentId`, `ensureBuiltInAgents`, `listAgents`) |
| `AgentTenantControl` (new) | `tenantId uuid` (unique, not null), `allSuspendedAt`, `suspendedById`, `reason`, `updatedAt` | Per-tenant kill switch (decision 5) without touching the `AgentControl` singleton |

**AgentControl and 2-1 Migration C.** Converting the `AgentControl` singleton is listed in 2-1's Migration C, which the owner sequenced after a clean 1A-1 run. Step 0 therefore does not convert it. The singleton stays as the **platform** switch (the operator's "suspend everything", unchanged code path), and the new `AgentTenantControl` is the tenant's switch. An agent is stopped when either is set. Migration C later folds the two, or keeps both, without a data conflict, because the new table is already keyed by tenant.

### 8.2 Migration `20261121090000_agent_capabilities`

1. `ALTER TYPE "AgentGatedAction" ADD VALUE 'SHIFT_ASSIGN';` and the same for `'CASE_OPEN'`. Postgres 12+ allows this inside the migration transaction as long as the new values are not used in the same transaction; nothing below uses them.
2. `CREATE TYPE "AgentProposalStatus" AS ENUM (…)`.
3. `CREATE TABLE` for `"AgentCapability"`, `"AgentProposal"` and `"AgentTenantControl"`, with FKs (`ON DELETE CASCADE` to `AgentProfile`, `SET NULL` to the approval), the tenantId default `'00000000-0000-4000-8000-000000000001'::uuid`, and the indexes.
4. `DROP INDEX "AgentProfile_builtInKey_key";` then `CREATE UNIQUE INDEX "AgentProfile_tenant_builtInKey_key" ON "AgentProfile"("tenantId","builtInKey") WHERE "builtInKey" IS NOT NULL;` and `CREATE UNIQUE INDEX "AgentProfile_notenant_builtInKey_key" ON "AgentProfile"("builtInKey") WHERE "tenantId" IS NULL AND "builtInKey" IS NOT NULL;` in the same migration, per risk ruling 3.
5. Backfill: `INSERT INTO "AgentTenantControl"("tenantId","allSuspendedAt","suspendedById","reason","updatedAt") SELECT t.id, NULL, NULL, NULL, now() FROM "Tenant" t ON CONFLICT DO NOTHING;` One row per existing tenant; Alto's is unsuspended. No enum literal appears in a SELECT; any added later carries the `'X'::"Enum"` cast.
6. No `AgentCapability` rows in SQL. `ensureBuiltInAgents` creates them at boot from the catalog. The 3 existing agents get none; the two family agents arrive in step 1.

Additive and reversible: three new tables and two enum values. The only replaced object is the builtInKey index, whose new form admits every row the old one did (all current rows are Alto's). Down: drop the three tables and the type, recreate the old index. Postgres cannot drop enum values, which is harmless because nothing references them until step 1.

### 8.3 Contracts (`packages/shared`)

| Addition | Detail |
|---|---|
| `AgentGatedActionSchema` | adds `SHIFT_ASSIGN` and `CASE_OPEN`; `AGENT_EXECUTABLE_ACTIONS` adds both (the agent executes after a human approves); labels in `AGENT_GATED_ACTION_LABELS` |
| `AGENT_SCOPES` | adds `view:org` (read people and sites), `manage:scheduling` (assign shifts, through an approval), `manage:compliance` (send compliance reminders), and `open:hr-case` (open HR cases, through an approval). The last is agent-only, because HR case staff routes gate on role rather than a capability; see the question below |
| `AGENT_CAPABILITIES` (new file `agentCapabilities.ts`) | Workforce: `shift.fill` (scheduling; SHIFT_ASSIGN), `attendance.confirm` (scheduling + time; SHIFT_ASSIGN for the backup), `schedule.repair` (scheduling; SHIFT_ASSIGN), `coverage.forecast` (scheduling; no gate). Compliance: `document.chase` (compliance; no gate), `i9.section2` (compliance; no gate), `incident.loop` (compliance + hrCases; CASE_OPEN), `coverage.credentials` (compliance; no gate). Each with its scopes and the metric keys from §4.3 |
| `capabilitiesFor(modules)` | the catalog filtered to entries whose `requiresModule` are all on: the one source for Hugo's help text, the Agents page and the MCP catalog |
| Views | `AgentCapabilitySummary`, `AgentProposalSummary`, `AgentTenantControlState`, `CapabilityScorecard` zod schemas |

### 8.4 API surface

| Route | Gate | Audit |
|---|---|---|
| `GET /agents/:id/capabilities` | `view:org` (exec stays read-only and holds it) | none |
| `POST /agents/:id/capabilities/:key/suspend` and `/resume` | `manage:org`; resume by the agent's owner only, as `resumeAgent` does | `agent.capability_suspended`, `agent.capability_resumed` |
| `GET /agents/:id/capabilities/:key/scorecard` | `view:org` | none |
| `GET /agents/proposals?capability=&status=` | `view:org`, tenant-filtered | none |
| `GET /agents/control`, `POST /agents/suspend-all`, `POST /agents/resume-all` | same paths, now reading and writing `AgentTenantControl` for the caller's tenant; the platform singleton moves to `POST /agents/platform/suspend-all` and `/resume-all`, gated `manage:org` plus the platform scope | `agent.tenant_suspended`, `agent.platform_suspended` |
| `POST /agents/:id/scenarios/run` | unchanged; the runner gains fixture scenarios for capabilities (test 5) | `agent.scenarios_run` |
| `POST /agent/v1/proposals` (new) | `requireAgent(<the capability's scope>)`; refuses a disabled or suspended capability (`capability_suspended`) or one whose module is off (404); files an `AgentApprovalRequest` when the capability has a gate; writes the `AgentProposal` | `agent.proposal_created` under the agent's workerId |
| Desk approval | a pending SHIFT_ASSIGN or CASE_OPEN request becomes a decision item in `lib/roleDecisions.ts` for the subject's desk (the shift's supervisor, HR); approving in place calls the existing `decideApproval` | the existing approval decision audit |

`authenticateAgent` (`lib/agents.ts`) and `requireAgent` (`middleware/agentAuth.ts`) gain two reads per call: `AgentTenantControl` for the agent's tenant, and, on capability routes, the capability's `enabled` and `suspendedAt`. Both are single-row lookups by a unique key.

### 8.5 Tests, in the order to write them

1. **Nothing executes until a human approves, for the new actions** (`__tests__/routes/agents.test.ts`, extending the CLIENT_MESSAGE case): SHIFT_ASSIGN and CASE_OPEN proposals wait PENDING; `claimApproval` refuses pending, rejected, expired, consumed and mismatched payloads; an approved one executes exactly once and its proposal moves to EXECUTED.
2. **Per-tenant kill switch** (`__tests__/routes/agentControls.test.ts`): tenant two's suspend-all stops tenant two's agent on its next call and leaves Alto's running; the platform switch stops both; only an admin of that tenant lifts its switch.
3. **Per-tenant built-ins**: `ensureBuiltInAgents` under `runForEachTenant` creates one `whatsapp-assistant` per tenant, owned by that tenant's oldest admin; a second run creates none; a duplicate `(tenantId, builtInKey)` insert is refused by the partial index (risk ruling 3).
4. **Capability scorecard and switch**: proposals with outcomes over seven days give per-capability counts (proposed, approved, executed, rejected, expired, outcome rate); a suspended capability refuses `/agent/v1/proposals` with `capability_suspended` while the agent's other capability still works.
5. **Fixture scenario runner**: a `shift.fill` fixture (two open shifts, three people on the bench, one with an overlapping shift) loaded into a throwaway tenant and run with a fixed `now` passes when the proposal names the free person and fails when the expectation names the overlapping one; the fixture tenant is deleted afterwards.
6. **Capabilities follow modules**: under the hotel profile with `scheduling` on and `compliance` off, `capabilitiesFor` lists only Workforce; the Agents page payload and Hugo's help text carry no Compliance capability and pass the forbidden-word check.
7. **Cross-tenant**: the new `/agents/...` routes are called by the generated suite; none may enter the baseline.

### 8.6 Risks, and what is out of step 0

| Risk | Handling |
|---|---|
| `ALTER TYPE … ADD VALUE` inside the migration transaction | Safe on Postgres 12+ while the value is unused in that transaction; the migration does not use it. Read twice before push (no scratch Postgres on the dev machine). |
| Dropping the global builtInKey index lets two Alto rows share a key | The partial `(tenantId, builtInKey)` index is created in the same migration; test 3 proves the refusal. |
| Two kill switches confuse the operator | The Agents page shows both lines ("This organization" and "Platform"), and the trail names which switch stopped the call. |
| Capability reads add latency to every agent call | Two indexed single-row reads, held to test 2's five-second budget. |

Out of step 0: any capability's behaviour (the sweeps stay where they are until step 1 moves them), Hugo's intent registry and app panel (step 3), desk UI beyond the decision item, the MCP server (2-7), billing (2-6), and converting the `AgentControl` singleton (2-1 Migration C).

**Question for the owner:** HR case staff routes gate on role (`manage:onboarding` sees all cases, `process:payroll` sees payroll cases), not on a case capability. Step 0 proposes an agent-only scope `open:hr-case` for CASE_OPEN rather than lending agents `manage:onboarding`. Confirm, or name the existing capability a case-opening agent should hold.
