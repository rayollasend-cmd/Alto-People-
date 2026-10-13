# Labor rules investigation: Brief 2-2, configurable labor rules

Investigation only (2026-10-13). No code, no schema, no migrations. Pay is sensitive: nothing here changes a computed amount until the owner approves the decisions in §8 and the golden-file gate in §6 is green.

## 1. Summary

1. **The labor rules are scattered, not absent.** There is one state table (`lib/stateLaborPolicy.ts`, 16 states plus a federal fallback, values anchored to 2024 law summaries) and at least eleven other places that hard-code "40 hours, 1.5×" on their own.
2. **Two engines disagree today.** The payroll engine (`lib/payrollAggregator.ts`) pays weekly overtime only. The payroll sheet (`lib/payrollSheet.ts`) applies the state's daily overtime. For a California day over 8 hours, the sheet says overtime and the pay run pays straight time. Alto HR works in Florida and Alabama, so this has not bitten, but it would on the first California placement.
3. **The rules read the wrong state.** Every labor rule except predictive scheduling looks up the associate's home `state`, not the state of the site where the hours were worked. Labor law follows the work location; tax withholding follows residence. The engine must key on the site.
4. **Five rule families the brief names do not exist at all:** minors' hours, meal and rest penalties as pay, minimum rest between shifts as law (only a 10-hour "clopen" advisory), predictive-scheduling premium pay (only a "reason required" check, at a single 14-day window), and city jurisdictions (NYC, Chicago).
5. **Recommendation:** one rules engine, `lib/laborRules/`, that every caller asks. Rule sets are versioned and effective-dated packs resolved in order: federal, then state, then city, then tenant, then site, with union parameters as tenant- or site-level overrides. The engine returns outcomes with a reason line for each one. The switch-over is gated on a golden-file test proving the Florida pack reproduces today's pay to the cent across real-shaped fixtures, and on a dry-run report over Alto's last closed periods. Seven steps, about 5 weeks. Twelve owner decisions in §8.

## 2. What exists

### 2.1 Rule sources

| Source | Where | What it holds |
|---|---|---|
| State policy table | `lib/stateLaborPolicy.ts:16-57` (shape), `:59-281` (table), `:284` `getLaborPolicy` | Per state: minimum wage, daily and weekly OT thresholds, meal minutes and trigger, rest minutes per hours, sick accrual per hour, a predictive-law flag, a split-shift flag. CA, NY, IL, MA, NJ, PA, WA, CO, AZ, GA, NC, VA, FL, AL, TX, OR, plus FEDERAL. One value per state, no dates, no city level, no multipliers (1.5× and 2× are implied elsewhere). |
| Client premium rules | `PremiumPayRule` (schema, `kind` PremiumPayKind: OVERTIME_DAILY, OVERTIME_WEEKLY, NIGHT/WEEKEND/SHIFT_DIFFERENTIAL, HOLIDAY, CALL_BACK, ON_CALL); applied at `lib/payrollAggregator.ts:622-700` | Per client: multiplier or add-per-hour, threshold, time window, day mask. Not effective-dated. HOLIDAY, CALL_BACK and ON_CALL are stored but never applied (`:625`). Client-keyed only, so a direct employer (no client) can hold none. |
| Company workweek | `OrgSetting.weekStartsOn` (default 6, Saturday) and `OrgSetting.timezone`; `lib/timeAnomalies.ts:254-266` (`startOfWeekUTC`, `startOfWeekForSite`) | The week overtime is counted in. Site zone decides which week an hour falls in. A singleton today (2-1 Migration C makes it per tenant). |
| Rate cards | `ShiftRateDefault` effective-dated via `lib/rateCards.ts` | Pay rates, not labor rules, but the effective-dating precedent (latest row on or before the day). |
| Holiday calendar | `routes/holiday117.ts`, `Holiday` model | Company and client holidays. Not read by pay. |
| Predictive scheduling | `lib/predictiveScheduling.ts:25` (`PREDICTIVE_NOTICE_WINDOW_HOURS = 14 * 24`), `:61` `evaluateShiftNotice`; used at `routes/scheduling.ts:2754-2801` | If the site's state has the predictive flag and a shift is published inside 14 days, a late-notice reason is required. No premium is computed or paid. |

### 2.2 Hard-coded copies of "40 hours, 1.5×"

| Place | Line | Use |
|---|---|---|
| `lib/payroll.ts` `splitWeeklyOvertime` | `:122-147` | **The pay engine's OT split.** Weekly 40, company week by site zone. No daily OT (comment at `:120`). |
| `lib/payrollAggregator.ts` | `:619`, `:888` | `overtimePay = OT hours × rate × 1.5`; the paystub line rate. |
| `lib/payrollSheet.ts` | `:107-135` | External payroll sheet: reads the state table, applies daily then weekly OT without double counting. **Disagrees with the pay engine for daily-OT states.** |
| `lib/clientStatement.ts` | `:139-217` | Bills the over-40 tail at 1.5× to the client. Week from `startOfWeekUTC` (company zone, not site zone). |
| `lib/associateEarnings.ts` | `:28-38`, `:275-296`, `:364` | The associate's "earned so far" and the OT unlock projection. |
| `lib/financeCockpit.ts` | `:295` | Wage estimate `min(40,h)·r + max(0,h−40)·r·1.5`. |
| `lib/executiveSummary.ts` | `:17`, `:124`, `:271` | OT minutes on the executive summary. |
| `routes/executive.ts` | `:402` | Same, on a route. |
| `routes/scheduling.ts` | `:674` (weekly exceed warning), `:1987` (live cost) | Scheduling's 40-hour warning and labor cost. |
| `lib/shiftReminder.ts` | `:413`, `:499` | The OT heads-up to managers. |
| `lib/transport.ts` (ride min-wage guard) | `:377-382` | Floor = regular × min wage + OT × min wage × 1.5, from `getLaborPolicy(taxState)`. |
| `lib/timeAnomalies.ts` | `:28`, `:44-64`, `:91` | Flags a short meal, daily OT, weekly OT, from the state table; a 30-minute federal "floor" that is not law. |

### 2.3 Other labor logic

- **Rest between shifts:** `routes/scheduling.ts:372` `REST_GAP_MIN_HOURS = 10`, an advisory confirm. Not a jurisdiction rule.
- **Sick leave accrual:** `lib/timeOffAccrual.ts:63` from the state table. In scope as a rule family the engine should own later; not named by the brief.
- **Minors:** none. `Associate.dob` exists (`schema.prisma`, Associate) and sits on the I-9 path; nothing reads it for hours.
- **Meal and rest premiums (CA one-hour penalty):** none. Breaks are recorded (`TimeEntry.breaks`, type MEAL or REST) and only flagged.
- **Which state:** `timeAnomalies` (`routes/time.ts:634`), `timeOffAccrual` (`:63`), `payrollSheet` (`lib/externalPayrollSheet.ts:169`) use the associate's home state. `predictiveScheduling` uses the site's. `Site` has `city`, `state`, `zip`, `timezone`.

### 2.4 Tests

`__tests__/lib/payroll.test.ts` (23 cases), `payrollSheet.test.ts` (7), `timeAnomalies.test.ts`, `predictiveScheduling.test.ts`, `associateEarnings.test.ts`, `routes/payrollOverhaul.test.ts`, `reconcilePayroll.test.ts` (the self-check reads the engine of today against finalized runs). None runs a fixed week through a named rule set.

## 3. Gaps against the brief

| Brief item | State today |
|---|---|
| Versioned, effective-dated rule sets | None. One undated value per state; client premium rules undated. |
| Per tenant and per site | Per state (global) and per client. No tenant or site layer; a direct employer cannot hold a premium rule. |
| Daily and weekly OT with multipliers | Weekly 40 and 1.5× hard-coded in the engine. Daily OT only on the payroll sheet and as a client premium; no 2× tier (CA 12h, 7th day). |
| Meal and rest, timing and penalties | Flags only; no penalty pay. |
| Minimum rest between shifts | 10h advisory, not a law parameter, no premium. |
| Minors' hours | None. |
| Predictive scheduling notice and premiums | 14-day reason check only; no premium; no city laws. |
| Union custom parameters | None. |
| Starter packs FL, AL, CA, NYC, Chicago, federal, with source and date | State table without sources; no city packs. |
| Evaluated at scheduling (warn or block) and at time calculation (apply) | Scheduling warns on 40h weekly only; time calculation applies weekly OT only. |
| Every outcome explainable | No reason lines. Paystub shows "Overtime" with hours and rate. |
| Fixed-week tests per pack | None. |

## 4. Design

### 4.1 Rule model

- **Rule families** (each a typed parameter block, validated by zod in `packages/shared`): `overtime` (weekly threshold, daily threshold, daily double-time threshold, seventh-day rule, multipliers, workweek reference), `meal` (trigger hours, minimum minutes, second meal, penalty hours, waiver allowed), `rest` (minutes per hours worked, penalty hours), `restBetweenShifts` (minimum hours, premium), `minors` (age bands, daily and weekly maximums, school-day limits, hour-of-day windows), `predictive` (notice days, change premiums by notice band, right-to-rest premium, good-faith estimate), `minimumWage` (rate, tipped credit if ever needed), `custom` (union parameters as named numbers and booleans the evaluators read).
- **Rule set** = a jurisdiction or owner + an effective date + a version + the family blocks it sets + `source` (citation URL or document) + `sourceDate` + `approvedBy`. A pack is a rule set with a jurisdiction (FEDERAL, US-FL, US-CA, US-NY-NYC, US-IL-CHICAGO).
- **Resolution** for an hour worked at a site on a day: federal → state of the site → city of the site → tenant override → site override. Each layer sets only what it names; the most specific wins per parameter; "more protective wins" is a per-family combiner where law requires it (for example the higher minimum wage). The resolved set is a value with a fingerprint, so an outcome records which versions produced it.
- **Storage:** `LaborRuleSet` (tenantId nullable for the shipped packs, defaulted per the 2-1 pattern for tenant rows; `jurisdiction`, `siteId` nullable, `effectiveFrom`, `version`, `params Json`, `source`, `sourceDate`, `status DRAFT|ACTIVE|RETIRED`, `approvedByUserId`). Partial unique indexes in the same migration: one ACTIVE version per (jurisdiction, effectiveFrom) for packs where tenantId IS NULL; one per (tenantId, siteId, effectiveFrom) where siteId IS NULL; one per (tenantId, siteId, effectiveFrom) where siteId IS NOT NULL; plus the duplicate-refused test. Shipped packs live in code (`packages/shared/src/laborPacks/`) and are seeded by migration, so a pack change is a reviewed commit with a citation.
- **Client premium rules stay.** `PremiumPayRule` is a contract, not law. The engine applies law first, then contract premiums on top, with the current stacking ("daily-OT premium can stack with weekly OT, in the employee's favour", `payrollAggregator.ts:626`) made an explicit parameter.

### 4.2 Evaluation

- `evaluateSchedule(shiftDraft, context)` → warnings and blocks with reasons (weekly or daily OT ahead, rest gap, minor limits, predictive notice and the premium it would owe). Default severity per rule is a parameter: warn, except minors' limits (block).
- `evaluateTime(entries, context)` → outcomes: hour buckets (regular, OT 1.5×, double time 2×), penalties (meal, rest, rest-between, predictive), each with a reason string, e.g. `Overtime applied: 42.00 h > 40 (weekly), US-FL 2026-01-01 v1`. The aggregator turns outcomes into earnings lines; the paystub prints the reasons.
- One engine, many callers: `splitWeeklyOvertime`, `payrollSheet`, `clientStatement`, `associateEarnings`, `financeCockpit`, `executiveSummary`, `routes/executive.ts`, `routes/scheduling.ts`, `shiftReminder`, the ride guard and `timeAnomalies` all call it. The estimators get the same answer as pay.
- Jurisdiction is the site's, from `Site.state`/`Site.city`. An entry without a site falls back to the associate's assigned site, then the tenant default, and the outcome says so.

### 4.3 Tenancy

Every tenant row carries `tenantId`; shipped packs have none and are read-only. A tenant override never changes another tenant's resolution (acceptance line 3, tested by seeding T2 with a different weekly threshold and asserting Alto's pay unchanged). The rules page is gated on `manage:org` writes and `view:payroll` reads (exec stays read-only).

## 5. Starter packs: what each must encode

Values below are the rules to encode, not values asserted here. Every number is **to confirm with counsel/owner** against the cited source before the pack is ACTIVE; each pack stores its citation and date.

| Pack | Rules to encode | Authoritative source to cite |
|---|---|---|
| Federal default | Weekly OT threshold and multiplier (FLSA); workweek = fixed 168-hour period; federal minimum wage; no daily OT; no meal or rest requirement; child labor hour limits for 14–15 year olds (school and non-school days, hour-of-day windows) and occupation limits | 29 U.S.C. §207 and §206; 29 CFR Part 778; 29 CFR Part 570; U.S. DOL Wage and Hour Division pages |
| Florida | State minimum wage schedule and its annual adjustment; federal OT; no state meal or rest; minors' hours under the Florida Child Labor Law (16–17 and 15-and-under limits, school-week limits) | Fla. Const. Art. X §24; Fla. Stat. §448.110; Fla. Stat. Chapter 450 Part I; Florida Department of Commerce minimum wage notice |
| Alabama | Federal minimum wage; federal OT; no state meal or rest for adults; Alabama Child Labor Law hours for minors (including the meal break for under-16s) | Ala. Code §25-8-30 et seq.; Alabama Department of Labor child labor pages |
| California | Daily OT and double time thresholds, seventh consecutive day rule, weekly OT; meal period timing, second meal, waiver conditions, one-hour premium; rest period per hours worked and one-hour premium; split-shift premium; reporting-time pay; state minimum wage; minors' hours | Cal. Lab. Code §510, §512, §226.7, §1182.12; IWC Wage Orders (e.g. Order 5 hospitality, Order 7 mercantile); DLSE pages; Cal. Lab. Code §1391 (minors) |
| New York City | NY State minimum wage for NYC; federal-style weekly OT (NY 12 NYCRR 142); NY spread-of-hours and call-in pay; NY meal periods (Lab. Law §162); **NYC Fair Workweek** for fast food and retail: advance schedule notice days, change premiums by notice band, clopening premium (fast food), retail on-call ban; minors | N.Y. Lab. Law §652, §162; 12 NYCRR Part 142 (and Part 146 hospitality); NYC Admin. Code Title 20, Chapter 12 (Fair Workweek); NYC DCWP pages |
| Chicago | Illinois minimum wage and Chicago's local rate; Illinois OT; Illinois One Day Rest in Seven Act meal and rest rules; **Chicago Fair Workweek**: covered industries and employer size, advance notice days, predictability pay by notice band, right to decline, rest between shifts premium | 820 ILCS 105 (Minimum Wage Law); 820 ILCS 140 (ODRISA); Chicago Municipal Code ch. 6-110 (Fair Workweek) and 6-105 (minimum wage); Chicago BACP rules |

Coverage note: NYC and Chicago Fair Workweek apply to covered industries and employer sizes. The pack carries the coverage test as parameters; whether Alto HR or a tenant is covered is a decision, not something the engine assumes.

## 6. Proving "reproduced exactly"

1. **Golden fixtures before any engine code changes.** Capture today's outputs for real-shaped weeks: the payroll aggregator (gross, regular, OT, premium lines), the payroll sheet, the client statement, associate earnings. Fixtures cover Saturday-start weeks, overnight Friday shifts, a Central site, breaks, client premium rules (daily OT, night differential), salaried staff, the ride guard, and a re-aggregate of a past run. Stored as JSON in `__tests__/laborRules/golden/`.
2. **Golden test in CI:** the engine with the Florida pack (and Alabama for the Alabama sites) must produce byte-identical results for every fixture. Any difference fails the build with the diff.
3. **Dry-run report over production periods:** a read-only script (pattern of `scripts/reconcile-payroll.ts --self-check`) recomputes the last closed periods under the engine and lists every cent of difference by associate and reason. Zero differences for Florida and Alabama is the gate for switching pay to the engine. The owner signs the report.
4. **Never silently:** the engine runs in shadow first (computes next to today's code, logs differences, pays from today's code). The switch is a per-tenant setting with a named approver and an audit row. Finalized runs are never recomputed; an amended run uses the rule version effective on each work date.
5. **Known divergence to surface, not hide:** the daily-OT disagreement between the pay engine and the payroll sheet (§1.2). The dry run lists any past work in a daily-OT state; the decision on whether anything is owed is the owner's (§8, decision 4).

## 7. Plan

| Step | Content | Size |
|---|---|---|
| 0. Golden capture | Fixtures and the golden test against today's code; the shadow-diff harness. No behaviour change. | 3 days |
| 1. Engine core | `lib/laborRules/` with the rule families, resolution, outcomes with reasons; FEDERAL and FL and AL packs in code; unit tests per family. Not wired to pay. | 1 week |
| 2. Storage and packs | `LaborRuleSet` migration (tenantId, partial unique indexes, duplicate-refused test), pack seeding, effective-date resolution, a read-only Rules page listing the active set per site with citations | 4 days |
| 3. Shadow | Every caller in §2.2 computes through the engine beside today's code; differences logged and on the Rules page; dry-run script over production periods | 4 days |
| 4. Switch pay (per tenant) | Golden green + dry run zero for Alto → owner approves → pay, sheet, statements, estimators read the engine. Jurisdiction moves to the site. | 3 days |
| 5. CA, NYC, Chicago packs and penalties | Meal, rest, rest-between, predictive premiums, minors; scheduling warn/block; fixed-week tests (CA daily OT and meal penalty acceptance); each pack ACTIVE only after counsel sign-off | 1.5 weeks |
| 6. Tenant and site overrides | Override editor (manage:org), union custom parameters, the cross-tenant test (changing T2's rule leaves Alto's pay unchanged), audit on every rule change | 4 days |

About 5 weeks. Steps 0–4 change nothing for Alto HR's pay by construction; step 5 is new rules that only apply where a tenant has sites in those jurisdictions.

## 8. Owner decisions

1. **Jurisdiction comes from the work site, not the home address.** Recommendation: yes. Home state stays for tax withholding only. Changes results only where home and site states differ; the dry run shows them first.
2. **One engine for pay and every estimate.** All twelve copies in §2.2 call the engine, including the executive and cockpit estimates. Recommendation: yes, so the screens never disagree with the check.
3. **Shipped packs in code, seeded by migration, with citations; tenant and site overrides in the database.** Recommendation: yes; a pack change is a reviewed commit.
4. **The existing daily-OT disagreement.** If the dry run finds past hours in a daily-OT state paid at straight time: recommendation, report them with amounts to the owner and counsel; the engine does not back-pay on its own.
5. **Shadow before switch, per tenant, with a named approver.** Recommendation: yes; the switch is a tenant setting with an audit row.
6. **Client premium rules stay a separate contract layer on top of law**, with today's stacking made an explicit parameter. Recommendation: yes.
7. **Severity defaults at scheduling:** warn for OT, rest gap and predictive notice; block for minors' limits. Recommendation: yes, each overridable per tenant except the minors' block.
8. **Penalty pay is applied automatically** (CA meal and rest premiums, predictive change premiums) from break and schedule records, with a documented waiver path. Recommendation: yes, after counsel signs the CA and city packs; until then they compute and display but do not pay.
9. **Minors:** use `Associate.dob` to derive the age band on each work date; no new sensitive field. Recommendation: yes; the dob stays where it is and only the derived band is used by the engine.
10. **Pack activation needs counsel sign-off**, recorded on the rule set (`approvedBy`, source, date). Recommendation: yes; the engine refuses to apply a DRAFT pack to pay.
11. **Holiday premiums and call-back / on-call** (stored on client rules, never applied): recommendation, out of 2-2 scope; they need a trigger source and a separate decision.
12. **Sick-leave accrual moves into the engine later**, after 2-2 acceptance. Recommendation: yes, a follow-up; not named by the brief.

## 9. Risks

- **Silent pay change.** Mitigated by golden fixtures, shadow mode, a signed dry run, and per-tenant switch with an audit row.
- **Legal values wrong.** Values in today's table come from 2024 summaries; packs must be re-verified against current sources. Mitigated by citation, date and counsel sign-off per pack, and the DRAFT/ACTIVE gate.
- **Jurisdiction change surprises.** Moving from home state to site state changes OT for cross-border workers. The dry run lists every affected associate before the switch.
- **Workweek still a singleton.** `OrgSetting.weekStartsOn` is platform-wide until 2-1 Migration C; a second tenant with a different week waits on it. The engine reads the workweek through one function so the change is local.
- **Client statement week.** `clientStatement.ts` counts the week in the company zone, payroll in the site zone; the engine makes billing and pay agree, which may move a few minutes between weeks on statements. Surfaced in the shadow diff.
- **Performance.** Resolution per entry per day; cache the resolved set by (tenant, site, date) with the fingerprint.

## 10. Acceptance mapping

| Acceptance line | How it is shown |
|---|---|
| Alto HR's current pay results reproduced exactly under the Florida pack | Golden test (§6.2) green in CI and the signed dry run over the last closed periods with zero differences (§6.3) |
| A California test week produces the expected daily-OT and meal-penalty outcomes | Fixed-week test in step 5: a week with a 10-hour day, a 13-hour day, a seventh consecutive day and a late meal, expected buckets and premiums written in the test with each reason line, values confirmed by counsel |
| Changing a rule for one tenant does not affect another | Step 6 test: T2's weekly threshold changed, Alto's pay for the same fixtures unchanged, and the cross-tenant suite covers the Rules routes |

## Owner approval

**Approved 2026-10-13: every decision in this report, as recommended.** Building proceeds step by step in the order of the plan; each step lands with its tests and is reported before the next.
