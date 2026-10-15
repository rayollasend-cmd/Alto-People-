# Brief 3-4 — Labor-demand forecasting

Built 2026-10-15 in full. The forecast is a transparent model per site and org week, 26 weeks ahead with a band it earns from its own back-test, fed by verified hours, a holiday table and the client signals a person types in. The season planner starts from it with one click.

## 1. What a forecast is here

A number a workforce manager can check by hand. For a site and an org week (the company week, as the site's own clock sees it):

| Part | How it is made |
|---|---|
| Recent | Mean verified hours of the eight completed weeks before the anchor week |
| Trend | (mean of the last four − mean of the four before) ÷ 4, per week, capped at ±20% of recent |
| Last year | The same org week 52 weeks earlier, scaled by recent ÷ the same eight weeks a year ago, so a site that grew is scaled up rather than copied |
| Holiday | A factor for the week that holds New Year's, MLK, Presidents', spring break, Memorial Day, July 4, Labor Day, Thanksgiving or Christmas (1.02 to 1.10); it lifts the recent part only, since last year already lived through its holiday |
| Signals | Multipliers a person entered for the site-week (a truck schedule, occupancy, an event), with a source |
| p50 | w × last year + (1 − w) × (recent + trend × lead) × holiday, × signals, floored at zero |
| Band | p50 × (1 + 10th percentile of the back-test's signed errors) to p50 × (1 + 90th percentile), never narrower than ±15% |

Verified hours are approved and completed time entries with both punches, bucketed on the week their clock-in falls in, in the site's zone with the company's start day (`startOfWeekForSite`). A week inside the covered range with no entry is a true zero. The current, unfinished week is never read as a low.

## 2. The weights come from the back-test

Every historical week with sixteen or more weeks of history before it is forecast from the history before it at a four-week lead, for each candidate weight on last year (0, 0.25, 0.5, 0.75, 1). The weight with the lowest mean absolute percent error wins; the band is the 10th and 90th percentile of its signed errors. With no history older than a year the weight is forced to 0 and the default band stands.

The monthly job (`lib/forecast/cron.ts`, per tenant with the scheduling module on, checked every six hours) first scores what came true — each site-week a past run forecast whose week has ended is compared with the verified hours that came, one `ForecastAccuracy` row per lead — then computes the month's run, whose back-test re-picks the weights from the longer history. That is how the model improves monthly: no weights are hidden anywhere else.

## 3. Back-test result

The synthetic acceptance test (`src/__tests__/lib/forecastModel.test.ts`) builds three sites with two years of weekly hours: a summer peak of 15–50% amplitude, 2–10% year-over-year growth, 5–7% noise. The back-test scores more than 200 site-weeks at a four-week lead; the summer (June–August) mean absolute percent error and the all-year error both come in under 15%, last year earns a positive weight, and the band is never narrower than the default.

On the walk's demo year the data is flat by construction (each store's crew is cut to a constant window target with weekday off-days), so the back-test error there is small and does not exercise the seasonal path; `npx tsx scripts/forecast-backtest.ts` prints the site-week table against whatever a database holds. The first real reading is production's own history once the monthly job has scored a month.

## 4. What was built

- Data: `ForecastRun` (method, horizon, anchor week, trigger, the weights used), `ForecastSiteWeek` (p10/p50/p90 and the drivers JSON), `ForecastSignal` (site, week, kind, factor, source, note; unique per site-week-kind), `ForecastAccuracy` (site, week, lead, forecast, actual, error; unique per site-week-lead). Migration `20261206100000_forecasting`. Every row carries its tenant.
- API (`/forecast`, scheduling module, `view:org` to read, `manage:org` to write): sites with the next four weeks and the accuracy so far; one site's 26 weeks behind and ahead with drivers, accuracy and signals; compute (scores past runs first); signals upsert and delete; `POST /forecast/plan` creates a season plan whose demand is the forecast.
- Planner handoff: hours a week become people on the floor a day (hours ÷ 7 ÷ shift hours), split across day, evening and overnight the way the site's current staffing targets split, all on the day shift when it has none; weeks past the horizon repeat the last forecast week and the plan's notes say so. The planner's own `createPlan` does the rest; its math is not forked.
- Web: `/forecast` (Demand forecast, Workforce management group) on the List template: four tiles, a site picker, the chart (verified hours, the forecast line, the band, a Now line, a Details table twin), the next four weeks' drivers in words, the scoring table with the error badged against the 15% bar, a signals dialog, a start-a-plan dialog. The planner's list has "Start from the forecast".
- Script: `scripts/forecast-backtest.ts` (read-only).

## 5. Decisions taken

1. Explainable over accurate-looking: a seasonal-naive-with-trend model whose every part is on the page, not a black box. The band comes from measured residuals, never from an assumed distribution.
2. Signals are multipliers a person enters, with a source, and they appear in the drivers. No client system is read automatically yet; the truck schedule and occupancy feeds of Brief 3-5 can write `ForecastSignal` rows when they land.
3. Verified hours, not scheduled hours, are the truth the model learns from; scheduled hours would teach it the plan, not the demand.
4. Weeks are the company's week in the site's own zone, consistent with payroll and the season planner.

## 6. Open questions

- Which client feeds should write signals automatically (Fieldglass work orders, a truck schedule export, occupancy from a PMS)? Brief 3-5's adapters are the natural writers.
- Should the holiday table be per tenant (a hotel in another state has other peaks)? Today it is one Gulf Coast table.
- The planner takes a flat day/evening/overnight split from the site's current targets; a per-shift forecast would need hours by window, which the time entries can give once shifts carry a window label everywhere.
