# The executive portal

Built 2026-10-27/28 to the standard of a Fortune-500 executive dashboard: the chairman sees how the company is doing against plan in five seconds, on one screen, and every number opens its own detail. This page is the reference; the shapes are in `packages/shared/src/executivePortal.ts`.

## The frame

Every executive page and the board pack are read in one frame, kept in the URL (`?period=&compare=`; the clean URL is the default):

| Period | Days |
|---|---|
| `week` | the last complete company week (Saturday → Friday, company time zone) |
| `month` / `quarter` / `year` | the calendar period to now |

| Compared with | Meaning |
|---|---|
| `prior` (default) | the same length immediately before; a to-date period against the previous period's same number of days (Oct 1–27 vs Sep 1–27) |
| `year` | the same span a year earlier |
| `plan` | the quarter's targets, money prorated by elapsed days |

`apps/api/src/lib/execPeriods.ts` resolves it (`resolveExecWindow`, `prorateTarget`, `judge`, `lastCompleteWeeks`); `apps/web/src/lib/executiveApi.ts` holds it on the web (`useExecFrame`, `execHref` keeps it on drill links). Default: the quarter to date against the prior quarter's same days.

## The scorecard (GET /executive/overview)

Eight measures, each with its value, the comparison and the change, the plan and a status (on plan / within 5% short = watch / off plan; thresholds where there is no plan), 13 weekly points, its basis and a one-sentence definition.

| Measure | Definition | Basis |
|---|---|---|
| Revenue | approved/completed paid hours at the standard bill rate, overtime at the pay multipliers | est. |
| Gross margin % | revenue less pay, employer burden and overhead, as a share of revenue | est. |
| Working | the one definition of active (lib/activeDefinition), "of N on the books" (lib/peopleStatus) | live |
| Fill rate | published shifts in the period with someone assigned | live |
| Turnover | separations over the average on the books, annualized | live |
| Overtime | overtime and double-time hours as a share of paid hours | live |
| Days to collect | open receivables ÷ the last 90 days' average daily billing (finalized statements) | statements |
| Cash | bank balances in the company books; status from the 13-week low against the cash floor | books |

Labor cost % is 100 − margin %, so it lives in Financials, not as a second tile. "What changed" is 3–5 sentences ranked by significance; decisions come from the existing decision queue.

**One definition everywhere.** Paid hours (`lib/paidHours.ts`) are the same on the executive pages, the summary and Analytics; headcount uses peopleStatus/activeDefinition, the same as the People directory and Analytics.

## The metric dictionary

`packages/shared/src/metrics.ts` (`METRICS`, fix wave 2026-10-29) holds one name and one definition for every measure that more than one screen shows, with its unit, basis and the API function that computes it. A label names exactly one measure: a screen that shows a different basis uses that basis's own entry and its own words, never the same label with a different number. Card hints, tooltips and the board pack's definitions read the `definition` sentence; the shared test (`packages/shared/src/__tests__/metrics.test.ts`) fails on two measures sharing a label.

| Id | Label | Definition (short) | Computed by |
|---|---|---|---|
| `revenue` | Revenue (badge: est.) | paid hours at the standard bill rate, overtime at the multipliers | `execFinance.laborBetween().billed` |
| `billedAtContractRates` | Billed at contract rates | approved hours at each client's contract bill rate | `financeCockpit.marginTrend` |
| `billedStatements` | Billed on statements | finalized statements whose period ends in the range | `clientMetrics` `billedInRange` |
| `grossMargin` / `grossMarginPct` | Gross margin / Gross margin % | revenue less pay, employer burden and overhead (standard rates) | `execFinance.laborBetween().margin` |
| `marginAfterWages` | Margin after wages | billed at contract rates less wages only (no burden, no overhead) | `financeCockpit.marginTrend` |
| `scheduledMarginAfterWages` | Scheduled margin after wages | scheduled hours at contract bill rates less scheduled pay | `GET /scheduling/labor-costs` |
| `statementMargin` | Margin on statements | statement hours against the wages and employer taxes paid for them | `clientMetrics.marginByClient` |
| `daysToCollect` | Days to collect | DSO: open AR ÷ the last 90 days' average daily billing | `execFinance.dsoAsOf` |
| `averageDaysToPay` | Average days to pay | statements paid in the window, finalized → paid, averaged | `GET /books/receivables/dso` |
| `working` | Working | placed, and worked in the active window or has a shift ahead | `activeDefinition.activeHeadcount` |
| `onTheBooks` | On the books | hired and not separated | `peopleStatus.workStatusCounts().onTheBooks` |
| `placed` | Placed | open assignment (or approved application with none), working or not | `activeDefinition.placements` |
| `onTheFloor` | On the floor now | an open punch right now | `GET /analytics/dashboard` |
| `turnover` | Turnover | separations in the selected period ÷ average on the books, annualized | `peopleStatus.turnoverBetween` |
| `turnover90d` | Turnover, last 90 days | the same over the trailing 90 days | `peopleStatus.turnoverBetween` |
| `openShifts` | Open shifts | published, no one assigned, not ended (status OPEN only) | `GET /analytics/dashboard` |
| `fillRate` | Fill rate | published shifts in the period with someone assigned | `execFinance.fillCounts` |
| `paidHours` | Paid hours | approved/completed closed punches, breaks out, split as pay splits | `paidHours.loadPaidHours` |
| `hoursThisWeek` | Hours this week | paid hours since the company week began (Saturday, company zone) | `GET /analytics/dashboard` `week` |
| `scheduledHours` | Scheduled hours | non-cancelled shifts, start to end less the one-hour meal over six hours | `paidMinutesForRange` |
| `overtimeShare` | Overtime | OT + DT hours as a share of paid hours | `execFinance.laborBetween` |
| `overtimeRisk` | Overtime risk | worked + still-scheduled hours this week reach 36 (`OVERTIME_RISK_HOURS`) | `timeExceptions().overtimeRisk` |
| `projectedOvertime` | Heading into overtime | on the floor, and the week with its schedule already includes overtime | `GET /scheduling/floor-now` |

Overtime risk's line is `OVERTIME_RISK_HOURS` / `isOvertimeRisk()` in `attendanceInsights.ts` (36, beside the 40-hour `ATTENDANCE_OVERTIME_THRESHOLD_HOURS`). The math helpers `marginPctOf` and `daysToCollectOf` are the formulas the API uses.

Which screens read which: the executive pages read `revenue`, `grossMargin(Pct)`, `working`/`onTheBooks`, `fillRate`, `turnover`/`turnover90d`, `overtimeShare`, `daysToCollect`. Analytics reads `working`, `onTheBooks`, `onTheFloor`, `hoursThisWeek`, `openShifts`, and for money `billedAtContractRates` + `marginAfterWages` (the Finance home's figures — not gross margin). Labor costs reads `scheduledHours`, `scheduledMarginAfterWages`, `projectedOvertime`. The ops director's home reads `hoursThisWeek` / `scheduledHours` from the same `GET /analytics/dashboard` week as Analytics. The report builder's people columns (`lib/reportComputed`) are `working` (the `active` column), `onTheBooks`, `placed` and the one status, under the dictionary's labels — the "People working now" template counts what every other screen calls Working. Books' receivables tile is `averageDaysToPay`; the executive tile is `daysToCollect`.

**Where a risk opens.** A risk's `href` is always readable by every `view:executive` role: an executive page, a page all of them hold the view for, or `/executive/risk?open=<id>`, the in-place detail with the records behind the number (`items`; never names, leave reasons or claim facts). The working desk rides in `desk {href, label, requires}` and shows only to a viewer holding `requires`. Operations pulse batons follow the same rule: a baton the viewer can't open is a plain count naming its desk.

**The frame on links and the clock.** `execHref` keeps `?period=&compare=` only on `/` and `/executive/*`. "As of" prints on the company clock with its zone (`ExecPeriod.timezone`, `ExecRisks.timezone`, the briefing's `timezone`; `fmtExecAsOf` on the web).

**Turnover on Workforce.** The card's headline is the period rate (`METRICS.turnover`); "Last 90 days" shows `annualizedPct90d` (`METRICS.turnover90d`) beside `separations90d` and its estimated cost.

## Pages

The chairman's menu leads with the board topics; every other module is kept, door by door, under **All modules** (`ROLE_LEAD` + `ROLE_FOLD` in lib/modules.ts). Other roles that hold `view:executive` find the pages under Insights.

| Page | Path | API |
|---|---|---|
| Home (scorecard, what changed, decisions, previews) | `/` | overview, financials, clients, people, risks, briefing |
| Financials | `/executive/financials` | `GET /executive/financials` |
| Workforce | `/executive/people` | `GET /executive/people` |
| Client portfolio (companies with clients only) | `/executive/clients` | `GET /executive/clients` |
| Risk | `/executive/risk` | `GET /executive/risks` |
| Scenarios (rate model, lose/win a client, plan pace) | `/executive/scenarios` | summary, targets |
| Board packs | `/executive/board-packs` | `GET /executive/board-pack.pdf?period=&compare=` |
| Operations pulse (today on the floor) | `/executive/operations` | summary, briefing, batons, portal engagement, floor-now |

Phone tabs for the chairman: Home · Financials · Clients · Risk.

## The plan

`PUT /executive/targets` — the quarter's revenue, gross margin, headcount, turnover % and fill-rate % targets. The board sets the plan: the chairman holds `set:exec-targets` (a standard, not a record — beside the SOP standard, the role's only writes), admins hold it and `manage:org`. "Set the plan" on the home opens the drawer; every change is audited.

## The board pack

`lib/executiveBoardPack.ts`, drawn with `lib/reportPdf.ts`: cover and contents, scorecard, financials (the margin waterfall, 13 weeks, cash, receivables), clients (left out for a company with no clients), workforce, the risk register, appendix (eight-week trend, definitions, rates). The Saturday digest (`lib/executiveDigest.ts`) attaches the week's pack. No ISO dates, no cents, plurals right; the tests read the PDF's text for those.

## Rules for changes

- Money on executive surfaces is rounded (`fmtExecMoney`: $22.6k); the exact figure goes in the title or the drill-down's table.
- Status colours come from the palette scales and mean status; never colour a zero, a rank or a label.
- A chart with fewer than four points is a number and a sentence.
- A new measure: add it to the contract, compute it in the API with a definition and basis, test it, and give it a drill-down.
- Accessibility: the CI axe sweep walks every executive page as `exec@altohr.com` in both themes and on a phone.
