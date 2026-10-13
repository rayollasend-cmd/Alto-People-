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

From Workday's public descriptions (approximate; not re-verified here): Workday Illuminate ships role agents (Recruiter, Expenses, Succession, Optimize, Payroll, Frontline, Contracts, Policy) and an Agent System of Record that registers and governs agents, including third-party ones, with roles, budgets and audit. The overlap with 1D-2/1D-3 is real. Where Alto People goes further:

- **Frontline first.** Workday's frontline agent answers shift questions; ours proposes the fill, texts the at-risk attendee the night before, repairs coverage after a time-off approval, and lands the proposal on the supervisor's own queue.
- **Seasonal and international.** The Compliance agent knows the I-9 Section 2 clock, E-Verify readiness, program dates (J-1, H-2B) and vaccination requirements per site, in the person's language, through WhatsApp. Workday's compliance is policy Q&A.
- **Hybrid.** The same registry governs people, agents and robots (1D-1 Worker type); a robot's shift and an agent's proposal sit on one board.
- **A human accountable for every agent.** Every proposal names the owner; every decision is the desk's and is logged; a capability can be suspended alone; certification is per model version. Workday governs agents; it does not put a named person on each one.
- **Vocabulary and modules per tenant.** The hotel's agents never say "client". Workday's agents speak Workday.

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
