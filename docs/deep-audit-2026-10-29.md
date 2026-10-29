# Deep audit and fix wave, 2026-10-29

Seven read-only auditors went through the whole product. One crawler made 1,444 page loads as nine personas, and one auditor read the code. They found about 185 issues, ranked P0 to P3. The owner asked to "fix everything". Ten builders fixed them by area, a company-day sweep followed, and the coordinator merged the result. The audit reports live outside the repository, in the session scratchpad. This page records what changed and what is still the owner's call.

The audit's overall picture holds:
- Nothing crashed, and every page shows useful content in under 3 s.
- Payroll's core arithmetic is right.
- The problems sat in four places: permissions and reach, which "day" it is, one measure giving several numbers, and money actions that could run twice.

## What changed, by area

**Security and reach**
- Onboarding's "Hire as" can no longer mint a role holding capabilities the hirer lacks. One rule covers both apps: `mayGrantRole` in the shared package and `lib/roleGrant.ts` in the API.
- The Sign-in page (SSO, SCIM, policy, networks), custom roles and group mappings, billing and the support inbox need `manage:org` plus `view:hr-admin`.
- The HR case desk is for HR (`lib/hrCaseScope.ts`).
- Every by-id route that reads or changes a person checks the caller's reach. That covers SSN and bank reveal, deactivate, erase, transfer, approvals, garnishments, tax forms, documents, reimbursements, time, shifts (single and bulk), tasks, photo rules, merit cycles, performance records and separation offboarding.
- New helpers in `lib/scope.ts`: `loadInScope`, `scopeSites`, `assertCompanyWide`, `subjectReachWhere`.
- `__tests__/tenancy/byIdScope.test.ts` sends another store's id to about 65 routes, and `siteScope` now seeds the models it used to miss.
- Reimbursements are maker-checker: the filer can't approve or settle their own report.
- Supervisors no longer see pay through task costs.

**Payroll**
- One pay-period cut, `punchesInPeriod` in `lib/payrollSchedule.ts` plus `lib/payrollRunCut.ts`. It uses the site's day for every run, the exceptions, pay-and-bill, labor rules and earned-wage. Evening clock-ins on a period's edge are now paid.
- Tax-year limits use the pay date, so the Jan 8, 2027 check starts 2027.
- Disburse claims the run atomically, and an in-house ACH file waits for "mark uploaded".
- Earned-wage, bill payments and garnishment remittances claim before they act.
- Every money button confirms through `MoneyConfirm`.
- Run totals include state-program and local taxes, and cents use integer math.
- **Back pay** (the owner's decision) covers evening hours the old UTC cut missed. `lib/payrollBackPay.ts` finds them, and the Payroll home's BackPayCard adds them to the next regular run. A unique claim per punch means no hour is paid twice, and it goes to a second person when one is required.
- **Late checks count in the year they're paid** (the owner's decision).

**Books and billing**
- Statement lines add up to the total, on screen and in the PDF.
- Month-end close checks: tax liabilities are compared kind for kind, and a bank step fails when there's no feed.
- An overdrawn bank account is flagged in Books, the cash KPI, the forecast, the finance home and the executive cash measure.
- Federal deposits follow the IRS schedule.
- One CSV writer: numbers stay numeric, there are no float tails, and formulas are guarded.
- Recurring bills are unique per date.

**Floor (supervisor and manager)**
- The floor counts use every window.
- The contract is drawn per hour.
- "Today" is the store's day or the company's.
- The incident form has "When did it happen?". The near-miss parsing bug is fixed: injuries filed from the floor app had been stored as near misses, so **HR should review earlier floor-filed incidents**.
- A scoped crew card (`GET /crew/:id`, no pay).
- The 1024 px week grid fits.
- Overtime risk has one definition: 36 h.

**Associate (phone)**
- One pay fact per screen: the earnings API's `period`, one take-home figure, one open-shift rate.
- Saturday–Friday weeks everywhere, no doubled zone label, and correct document expiry dates.
- The DST-safe week strip.
- Directions use the store's street address.
- Benefits and internal jobs are in all six languages.
- Associates never see "Alto" hard-coded where their company's name belongs.
- The ride balance is split by payday. A minimum-wage rider is told plainly that fares can't come out of pay (`lib/ridePayrollOutlook.ts`).

**Languages**
- The dictionary check now finds keys used outside `t('…')`.
- About 600 keys are translated into each of Turkish, Haitian Creole, Portuguese and Ukrainian.
- Dates follow the language.
- The account language holds all six. Emails and WhatsApp still fall back to English outside en/es/tr.

**Leadership and clients**
- `packages/shared/src/metrics.ts` gives one definition per measure: margin, days to collect versus average days to pay, working / on the books / placed, open shifts, hours this week, overtime risk.
- The chairman's drill links lead somewhere useful and keep the period.
- Client-portal numbers are fixed: expired checklists, overnight coverage, staffed versus contracted hours, and late people.
- **New: client sign-off on weekly hours** (`ClientHoursSignOff`). Statements show its status.

**People, HR and recruiting**
- Cost centres and positions load again: a company-wide row now has `clientId` null.
- Client pickers use `GET /clients/options`.
- Full-name and phone search work.
- One hire date per person (`lib/hireDate.ts`).
- Expired offers expire.
- Typed text survives Esc.
- A phone-first recruiting pipeline.
- The course catalog moved under People.

**Platform**
- Background jobs run per tenant, through `lib/bootJobs.ts` and `armJob`, and a compiler-walk test guards it.
- A response-schema failure is a 500 reported to Sentry, not a 400.
- One "can't read this" pattern: no raw capability strings, and 4xx responses aren't retried.
- Avatars request only photos that exist.
- Charts mount once measured.
- Gated changes say "Sent for approval" (`Gated<T>`, `useGatedMutation`).
- Contract tests check that web calls and notification links resolve.
- Opt-in per-persona route sweep: `E2E_FULLSTACK=1 ROUTE_SWEEP=1`.

**The company day**
- An ESLint rule in both apps bans `.toISOString().slice(0, 10)` and `DEFAULT_TIMEZONE` outside `lib/timezone.ts`.
- About 490 places were fixed. Each now uses one of these helpers: `dateColumnKey` (date-only columns), `addDaysToKey` (calendar math), `orgDateKey` (the company's today) or `dateKeyInZone` (a place's day).
- A few genuinely-UTC places are annotated `UTC on purpose: <why>`.

## Migrations (all additive or safe)
- `20270204090000_payroll_site_day_cut`:
  - Adds `PayrollRun.timeCut`. Existing runs are marked `UTC` and new runs default to `SITE_DAY`.
  - Adds `disburseClaimedAt`.
  - Bank entries still marked SENT inside files the bank rejected become RETURNED.
  - Adds a unique live-paycheck index, or skips it with a NOTICE if live data already has duplicates.
- `20270204100000_back_pay_evening_hours`: the `BACK_PAY` enum values and the `BackPayClaim` table, under row-level security.
- `20270204120000_money_claims`: adds `GarnishmentRemittance.sendingAt`.
- `20270205100000_recurring_bill_once_per_date`: detaches duplicate recurring bills from their template, deletes nothing, then adds a unique key.
- `20270209100000_client_hours_signoff`: a new table under row-level security.

**Effects on live data at deploy:**
- The first site-day run after each UTC-cut run pays that run's missed last evening, once.
- Earned-wage "available" uses the real take-home.
- Pennies may move under integer-cent rounding.
- The hourly books sweep records the missing client payments for statements marked paid without one.

## Waiting on the owner
1. **Minimum-wage riders:** Maria earns $15 in Florida, so van fares can never come out of her pay. Waive them, charge another way, or change the rate?
2. **The hourly books sweep:** should it keep recording payments for statements marked paid without one?
3. **Employers of record:** may Finance and recruiters read them (EINs and addresses)?
4. **Overtime risk:** is 36 h right everywhere?
5. **Manager phone tabs:** Home / Approvals / My team / Messages?
6. **Executive revenue and margin:** standard rates or contract rate cards?
7. **Scheduled hours:** should they count draft shifts?
8. **Haitian Creole dates:** French-style, or should we build Creole names?
9. **Money format:** US style in every language?
10. **Store-bound accounts and company-wide approvals:** should they ever decide them?
11. **Merit cycles:** are they per client?
12. **SOP library seed:** for hotel tenants too?
13. **Marketing weekly chart:** Monday weeks, or the company's Saturday–Friday?
14. **Client hours sign-off:** region accounts sign their region's stores. Is that right?
15. **Overnight shifts:** an overnight belongs to the night it started. Is that right?
16. **Synchros:** we need a real export to confirm the reconcile columns.
