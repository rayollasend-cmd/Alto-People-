# Claims audit — sessions 31a6b71e and 904cba5b (working tree as of 2026-10-21)

Scope: every concrete deliverable claimed in the assistant's end-of-turn summaries for sessions 31a6b71e (Oct 17–21) and 904cba5b (Oct 21), checked against the working tree (uncommitted batch included). Role-walk items already marked unbuilt in docs/role-walk-2026-10-20.md were not re-audited; the three groups its status header marks built were confirmed (see B).

Checks run: 112 distinct signatures (route, model, migration, cron, page, component, test). Section A lists the 5 that are not fully what the summary said. Section B lists the 107 that are.

## A. Claimed but missing or partial

- **Coverage-gap item in the supervisor's "Needs you"** — scheduling / supervisor home — status: UI-ONLY — source: 904cba5b:632 (and role-walk status header, floor walk 6) — claim: "coverage gap notice" built as part of the supervisor/ops group; the walk's fix was a Needs-you item when a window today has scheduled < contracted, with "Fill from bench". — evidence: apps/web/src/components/floor/CoverageGapNotice.tsx (client-side `coverageGaps(data.roster, myWindows)` on SupervisorDashboard.tsx, with a bench action); no match in apps/api/src/lib/roleDecisions.ts or apps/api/src/routes/inbox.ts. — what's left: the gap never reaches the server-side Needs-you/Inbox counts, so the bell, the phone Approvals badge and the role decision queue still say "Nothing needs you" while the notice shows a short window.

- **Payroll dollars hidden from site-limited users** — payroll / scope — status: PARTIAL — source: 31a6b71e:5520 — claim: "Payroll dollars are hidden from site-limited users." — evidence: apps/api/src/routes/inbox.ts:807,827 (two payroll inbox sources hidden for `isInternallyScoped`), apps/api/src/routes/contractors.ts:61 (refuses), apps/api/src/routes/executive.ts:46 (refuses); commit 9f793087's only payroll.ts change narrows `/readiness` via `scopeAssociates`; no amount suppression found in apps/api/src/routes/payroll.ts run/item responses (`grep includeMoney|showMoney|moneyAllowed` → no match). — what's left: a site-limited user who can reach `/payroll/runs` still gets gross/net/employer-cost on the rows the scope lets through; either strip money fields for `isInternallyScoped` callers or refuse the payroll routes the way executive does.

- **One definition of an open shift, everywhere** — scheduling / home — status: PARTIAL — source: 904cba5b:429, 904cba5b:632, 31a6b71e:15333 — claim: "one shared definition of an open shift" used by home and Scheduling. — evidence: packages/shared/src/openShift.ts (`isOpenShift`) is used by apps/api/src/routes/scheduling.ts:734 and apps/web/src/pages/SupervisorDashboard.tsx; apps/api/src/lib/roleDecisions.ts (working tree) builds its own `openWhere` (published, OPEN, unassigned, startsAt in next 24h) instead of the shared predicate. — what's left: route roleDecisions' open-shift count through the same `isOpenShift` rule (or a server twin of it) so the Needs-you count and the schedule's "open" count can't drift.

- **Time-off hours filled from a shift leave out the unpaid meal break** — time off — status: MISSING (no match) — source: 31a6b71e:15333 ("Things to know") — claim: "Time-off hours filled in from a scheduled shift leave out the unpaid meal break, so a 7:00–1:30 shift fills in 5.5 hours." — evidence: apps/web/src/pages/timeOff/AssociateTimeOffView.tsx:141-142 prefills start/end date and `shiftId` from `?shift=`; no `meal|unpaidBreak|breakMinutes` in apps/web/src/pages/timeOff/*, apps/web/src/lib/timeOffApi.ts or apps/api/src/routes/timeOff.ts. — what's left: confirm where the hours figure is computed from the shift (if anywhere); if it isn't, "Request this shift off" prefills dates only and the summary's 5.5-hour example is not what the code does.

- **Transport "fleet record"** — transport — status: PARTIAL — source: 31a6b71e:3794 — claim: "the fleet record" among the 14 transport builds. — evidence: apps/api/prisma/schema.prisma:10794 `model Van`, :10848 `model VanServiceEntry` (vans and service log exist); apps/api/src/lib/fleet/ is the robots fleet (bear.ts, pudu.ts), not vans; no van-level page route found in apps/web/src/App.tsx (`grep fleet|vans` → none beyond transport home). — what's left: confirm the van record is reachable from the Transport pages (the director's Vans tab) rather than only through the service-log API; if it is only data, it is a record without a door.

Counts: 5 findings (1 UI-ONLY, 3 PARTIAL, 1 MISSING). 0 STUB, 0 UNWIRED.

## B. Verified present (name — evidence)

Kiosk, photos, people
- Kiosk's own eligibility list, no recent-work rule, no 500 cap, supervisor sees own client — apps/api/src/routes/kiosk99.ts:518-641
- Approve refreshes associate/kiosk caches — apps/web/src/pages/onboarding/ApplicationDetail.tsx:298,397,2126
- Profile says "approve their onboarding first" — apps/web/src/pages/people/PeopleDirectory.tsx (grep "onboarding first")
- Staff photo column + migration — apps/api/prisma/migrations/20261211100000_user_profile_photo; GET /users/:id/photo with associate fallback — apps/api/src/routes/profilePhoto.ts:355-366
- Storage warning + "Ask them again" — apps/web/src/components/PhotoStorageBanner.tsx
- Client-portal photo scope — apps/api/src/routes/profilePhoto.ts:319-341
- "No photo" 404 cacheable two minutes — commit a3bed84c (staffProfilePhoto.test.ts)
- Person record /people/:associateId — apps/web/src/App.tsx:636, apps/web/src/pages/people/PersonRecord.tsx
- Message / Text on the record — apps/web/src/pages/people/PersonRecord.tsx:217-231,789-801
- GET /time-off/admin/requests?associateId — apps/api/src/routes/timeOff.ts:434,782
- Manager and job profile edited in place — apps/web/src/pages/people/PeopleDirectory.tsx:2332,2413
- Saved views on People and Applications (?sv=) — PeopleDirectory.tsx:481-483, ApplicationsList.tsx:488
- Mass update, verification letters — apps/api/src/routes/massUpdate.ts, verificationLetters.ts
- Final pay waits on property return — apps/api/src/lib/separationComplete.ts:24

Navigation, inbox, phone
- Doors model + coverage test — apps/web/src/lib/modules.ts (navShapeFor), apps/web/src/__tests__/lib/navCoverage.test.ts
- talent / perks tenant switches — packages/shared/src/tenantProfile.ts:44-45
- GET /me/inbox aggregating sources — apps/api/src/routes/inbox.ts:893
- Settings & trust area — apps/web/src/pages/settings/SettingsArea.tsx, settingsRail.ts
- Regions → org chart field view redirect — apps/web/src/App.tsx:594
- Page-name and hotel-word tests — apps/web/src/__tests__/lib/pageNames.test.ts, __tests__/tenancy/forbiddenWords.test.tsx
- "More" sheet rising from the tab bar — apps/web/src/components/MobileNav.tsx:182-188
- Client chips on phone + "Viewing {client}" strip — MobileNav.tsx:317-340, apps/web/src/components/Topbar.tsx:488
- Admin Approvals tab badge — apps/web/src/components/BottomTabBar.tsx:109,140
- "Paystubs" label — apps/web/src/lib/i18n.tsx:85
- Display & language row — MobileNav.tsx:291,353-385
- Bell grouped by kind with "Needs me" — apps/web/src/components/NotificationsBell.tsx
- "Back to inbox" / next queue bar — apps/web/src/components/InboxReturnBar.tsx, Layout.tsx:278
- Keyboard tables, shift-click range — apps/web/src/components/ui/DataGrid.tsx:491,726
- ⌘K person actions — apps/web/src/components/ui/CommandPalette.tsx:165-176
- "g y" → Payroll — apps/web/src/lib/shortcuts.tsx:33
- i18n lazy packs — apps/web/src/lib/i18n/{es,ht,pt,tr,trStaff,uk}.ts

Hugo and agents
- Claude model behind Hugo, registry tools, fallback — apps/api/src/lib/assistantModel.ts:1-20,176; @anthropic-ai/sdk in apps/api/package.json:28 and package-lock.json:573
- Hand-off offered, not sent ("Send to …") — apps/web/src/components/assistant/AssistantPane.tsx:214; apps/api/src/lib/hugo.ts:181
- ⌘J, spark, hidden when it can't serve — apps/web/src/components/Topbar.tsx:444-468
- One decision endpoint, reason on reject — apps/api/src/routes/agents.ts:186-189; packages/shared/src/contracts.ts:8948 (superRefine)
- Proposals as Inbox source — apps/api/src/routes/inbox.ts:154
- Disclosure line on agent messages — apps/api/src/lib/agentDisclosure.ts:33-51 (used by attendanceConfirm, complianceAgent, incidentLoop, workforceAgent)
- Per-tenant assistant name — apps/api/prisma/schema.prisma:10207; migration 20261213100000_agent_disclosure_tenant_assistant
- Proposal evidence migration — 20261212100000_agent_proposal_evidence
- /agents registry and governance page — apps/web/src/App.tsx:576,597; trust certified rule — apps/api/src/lib/trustCenter.ts:40
- Assistant actions only on CONFIRM — apps/api/src/lib/assistantActions.ts:21-24,129
- Help-center read by the assistant — apps/api/src/routes/hugo.ts (helpCenterSearch)
- Hugo seat page/role-aware starters — apps/web/src/components/home/HugoSeat.tsx:15-22

Org, talent, structure
- Staff "Reports to" + cycle refusal — apps/api/prisma/schema.prisma:520; apps/api/src/routes/org.ts:674-700; migration 20261223100000_staff_reports_to
- Org chart drag store→region, keyboard tree — apps/web/src/pages/org/OrgChart.tsx:158, OrgChartParts.tsx:638
- Site-scope test over list routes — apps/api/src/__tests__/tenancy/siteScope.test.ts
- Career "You are here"; succession 9-box; 30/60/90 timeline — apps/web/src/pages/career/CareerPosition.tsx, succession/SuccessionHome.tsx, ramp/RampHome.tsx
- Expirations "At risk / timeline / list" — apps/web/src/pages/expirations/ExpirationsHome.tsx:58-70
- People analytics charts (22 chart uses) — apps/web/src/pages/reports/PeopleAnalytics.tsx
- Headcount plan per store per week — apps/api/src/lib/staffingPlan.ts:12-16
- Celebrations / headcount modules in nav — apps/web/src/lib/modules.ts:105-109,216
- Executive refuses site-limited — apps/api/src/routes/executive.ts:46
- Tenant isolation default enforce — apps/api/src/config/env.ts:491

Role builds (finance, HR, transport)
- Bill/pay rate on jobs retired — apps/api/src/routes/jobs.ts:116 refuseRates; effective-dated rate cards — apps/api/src/lib/rateCards.ts; pay changes with second approver — apps/api/src/lib/payChanges.ts:24-35
- Finance hold queue in Inbox — apps/api/src/routes/inbox.ts:732; bank change verified by phone — apps/api/src/routes/selfService.ts:901
- Retro pay, payout reroute, earned wage, cash forecast — apps/api/src/lib/retroPay.ts, payoutReroute.ts (used by payroll.ts, branchWebhook.ts, banking/directDeposit.ts), earnedWage.ts, cashForecast.ts
- Guided close — apps/web/src/pages/payroll/PayrollClosePage.tsx
- Unsupported-state block — apps/api/src/routes/payroll.ts:1676; state review/acknowledge — apps/api/src/routes/stateTax.ts:26,112
- Filings marked filed with confirmation — apps/api/src/routes/payrollTaxes.ts:376,501-506
- Statements PO number / terms — schema.prisma:830-831; dunning cron — apps/api/src/index.ts (startStatementDunningCron)
- Time-off policies — apps/api/src/routes/timeOffPolicies.ts
- JE split by cost center — apps/api/src/lib/quickbooks.ts:343-352
- Workflow REQUIRE_APPROVAL, case SLA cron, policy campaigns cron — apps/api/src/lib/workflow.ts:254; index.ts (startCaseSlaCron, startPolicyCampaignCron)
- Self-service change approval — apps/api/src/routes/selfService.ts:11-12,108
- Report builder group-by/totals — apps/api/src/routes/reports96.ts:129-236
- Position budgets, promotions, compensation — apps/api/src/routes/positions.ts:92, promotions.ts, compensation.ts:124-155
- Review-rating calibration — apps/web/src/pages/performance/ReviewCalibration.tsx; apps/api/src/routes/performance.ts:304
- Driver training credential + MVR flag — apps/api/src/lib/transportDrivers.ts:77-128
- Pre-trip required by default — schema.prisma:11350; routes transportOps.ts:352-358
- "Back from directions" — apps/web/src/pages/transport/DriverHome.tsx; i18n
- Per-stop navigation, incidents, rider feedback, cost per seat — DriverHome.tsx:1178; transportOps.ts:499-671,1319
- Stuck/off-route watch — apps/api/src/lib/transportSafety.ts:31-35
- Mapbox routing — apps/api/src/lib/mapboxRouting.ts; standing bookings — apps/api/src/lib/rideSeries.ts
- Drop-off notice — apps/api/src/routes/transport.ts:1053; driver earnings/hours — transportOps.ts:159-189
- WEBHOOK_SIGNING_SECRET — apps/api/src/config/env.ts

Platform wave (labor rules, credits, claims, AI ops, integrations)
- Labor rules shadow → activate with note — apps/api/src/routes/laborRules.ts:25-29,124
- Schedule-change pay exemptions — apps/api/src/lib/predictabilityPay.ts:23,75-103
- WOTC 28-day — apps/api/src/lib/wotc.ts:119-122; ACA — acaMeasurement.ts; FMLA/intermittent — leaveOfAbsence.ts:12-22; unemployment packets, WC FROI — unemploymentClaims.ts:78,191, workersComp.ts:33-201
- Call-outs by text/WhatsApp/phone — apps/api/src/lib/callOutChannels.ts:22-107
- Retention risk bands/plays — apps/api/src/lib/retention.ts:36-60
- BLS wages — apps/api/src/lib/marketWages.ts:36-92; credential wallet public verifier — apps/api/src/routes/wallet.ts:141
- Native app shell — apps/mobile (capacitor.config.ts, ios, android); 50k load harness — apps/api/src/lib/loadHarness.ts
- Providers (E-Verify, screening, drug testing, tax filing, payouts) — apps/api/src/lib/providers/*
- "Your bank (ACH)" card and unknown-kind fallback — apps/web/src/pages/integrations/providers/providerShared.tsx:61,110

Payroll engine round
- Local taxes, reciprocity, multi-state — apps/api/src/lib/taxEngine/{inHouse,jurisdictions}.ts; jurisdictions acknowledge gate — apps/api/src/routes/taxJurisdictions.ts:187; LOCAL_TAX_REVIEW blocking — payrollExceptions.ts:47-76
- Payroll taxes page — apps/web/src/App.tsx:697; W-2 TP/TT — w2Aggregator.ts:71-81; Roth catch-up — contributionLimits.ts:51; 1099 floor — f1099NecAggregator.ts:62
- Own ACH files, holidays, funding, unfunded can't pay — apps/api/src/lib/banking/{nacha,holidays,funding}.ts; assertRunFunded at payroll.ts:2123,2451
- Garnishment e-orders — eiwo.ts; 401k auto-enroll — retirement.ts:116; 834 feeds + SFTP — edi834.ts, fileDelivery.ts, ssh2-sftp-client in package.json:58
- Certified payroll, contractors, daily pay, gross-up, manual checks, pay preview, W-4 estimator, pay↔bill link — routes certifiedPayroll.ts, contractors.ts, payExp.ts:42-274, lib grossUp.ts, manualChecks.ts, w4Estimator.ts, payBillLink.ts
- Pre-payroll review: fingerprinted sign-off, self-review refused, default on, exempt kinds, disburse/retry gated, inbox source, PDF/XLSX — apps/api/src/lib/payrollReview.ts:162-585; schema.prisma:10270; routes/payroll.ts:2120,3204; inbox.ts:708; payrollReviewPdf.ts, payrollReviewXlsx.ts
- Per-run sign-off only (bulk is finalize/disburse) — apps/web/src/pages/payroll/AdminPayrollView.tsx:330
- Paper checks: associate request via approval, void/reissue/stop, positive pay, MICR env — apps/api/src/routes/paperChecks.ts:80-255; lib/paperChecks.ts:3; checkPrintPdf.ts:14-19
- Itemized deduction lines + taxability + backfill script — deductionLines.ts, deductionTaxability.ts, apps/api/scripts/backfill-deduction-lines.ts
- SDI/PFL programs, SS base 184,500 — taxEngine/statePrograms.ts:7-58; W-4 2020+ fix — payrollTax.ts:173-279; W-2 box 14 / local wages — w2Aggregator.ts:55-106; EFW2 — efw2.ts
- Year-end reconciliation — lib/yearEndReconciliation.ts, pages/payroll/YearEndReconciliation.tsx; docKit house style, Spanish paystub — lib/docKit/*, paystub.ts:91,254
- Run payroll in-house checklist — apps/api/src/routes/payrollGoLive.ts:9; App.tsx:712

Pay schedules
- Rules, membership history, reasons, bridge periods — apps/api/src/lib/payScheduleMembership.ts:62-564; migration 20270122100000_pay_schedule_rules
- Automatic moves on hire/placement/pay type/department (Prisma extension) — apps/api/src/lib/payScheduleTriggers.ts:6-7 (wired in apps/api/src/db.ts, onboarding.ts); 3-hour sweep — index.ts (sweepPaySchedules)
- Run tied to a schedule pays members for their days — routes/payroll.ts:478-612; exceptions scoped to membership windows — payrollExceptions.ts:158-161
- Unassigned bucket — routes/paySchedules.ts:890-1009; schedule pages — apps/web/src/pages/payroll/schedules/*
- One-click approve names the schedule — ApplicationDetail.tsx:284,914-916

Transport rides
- Taken ride never waived (single + bulk, conditional update) — apps/api/src/routes/transport.ts:2296-2345 (whyNotWaivable, waiveOne)
- Undo waiver — transport.ts:2390; held fares released on signing — lib/rideAuthorization.ts:105-225
- Fare in force on the ride's date; signature covers lower fares — rideAuthorization.ts:59,121-135
- Authorization wording v2 — rideAuthorizationContent.ts:16
- Riders-to-sign list + reminder — transport.ts:2136-2142,3414; driver manifest "Not signed" — DriverHome.tsx:1294
- Day in the link, Tomorrow, bulk waive UI — apps/web/src/pages/transport/TransportHome.tsx:65-67,243,302-303
- Client margin reads rate cards with "standard" share labelled — apps/api/src/routes/scheduling.ts:1600-1719

Books and QuickBooks
- Ledger postEntry / closed periods / void / reverse — apps/api/src/lib/books/ledger.ts:115-391
- Auto posting + gaps + "Post history" backfill — lib/books/posting/*, routes/books/receivables.ts:188, ReceivablesPage.tsx
- Payables with approval requests, bulk approve, 1099 — routes/books/payables.ts:18-146; BillsPage.tsx:132 (approveBills); BillDetailPage.tsx:181,431
- Bank CSV/OFX/QFX + Plaid, bulk decide, deposit → client payment, reconciliation must be 0.00 — lib/books/bank/{parse,plaid,service}.ts:1207; routes/books/bank.ts:140,219-223
- Close checklist one-click, ready, second-person sign-off, reopen approval — routes/books/close.ts:22-51; lib/books/close/period.ts:33-147
- Budgets, assets depreciation — lib/books/budgets/, lib/books/assets/depreciation.ts
- Books jobs every 5 minutes — index.ts:244-245 (sweepBooks)
- QBO company connection, outbox, pull, conflicts, closed-month rule, webhook, import history, Simulated badge, callback via /api/quickbooks/connect/callback — lib/books/qbo/*; connection.ts:38; routes/books/quickbooks.ts:173; app.ts:435; QuickbooksSyncPage.tsx:185
- Books pages routed — App.tsx:730-750

Time, kiosk, photo at punch
- Punch photo rules (company/client/site/person, most specific wins) — apps/api/src/lib/punchPhotoPolicy.ts:7-53; migration 20270125100000_punch_photo_rules
- Server refuses photo-less required punch; camera-down flagged punch; daily admin notice — routes/kiosk99.ts:2914-2924,1712; punchPhotoPolicy.ts:109 noticeCameraDown
- Rule changes audited; selfie views audited — routes/punchPhotos.ts:128-256; kiosk99.ts:1642 (kiosk.selfie_viewed)
- Kiosk → Photos tab; person Time tab card; Review "No photo — confirm" — pages/kiosk/PunchPhotosTab.tsx; components/PunchPhotoCard (PersonRecord.tsx:363); KioskAdmin.tsx:119
- Kiosk "Punch without a photo — a supervisor will confirm" — KioskPage.tsx:262
- Kiosk name check before punch (3s auto-confirm), SOP clock-out screen, worker language, offline punch named — KioskPage.tsx:85-98,190,302,311-314,921-922
- SOP auto-expiry sweep — lib/storeShiftSop.ts:623-637; index.ts (startOpsSopCron)
- Kiosk punch summary (shift, lateness, break) — lib/kioskPunchSummary.ts; kiosk99.ts:3338; KioskPage.tsx:1068-1073
- Attendance trends / heatmap / late-now / team-hours — routes/attendanceInsights.ts:28-52; TeamHoursCard, SupervisorDashboard
- Timesheet queue opens on the pay period — AdminTimeView.tsx:686,908
- Approve clean time from the run — routes/payroll.ts:616
- Guarded shift pick and time-off decision — lib/shiftAssign.ts:245-249; lib/timeOffRequests.ts:187-196
- Call-out best pick assigned in place — pages/callouts/CallOutsDesk.tsx:79-92
- "Build next week", "Request this shift off" — AdminSchedulingView.tsx:1973; ShiftCard.tsx:620
- Approvals: balance on time-off rows, Deny selected — ApprovalsHome.tsx:894,1320

Ops, manager, comms (role-walk groups marked built)
- Never-closed card with close-out — pages/ops/OpsBoard.tsx:950, NeverClosedCard.tsx:25; routes/opsShifts.ts:382
- Ops activity feed on admin home; "worked recently" hint — AdminDashboard.tsx:40,186,598
- Manager home "Company-wide" scope label — ManagerDashboard.tsx:336
- Repeating 1:1s (cadence, seriesId, action items) + team cell — schema.prisma:6373-6404; routes/team.ts:125-126; TeamHome.tsx:46,469
- Review composer record panel — routes/performance.ts:233; pages/performance/ReviewRecordPanel.tsx
- Labor costs: duplicate stores disambiguated — LaborCostsHome.tsx (disambiguateStores)
- Broadcast templates, audience count, sender on sent log — routes/directoryAndComms.ts:110-126,238,264-277,371
- Compose "(stub)" labels gone — no match in apps/web/src
- Attestation digest + snooze — lib/attestationReminder.ts:8-34; schema.prisma:10562,10609
- Notification routing cleanup — lib/notificationRoutingCleanup.ts
- Communications settings page — pages/settings/CommunicationsSettings.tsx; App.tsx:293
- Marketing postings & boards tab, funnel panels, campaign announce — pages/marketing/{MarketingHome,PostingsBoardsPanel,FunnelPanels}.tsx; routes/marketing.ts:318

Chart kit
- One chart kit (StatTile delta, Waterfall, Heatmap, TrendLine, StackedBar) — apps/web/src/components/ui/charts/*; ChartFrame used by 22 pages
- Payroll waterfall / cost chart / YTD; Books P&L charts; client Performance tab — PayrollReviewPage.tsx, PayrollCostChart.tsx, PayrollYtd.tsx; books/reports/PnlCharts.tsx; clients/ClientPerformance.tsx
- Payroll "Create & finalize", "Finalize & disburse / Disburse" — RunPayrollWizard.tsx:462; PayrollReviewPage.tsx:237

Section B size: 107 entries.
