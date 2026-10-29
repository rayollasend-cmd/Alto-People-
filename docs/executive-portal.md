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
| Active workforce | the one definition of active (lib/activeDefinition), "of N on the books" (lib/peopleStatus) | live |
| Fill rate | published shifts in the period with someone assigned | live |
| Turnover | separations over the average on the books, annualized | live |
| Overtime | overtime and double-time hours as a share of paid hours | live |
| Days to collect | open receivables ÷ the last 90 days' average daily billing (finalized statements) | statements |
| Cash | bank balances in the company books; status from the 13-week low against the cash floor | books |

Labor cost % is 100 − margin %, so it lives in Financials, not as a second tile. "What changed" is 3–5 sentences ranked by significance; decisions come from the existing decision queue.

**One definition everywhere.** Paid hours (`lib/paidHours.ts`) are the same on the executive pages, the summary and Analytics; headcount uses peopleStatus/activeDefinition, the same as the People directory and Analytics.

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
