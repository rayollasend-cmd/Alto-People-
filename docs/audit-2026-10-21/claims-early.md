# Claims audit — sessions 60c6212d, 77cf8fb2, 9b52c9d7 (4bba0c78 has no assistant finals)

Method: read every end-of-turn summary in the three sessions, extracted each concrete deliverable with a verifiable signature (route, model, migration, cron, page, rule), and checked today's code in apps/api, apps/web and packages/shared. A grep hit alone was not accepted; for each item the handler/model/page was opened far enough to confirm it does what was claimed. 104 distinct checks.

## Section A — Claimed but missing or partial

- **Bulk candidate removal** — recruiting — status: PARTIAL — source: 60c6212d:5767 / 60c6212d:6951 — claim: "Remove candidate, individually and in bulk, for duplicates, tests and spam. Reversible for 30 days." — evidence: only a single-id route exists, `apps/api/src/routes/recruiting.ts:959` (`POST /candidates/:id/remove`) and `:1017` (restore); `apps/web/src/pages/recruiting/RecruitingHome.tsx:539` has `bulkAdvance`/bulk reject but no bulk remove, and `apps/web/src/lib/recruitingApi.ts:178` only exposes `removeCandidate(id)` — what's left: a multi-id remove endpoint and a "Remove selected" bulk action on the list view.
- **"Who covers your SOP?" prompt when a shift supervisor's time off is approved** — ops / floor supervision — status: MISSING — source: 9b52c9d7:8434 — claim: "Time off: when a shift supervisor's time off is approved, they're asked 'Who covers your SOP on Sep 20–22?'" — evidence: no match for "covers your SOP" / `shift-covers` / `shiftCover` anywhere in `apps/web/src/pages/timeoff`, `apps/api/src/routes/timeOff.ts` or `apps/api/src/lib/timeOffRequests.ts`; the hand-over primitive itself exists (`apps/api/src/routes/floorTeam.ts:258` `POST /shift-covers`, `apps/web/src/components/floor/CoverShiftCard.tsx` on the dashboard) but nothing in the time-off approval path invokes it — what's left: hook the approval of a shift supervisor's time-off request to the cover dialog (or notify them to hand over for those days).
- **Product-analytics rollups: erasure coverage and retention sweep** — analytics / privacy — status: PARTIAL — source: 9b52c9d7:24207 (step 7 "Check lib/erasure.ts covers the two new user-scoped tables") and 9b52c9d7:24557 ("The analytics feature is fully wired") — claim: wiring complete, including the erasure check; a 13-month rollup sweep was proposed — evidence: `apps/api/src/lib/erasure.ts` has no reference to `UserActivityDay` or `UserKnownIp` (schema `apps/api/prisma/schema.prisma:11377`); `apps/api/src/lib/usageTracker.ts` has no sweep/retention code. Rows cascade on hard user delete only; erasure anonymises rather than deletes, so per-user activity days and known-IP rows survive an erasure request — what's left: add the two tables to `erasure.ts`, and a retention sweep for the daily rollups.
- **Background checks auto-pass (stub provider)** — onboarding / compliance — status: STUB — source: 60c6212d:1787 (flagged as "Fix first" item 1; 60c6212d:2588 and :4961 record it as "still open") — claim: not claimed fixed; recorded here because it is a compliance exposure the summaries themselves rank first — evidence: `apps/api/src/routes/onboarding.ts:2800` still writes `provider: 'stub'` with a PASSED result on authorization — what's left: a real vendor (Checkr/Sterling) or at minimum a "not run" status instead of PASSED.
- **Internal Recruiter holds the full admin capability set** — access control — status: PARTIAL — source: 60c6212d:1787 item 2, 60c6212d:5698 ("still open … recruiters holding full admin permissions") — claim: not claimed fixed; the nav was curated (77cf8fb2:322) but the capability surface was deliberately left — evidence: `packages/shared/src/roles.ts:439` `INTERNAL_RECRUITER: new Set<Capability>(FULL_ADMIN)`; pages are out of the nav but reachable by URL (SSN reveal, roles, API keys) — what's left: a recruiter-scoped capability set, per the summary's own recommendation.
- **Keep-alive test fix (`a3db9d09`)** — test infrastructure — status: reverted (not a gap) — source: 9b52c9d7:23561 claimed it fixed the socket flake; 9b52c9d7:26448 retracted it — evidence: `apps/api/test/noKeepAlive.test.ts` no longer exists and `apps/api/test/setup.ts:12-24` documents the dead end. Listed so nobody re-reads 23561 as a live fix; the underlying bodiless-4xx flake remains unexplained, as the memory note says.

Counts: 6 findings — 1 MISSING, 3 PARTIAL, 1 STUB, 1 reverted-as-stated. No UI-ONLY or UNWIRED findings: every server-side rule that was claimed (bill-rate stripping, pickup-at-store refusal, SOP clock-out gate, no-show wait, schedule ownership, export capabilities, scope guards) was found enforced in the API, not only in the page.

## Section B — Verified present (name — evidence)

Recruiting / careers (60c6212d)
- Hire requires client + template, carries accepted offer pay — `packages/shared/src/contracts.ts:4497` CandidateHireInputSchema; `apps/api/src/routes/recruiting.ts:771`
- Hired-this-month by hire date / days-in-stage from stage entry — `apps/api/prisma/schema.prisma:4707` hiredAt, `:4713` stageChangedAt; `apps/api/src/lib/recruiterHome.ts`
- Candidate timeline + recruiting audit — `schema.prisma:4873` CandidateEvent; migration `20261022090000_candidate_timeline`; `apps/api/src/lib/candidateEvents.ts` (auditRecruiting, recordCandidateEvent) used in recruiting90.ts:266-381
- Public careers site `/careers`, `/careers/:slug`, apply, confirmation email, `?source=`, re-apply shows on timeline — `apps/web/src/App.tsx:887,896`; `apps/api/src/routes/recruiting90.ts:1239,1284,1310` (confirmApplication, source, existing-candidate branch)
- Candidate drawer: edit, notes, schedule interview, scorecard with recommendation — `recruiting.ts:666,336`; `recruiting90.ts:240,338`; `apps/web/src/pages/recruiting/CandidateWorkPanels.tsx:614`
- Structured scorecards (per-question JSON + rating) — `schema.prisma:7203` Interview.scorecard/rating
- `.ics` calendar invites + interviewer calendar feed — `apps/api/src/lib/interviewInvites.ts:63-73`; `apps/api/src/lib/calendarFeed.ts:53`
- Offer letter templates, pay-band approval, candidate e-sign — `recruiting90.ts:477,512,636,663,823,850`; `apps/api/src/lib/candidateOffers.ts:77-86`; migration `20261024090000_offer_approval_esign`
- Client review of submitted candidates in portal — `apps/api/src/routes/clientPortal.ts:1796,1866`; `recruiting.ts:500-582` submittals
- Recruiting analytics (funnel, time-to-fill, cost per hire, offer acceptance, fill rate, 90-day retention) — `apps/api/src/lib/recruitingAnalytics.ts:77,235,264,267,273`; `recruiting.ts:365,396`
- Server-side candidate search/filter/sort/paging; board per-stage paging; CSV exports all matching — `recruiting.ts:150-200`; `RecruitingHome.tsx:629` listAllCandidates
- Board keyboard (arrows, Enter, M = Move to…) — `apps/web/src/pages/recruiting/CandidateBoard.tsx:43,138-164,516`
- Saved views (private/shared, owner-only edit) — `apps/api/src/routes/savedViews.ts:32,75`; `RecruitingHome.tsx:768`
- Job-board feed per board (Indeed XML) + Google JobPosting JSON-LD + per-posting syndicate flag + employmentType/payUnit — `apps/api/src/lib/jobFeed.ts:4-28`; `recruiting90.ts:1268`; `apps/web/src/pages/careers/CareersPage.tsx:250-263`; `schema.prisma:7331-7336`
- Recruiter home dashboard (today, new applicants, waiting on you/others, resend invite, closing soon, activity) — `recruiting.ts:202` GET /recruiting/home; `apps/api/src/lib/recruiterHome.ts:380-513`; `apps/web/src/pages/RecruiterDashboard.tsx`
- Recruiter phone tabs / curated sidebar incl. Relay — `apps/web/src/components/BottomTabBar.tsx:217` RECRUITER_TABS; `apps/web/src/lib/modules.ts:428-445` RECRUITER_MODULE_KEYS (includes 'relay')
- Admin dashboard: "signed in" label for auth.login — `apps/web/src/pages/AdminDashboard.tsx:98`
- Cancel invite (reason, no declined email) / Reopen / Undo hire — `apps/api/src/routes/onboarding.ts:4032,4049`; `recruiting.ts:919`; `apps/api/src/lib/onboardingUndo.ts:126,208,284`
- Undo window on invite/hire emails — `apps/api/src/lib/inviteDelivery.ts:98,170` INVITE_UNDO_SECONDS; cron armed `apps/api/src/index.ts:16`
- Automatic clean-up (14-day invites, 30-day quiet candidates), env off-switch, 5-day persisted grace — `onboardingUndo.ts:39,353`; `apps/api/src/lib/recruitingCleanup.ts:45-226`; `apps/api/src/config/env.ts:168`; migrations `20261028090000_undo_and_cleanup`, `20261028110000_cleanup_grace`; armed `index.ts:144`
- Remove (soft-delete, reason) / Recently removed / Restore — `recruiting.ts:959,980,1017`
- Messages: 160-char preview clipped with name; failed first group message deletes group — `apps/api/src/routes/messages.ts:55-56,415-419,310`
- People page shared directory query — `apps/web/src/lib/directoryApi.ts`; used in `PeopleDirectory.tsx:59`, `PersonRecord.tsx:24`
- Ride pickup: apartment numbers split before search and re-added — `apps/api/src/lib/geocode.ts:333` splitUnit, used at `:364`; tests `apps/api/src/__tests__/lib/geocode.test.ts`
- "Use where I am now" at the store refused with hint — `apps/web/src/pages/transport/PickupPicker.tsx:488`; `apps/web/src/lib/i18n.tsx:3484`
- Server refuses pickup within 250 m of the booked store (422 pickup_at_store) — `apps/api/src/routes/transport.ts:380,662-663`
- First-time rider pickup starts empty (no first-stop fallback) — `apps/web/src/pages/transport/RideHome.tsx:1557` initialPickup
- Dialog can't widen past the phone — `apps/web/src/components/ui/Dialog.tsx:52,248` w-[calc(100vw-2rem)]
- Phone pickup picker with touch sizing (full-screen mode not individually confirmed) — `PickupPicker.tsx:631-800` coarse: classes

Nav (77cf8fb2)
- RECRUITER_MODULE_KEYS branch in visibleModules; core rows rendered on mobile — `modules.ts:428,688`; `apps/web/src/components/MobileNav.tsx:75,169`

Supervisors, scheduling, time (9b52c9d7)
- Shift Supervisor curated sidebar — `modules.ts:463-485` SHIFT_SUPERVISOR_MODULE_KEYS
- Holiday writes scoped to own client; federal imports org-wide only — `apps/api/src/routes/holiday117.ts:32-87`
- PTO entitlements list/edit scoped via scopeAssociates — `apps/api/src/routes/timeOff.ts:786,898-901`
- Labor cost blocked for supervisors on all four cost endpoints + page guard — `apps/api/src/routes/scheduling.ts` `/labor-costs`, `/store-trends`, `/floor-now`, `/ot-outlook` all NOT_CLIENT_BOUNDED; `apps/web/src/App.tsx:553` notClientBounded; test `apps/api/src/__tests__/routes/laborCosts.test.ts:414`
- Decision rooms reopen only for participants after resolution — `apps/api/src/routes/roleDecisions.ts:140-172` resolveItemForUser
- Onboarding + retention analytics behind view:analytics — `apps/api/src/routes/analytics.ts:37,516`; `apps/api/src/routes/retention.ts:47-137`
- Supervisor Today page + tablet tabs — `App.tsx:534` `/today` → PortalToday; `BottomTabBar.tsx:209-211,242`; day roster for supervisors `clientPortal.ts:1163`
- Bill rate stripped server-side for supervisors (ignored on write, defaulted on create) — `scheduling.ts:2218-2247,2686` billRateHidden; `apps/api/src/lib/shiftCreate.ts:61,121`; timesheet money gated `apps/api/src/routes/time.ts:3239,3300,3622` showMoney; `apps/api/src/lib/timesheetWeek.ts:205`
- Deactivation/separation release future shifts; assigning inactive refused; cleanup script — `apps/api/src/lib/deactivation.ts:36-51`; `apps/api/src/lib/separationComplete.ts:52`; `apps/api/src/lib/shiftAssign.ts:24-31`; `apps/api/scripts/release-inactive-shifts.ts`
- Supervisor shift windows (model, migration, picker, gaps card, alert routing) — `schema.prisma:10712`; migration `20260918120000_supervisor_shift_windows`; `apps/api/src/routes/shiftWindows.ts:38-237` incl. `/admin/shift-windows/gaps`; `apps/web/src/pages/admin/SupervisorShiftDialog.tsx`; `apps/web/src/components/ShiftLeadsCard.tsx`; `apps/api/src/lib/noShowRisk.ts:30,188` routes to window lead
- Portal pages on the store's own timezone — `clientPortal.ts:171,285,494,779,981` locationRel.timezone; `schema.prisma:978`
- Fill-rate `?week=this|last` on store calendar — `scheduling.ts:622-676`
- Live board My shift / Whole store; TimeEntry.locationId — `apps/web/src/pages/SupervisorDashboard.tsx`; `apps/web/src/__tests__/pages/time/AdminTimeViewShiftFocus.test.tsx`; `schema.prisma:3371-3374`
- Web test localStorage shim; API truncation guard — `apps/web/test/setup.ts:30-37`; `apps/api/test/db.ts:14,303`; `apps/api/src/__tests__/testIsolation.test.ts`
- Store Ops opens on Board for org-wide roles, floor picker — `apps/web/src/pages/ops/OpsHome.tsx:41,59`
- Safe-area inset gated on installed PWA — `apps/web/src/main.tsx:93-94`; `apps/web/tailwind.config.js:270-272`

Store Ops / SOP
- StoreShiftSop model + migration; one SOP per (location, label, template) — `schema.prisma:2950-2967`; migration `20260927090000_store_shift_sop`; assignment page `apps/web/src/pages/ops/StoreShiftSops.tsx`; `removeTemplateId` `apps/api/src/routes/opsShifts.ts:1832`
- Clock-in opens the SOP (app + kiosk) — `apps/api/src/lib/storeShiftSop.ts:481` openSopOnClockIn; `time.ts:520`; `kiosk99.ts:3306`
- Clock-out refused while SOP open (app, kiosk PIN step, kiosk punch; offline sync exempt) — `storeShiftSop.ts:659` sopBlockingClockOut; `time.ts:549`; `kiosk99.ts:2359-2363,3131-3133`
- Submit requires handover note; Submit-incomplete needs reason; unread notes (36 h) block submit — `opsShifts.ts:2105` handover_required, `:1924` reason_required, `:111,2082`
- Reminder 30 min before due, escalation 30 min after; sweep cron armed — `storeShiftSop.ts:1080` runOpsSopSweep (`:1104-1122`), `index.ts:20` startOpsSopCron
- Hand over my shift (ShiftCover), automatic move 30 min in, lead takes back — `schema.prisma:10692` ShiftCover; `floorTeam.ts:258,351`; `storeShiftSop.ts:63,935` runSopCoverSweep; `apps/web/src/components/floor/CoverShiftCard.tsx`
- Floor supervisor reports to a lead; app punches refused — `schema.prisma:558` User.leadUserId; `apps/api/src/lib/floorLeads.ts`; `time.ts:416`
- Multi-department SOP (departments ledger, merged checklist, "+N more" name) — `schema.prisma:2878` OpsShift.departments; `storeShiftSop.ts:377`
- SOP resolved by punch store then led-window store; log line when nothing opens; HR CANCELLED with reason — `storeShiftSop.ts:146,187,512`; `schema.prisma:2742-2750,2893`; migration `20261016090000_ops_shift_cancelled`
- "Open your <shift> SOP" card when no schedule — `opsShifts.ts:789` /open-options storeShift; `apps/web/src/pages/ops/OpsRunner.tsx:525-535`
- Walmart SOPs with temperature bands; store-manager Store operations page; team-lead "Store today" tab — `apps/api/src/lib/opsSopsWalmart.ts:65-67`; `clientPortal.ts:1324` /client-portal/ops; `App.tsx:538` portal/ops; `OpsHome.tsx:40`
- ± sign toggle on numeric fields (runner + library); SOP temperature triage script — `OpsRunner.tsx:70,1453`; `OpsLibrary.tsx:531-540`; `apps/api/scripts/sop-temperature-types.ts`
- Cross-client transfer: client follows current assignment; Accounts bell + email with Fieldglass instruction — `apps/api/src/lib/associateClients.ts:28`; `apps/api/src/lib/fieldglassNotify.ts:301-374` notifyFinanceOfTransfer (email: true)

Associate home / pay
- "Your shift" hero (late/on-clock/upcoming), shift supervisor + teammates, running earnings — `apps/web/src/pages/associate/MyShiftHero.tsx:456`; `i18n.tsx:2490,2492`; `scheduling.ts:3757` teammates
- Open-shift eligibility unified (placed client, qualifications, no clash) — `apps/api/src/lib/openShiftEligibility.ts:80,161`; `apps/api/src/routes/qualifications.ts:417-465`
- Next payday endpoint + Saturday–Friday workweek helpers — `apps/api/src/routes/payroll.ts:3992` /me/next-payday; `apps/api/src/lib/associatePayday.ts:56`; `apps/web/src/lib/workweek.ts:11-21`
- Pay schedule "first day of period" (Saturday default, preview) — `apps/web/src/pages/payroll/schedules/NewPaySchedulePage.tsx:63-72`, `scheduleKit.tsx:96-110`
- One payday calculation (payDateOffsetDays) used by wizard — `apps/api/src/lib/payrollSchedule.ts:15-110`; `apps/web/src/pages/payroll/RunPayrollWizard.tsx:244-268`
- Production pay-schedule data fix migration — `apps/api/prisma/migrations/20261001090000_alto_pay_schedule/migration.sql`
- Van rides as their own paystub line — `apps/api/src/lib/paystubData.ts:98,113,290-293`

Transport
- Roles, models, migrations — `packages/shared/src/roles.ts:15-16` TRANSPORTATION_DIRECTOR/DRIVER; `schema.prisma:10776-11300` TransportStop/Van/Ride/RideRun/RideRunPing/RidePlace/RideConsent/RideRejection; migrations `20260929090000_transportation` … `20261006090000_ride_shift_seats`
- Ride tab replaces Time off; terms accepted once; 10-hour cutoff — `BottomTabBar.tsx:80`; `schema.prisma:11073` RideConsent; `transport.ts:576,728,742` cutoffHours
- Driver run screen: arrived, on-board/no-show, no-show only 3 min after arrival (server) — `transport.ts:1116-1156`; `apps/api/src/lib/transport.ts:336` NO_SHOW_WAIT_MS = 3 min
- Rider "I'm outside / Running late" signals — `transport.ts:815` /me/rides/:id/signal; `i18n.tsx:3535-3536`
- Director: plan runs, dispatch (multi-ride), run cards, message riders, cancel/waive/unwaive — `transport.ts:2715` /plan, `:2555` POST /runs (≤60 rides), `:2738`, `:2257-2390`; bulk pick `apps/web/src/pages/transport/TransportHome.tsx:824` pickedRides
- Dispatcher closes an abandoned run; unmarked riders cancelled at $0 — `transport.ts:2647` /runs/:id/complete (MANAGE), `:2664` chargeCents: 0; `apps/web/src/lib/format.ts:189` fmtMinutes
- Live van location, ETA, 10-min-out alert, 5-min-late supervisor heads-up, director live map — `apps/api/src/lib/transportLive.ts:38-39,379`; `transport.ts` GET /live, /me/live, POST /driver/runs/:id/location
- Vans (make/model/colour/year/plate/seats) assigned to one driver; Fleet tab; seat offers accept/decline; all-declined alert + re-offer — `schema.prisma:10794-10826`; `transport.ts:3054,3144,2003-2019`; `/driver/requests/:id/*`
- Book by shift, seats left, waitlist auto-promotion — `apps/api/src/lib/transportSeats.ts:18,156-161`; migration `20261006090000_ride_shift_seats`
- Shift map: 400 m clustering, driving order, "Set the pin" — `apps/api/src/lib/rideClusters.ts:23,87,142`; `transport.ts:1708` /rides/:id/pin; `apps/web/src/pages/transport/ShiftMap.tsx`
- Pickup from saved places / GPS / address suggestions; unresolvable refused 422 — `geocode.ts:37` AddressSuggestion, `:51,295` provider switch; `transport.ts:616-636`
- Haptics + chime with mute — `apps/web/src/lib/haptics.ts:14`, `rideAlerts.ts:124`; `apps/web/src/components/transport/SoundToggle.tsx`
- cooperativeGestures prop (inline only); Navigate/Arrived/On-board hierarchy + guard test — `apps/web/src/components/transport/LiveMap.tsx`; `apps/web/src/__tests__/pages/transport/mapGestures.test.tsx`; `apps/web/src/pages/transport/DriverHome.tsx:1174`
- Supervisor "Arriving by van" card — `SupervisorDashboard.tsx:25,923` VanArrivalsCard
- Overlay Back: self-pop token queue + test reset — `apps/web/src/lib/useOverlayBackButton.ts:45-47,126`
- GitHub issue #309 (geofence Arrived) — open, title confirmed via gh

Fieldglass / Relay
- Registration packet (DOB, SSN4, security ID, position/shift/first clock-in), Mark added with Worker ID, travel-doc, undo — `apps/api/src/routes/financeOverview.ts:353-535` (/finance/fieldglass, /:associateId/packet, /done, PATCH, /travel-doc); `apps/api/src/lib/fieldglassPacket.ts:59,210`; `apps/api/src/lib/fieldglassSecurityId.ts:42`; `apps/web/src/pages/fieldglass/FieldglassQueue.tsx:17-57`
- Timesheet statuses, entered-by, import from Fieldglass (xlsx/csv), Monday 2 PM PT deadline, notes, resubmitted, history + CSV — `schema.prisma:1339-1360`; `apps/api/src/lib/fieldglassDesk.ts:31-33,304`; `time.ts:3404,3453,3606`; `apps/api/src/lib/timesheetHistory.ts:51,311`; migrations `20261007090000_fieldglass_desk`, `20261008090000_fieldglass_history`
- Sidebar entries "Fieldglass timesheets" / "Fieldglass setup" — `modules.ts:57-58,349-350,471`; `apps/web/src/pages/fieldglass/FieldglassSetup.tsx`
- Relay desks/claims/hand-off, pipeline, lanes, Fieldglass batons incl. timesheets-to-enter/rejected — `apps/api/src/routes/relay.ts` (/relay/board, /relay/claims holderUserId:194); `apps/api/src/lib/relayBoard.ts:5,619-624`; `apps/web/src/pages/relay/LaneDrawer.tsx`; migration `20261009090000_relay_claims`
- Relay requests + documents workstation (25 MB guard, drag-drop, confirm delete, search) — `apps/api/src/routes/relayWork.ts` (/relay/requests, /relay/files); `apps/web/src/pages/relay/RelayFiles.tsx:80,130,207`; `RelayRequests.tsx:349-356`; migration `20261010090000_relay_workstation`

App feel / shell
- Suspense hoisted + v7_startTransition; chunk-driven progress bar; compact topbar title — `apps/web/src/main.tsx:278-290`; `apps/web/src/components/NavigationProgress.tsx:2`; `apps/web/src/components/Topbar.tsx:152,209-211`
- Offline: query cache persisted to IndexedDB; offline session copy; optimistic helper — `apps/web/src/lib/queryPersist.ts:75,153`; `offlineSession.ts`; `optimistic.ts`; transport QueryError `RideHome.tsx:64`
- Tab scroll memory + phone back control — `apps/web/src/components/Layout.tsx:63,177,188` scrollPositions; `Topbar.tsx:116-128` showBack/goBack (commit c4d7af01)
- History-write counter diagnostic — `apps/web/src/lib/historyGuard.ts`
- CSP 'unsafe-eval' with rationale; kiosk punch P2002 idempotency — `apps/api/src/app.ts:378-394`; `kiosk99.ts:753,3368-3381`

Time off / notifications / analytics
- Approve past balance with reason into ledger; upsert balance; bulk entitlements; bereavement/jury duty exempt — `apps/api/src/lib/timeOffRequests.ts:90,136-160`; `timeOff.ts:822` /admin/entitlements/bulk; `apps/web/src/pages/timeoff/AdminTimeOffEntitlementsView.tsx:173`; `contracts.ts:5743-5745`
- Role×category routing; mutable bell (inAppEnabled), mandatory refused on both channels; Bell/Email toggles — `contracts.ts:5539,5567`; `schema.prisma:5030`; `apps/api/src/lib/notify.ts:117-138`; `apps/api/src/routes/auth.ts:2121-2151`; `apps/web/src/pages/Settings.tsx:946-979`; migration `20261011090000_notification_pref_in_app`
- portal.engagement_digest / kiosk_device_alert mapped to workplace bucket and muted — `contracts.ts:5592`; `apps/api/src/lib/portalEngagement.ts:373`; `kioskMaintenance.ts:307`
- Product analytics + login tracking (middleware, router, flusher, capability, page, new-network alert) — `apps/api/src/middleware/usage.ts`; `apps/api/src/routes/productAnalytics.ts`; `app.ts:51,220`; `index.ts:53,184`; `roles.ts:134,307`; `apps/api/src/lib/audit.ts:185,215`; `App.tsx:587`; migration `20261012090000_product_analytics`
- Roles tests brought to the real model (shared green) — `packages/shared/src/__tests__/roles.test.ts` (71 passing per later sessions)

Compliance / documents / security
- Offer-letter signal relabelled "Offer approved"; sweep cap 5,000 + no_template logging — `apps/api/src/routes/complianceScorecard.ts:353,466`; `apps/api/src/lib/offerLetters.ts:207,270,335`
- Vault: server paging/sort/search/multi-status, /documents/admin/stats, verify-with-expiry for EXPIRING_KINDS, shared RejectDocumentDialog, reclassify Move, gallery + blur — `apps/api/src/routes/documents.ts:536-595`; `apps/web/src/pages/documents/AdminDocumentsView.tsx:39,111,161-187,1147`; `apps/web/src/components/RejectDocumentDialog.tsx`
- Streaming downloads, memory telemetry, 16 GB heap ceiling — `apps/api/src/lib/blobStore.ts:53,84`; `documents.ts:463`; `apps/api/src/lib/memoryWatch.ts`; `railway.json:9`
- Multer abort treated as client hang-up; hidden sourcemaps uploaded then dropped — `apps/api/src/middleware/error.ts:55-70`; `apps/web/vite.config.ts:3,138-147`
- E-Verify "first day worked" — `apps/api/src/routes/everify.ts:362`; `apps/web/src/pages/compliance/EVerifyTab.tsx`
- Report schedules require ownership (public not enough); list/delete scoped — `apps/api/src/routes/reports96.ts:150-198`
- Bulk PII exports moved to export:payroll-pii / export:audit-packet; named-exporter gate on W-2/1099 bulk + e-file; view:payroll-documents split — `roles.ts:99,140,150,310`; `org.ts:77,1858`; `payroll.ts:2950`; `auditPacket.ts:54`; `payrollTax91.ts` 9× assertBulkPiiExporter; `apps/api/src/lib/bulkPiiExport.ts:40`
- Qualification writes scoped; jobs/projects writes scoped; self clock-in job client check — `apps/api/src/lib/scope.ts:529,550`; `jobs.ts:51,128`; `projectsAndPay.ts:59,88`; `time.ts:458`
- Application (clientId, status, invitedAt DESC) index — `schema.prisma:2506`; migration `20261014090000_application_client_status_index`
- Keep-alive fix reverted and documented — `apps/api/test/setup.ts:12-24`

Section B size: 101 verified items.
