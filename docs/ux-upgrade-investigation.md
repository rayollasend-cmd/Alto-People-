# UX upgrade investigation: a Fortune 500 product, premium for every user

Reported 2026-10-15. The owner's direction, same day: "it should be polished and remember this is a Fortune 500 company. All users should feel premium." The standard set on 2026-10-13 stands: surpass Workday, do not match it.

## 1. Summary

The product works and is tested (295 API test files, 146 web, three browser suites), and it carries three things no competitor has on screen: a hash-chained audit trail with an automated-decision record, agents that propose while people decide, and one roster for people, agents and robots. The interface does not yet say any of that. It says how the product was built: 93 modules in a seven-group menu, 23 admin surfaces that each landed as a tab or panel on whichever page the brief touched, twelve different page-title styles, 173 hand-written "nothing yet" messages beside 54 proper empty states, and light mode held together by 400 lines of class overrides. Nothing is broken. It is unfinished in the way a house is unfinished the day the last trade leaves: everything is in, and nothing has been brought together.

The upgrade is five moves, in order: a written design system with page templates (the thing that makes the other four cheap), role homes that put decisions before menus, one Settings & Trust area, a Trust Center, and the hybrid roster as the center of gravity; then a sweep that brings all 93 modules onto the templates. Each lands as a brief with acceptance, measured with the product analytics the app already collects.

## 2. What exists

| Area | State | Where |
|---|---|---|
| Tokens and themes | Brand-named tokens (navy, gold, silver, steel, teal, alert, success, warning, muted) in dark and light; charts have their own three steps; elevation ladder `elev-1/2/3`; motion keyframes; `coarse:`/`fine:`/`standalone:` variants; a compact density mode. Light mode works by overriding `.text-white`, `.bg-navy` and friends in `index.css` (about lines 275–660): `text-fg` is used 0 times, `text-white` 1,643 times. | `apps/web/src/index.css`, `tailwind.config.js`, `src/lib/theme.tsx` |
| Type | Geist Variable for text, Cormorant Garamond Variable for display; custom sizes 3xs/2xs/xs2 and hero/hero-lg | `src/main.tsx`, `tailwind.config.js` |
| UI kit | 34 components with a stated purpose each (DataGrid "the one way a list of records is shown", PageHeader "every page uses this", FilterBar "the single canonical filter row"); the 44-px touch floor and 16-px inputs are enforced in Button, Select, Tabs, SegmentedControl, DropdownMenu and by lint | `src/components/ui/*`, `eslint.config.js` |
| Shell | Sidebar with core, pinned, recent and seven collapsible groups; Topbar with search, scope bar, bell, help, role switch; BottomTabBar with four tabs per role; command palette (no recents); coachmarks; What's new | `src/components/Layout.tsx`, `Sidebar.tsx`, `Topbar.tsx`, `BottomTabBar.tsx` |
| Navigation model | 93 modules in `modules.ts`: core 12, workforce-management 37, operations 2, compliance 11, payroll-finance 14, client-services 4, platform 13; hidden by capability, tenant module switch, platform-only flag and a curated list per role; labels renamed per tenant | `src/lib/modules.ts` |
| Role homes | Thirteen dashboards chosen by role at `/`: associate (hero = my shift), manager, supervisor (my floor), executive (margin), portal store and region (floor vs contracted), finance (payday), workforce (store board), recruiter, driver, transportation director, admin (greeting, decision queue, plan, KPIs) | `src/pages/Dashboard.tsx` and the `*Dashboard.tsx` files |
| Decision surfaces | RoleDecisionQueue on four homes, Approvals, the relay board with batons, desks (compliance, verifier), agent approval queue, support inbox | `src/pages/approvals`, `relay`, `agents` |
| Admin and trust surfaces | Users & access (Accounts, Access report, Roles & permissions), Sign-in (OIDC, SAML, domains, SCIM), Organization profile, Billing, Compliance evidence (with Access review and Security contact), Audit (with Integrity: chain, retention, SIEM, full export), Agents (gates, decision record, catalog, MCP preview), Workers, Developers, Integrations, Reliability, Product analytics, Support and the platform inbox, Labor rules | `src/pages/admin/*`, `audit`, `agents`, `developers`, `payroll/LaborRulesPage` |
| Phone | BottomTabBar in flow, sheets with drag handle and pinned footer, Back closes overlays, pull to refresh, haptics, safe areas, EN/ES/TR | `src/components/ui/Dialog.tsx`, `src/lib/haptics.ts`, `useOverlayBackButton` |
| Quality gates | Token contrast test, axe sweep, overflow guard, grid-layout guard, size budget (main 189.7/209 KB after the schema change today), lint rules against raw selects, textareas, hand-rolled gold buttons and `toLocaleDateString` | `src/__tests__/a11y`, `e2e/*`, `size-budget.json` |
| Screenshot walks | `visual-walk`, `polish-walk`, `tablet-shots` (associate and admin, a few routes) and now `design-walk` (every seeded persona, every surface, desktop and phone, dark and light), all needing the full stack; run in GitHub Actions by `design-walk.yml`, PNGs as the artifact | `apps/web/e2e/design-walk.spec.ts`, `.github/workflows/design-walk.yml` |
| Design documentation | None. No design-system document, no Storybook, no page templates written down. The rules live in component comments, lint, tests and this repository's memory. | — |

## 3. What a Fortune 500 buyer and a stockroom associate both notice

Counted across the 284 page files on 2026-10-15.

1. **Titles.** Twelve distinct `<h1>` class strings in 21 files; the admin home uses display 3xl, the executive home `text-xl font-semibold` with the email's local part as the name, the associate home has no h1. Forty-two distinct `<h2>` styles; SectionTitle, the intended standard, is used in four files.
2. **Empty states.** 173 ad-hoc "No … yet" strings in 113 files; EmptyState (icon, title, description, action) in 54.
3. **Errors.** ErrorBanner in 149 files, QueryError in 38, split even between sibling admin pages.
4. **Badges.** Badge in 163 files and 22 hand-rolled pills beside it.
5. **Micro-labels.** `tracking-wider` 239 times, `tracking-widest` 178.
6. **Colour.** 73 inline hex values in 15 files (ProductAnalytics 16, LiveMap 10, SeasonPlanner 6, Avatar 6). Light mode depends on overrides because the tokens are named for the dark brand, not for their job.
7. **Radii.** `rounded-md` 483, `rounded` 263, `rounded-lg` 223, plus xl and 2xl.
8. **Terms.** 148 literal "Associate(s)", 86 "Client(s)", 29 "Store(s)" in pages while `useTerm` is called in 23 files; the BottomTabBar mixes translated keys and raw English.
9. **Icons.** The executive's tabs: Analytics is a dollar sign, Clients a calendar, Compliance a timer.
10. **Where things are.** Roles & permissions, the Access report, Security contact, Access review, Integrity, Gates, the Decision record and the MCP preview are each a tab or panel inside another page. An IT admin evaluating us finds trust features by accident.
11. **The menu.** 37 of 93 modules sit under one group. The command palette has no recents. Nothing on any home says "these three things need you"; the decision queue is one card among eight.
12. **The roster.** People, agents and robots are three places (`/people`, `/agents`, `/workers`), and `/workers` is hidden unless the robotics module is on.

Screenshots of every persona and surface, desktop and phone, dark and light, are produced by the design walk (section 2); the findings from the first run are added below when it completes.

### 3.1 From the screenshots

First run 2026-10-15 (run 38745262700, 197 screenshots, 12 personas, desktop and phone, EN/ES/TR):

- **Both themes rendered light.** The app follows the system theme and a CI browser reports light, so "dark" and "light" were identical. The walk now names its theme outright; dark mode is reviewed on the second run.
- **The coachmark tour and "New this week" sat over every screen** of every fresh account, including the associate's. The walk dismisses them; the product question (should a brand-new account see both at once, on a phone, on day one?) goes to the sweep.
- **A real bug:** the manager home showed "Malformed identifier." A manager without an associate link put the literal `__none__` into a UUID column in `teamScope`; reimbursements had the same pattern. Fixed (empty `in`).
- **Greetings from email addresses:** the workforce and finance homes greeted "workforce" and "finance", the executive home the raw local part. One helper now rules every home.
- **The login page said "Alto HR" three times** on a product called Alto People ("Use your Alto HR credentials", "Secured by Alto HR"); tenant-neutral now. The legal line stays.
- **What already reads premium:** the associate's pay ("Next payday · Fri, Oct 16 · for work Sep 26–Oct 9"), schedule (the late-shift hero with the kiosk hint and the teammate on with you), the portal's floor-vs-contracted hero, the supervisor's "On the floor now 0 / 8", the Users › Roles & permissions matrix, the Sign-in page. The display serif on titles is consistent across every role.
- **What the sweep must fix first:** the sidebar's Workforce Management group lists up to 37 entries expanded by default (every admin, workforce and finance screenshot scrolls it); the audit Integrity panel's retention and archive lines wrapped into one row (fixed); the executive home's small `text-xl` title (now the shared hero header); the driver home stacks two warning banners before the first useful line; the "Dev seed" line on the login page is development-only but reads as production copy to a reviewer.
- **Step 0's second half**, the per-module score table, is kept in `apps/web/design-baseline.json` (the design lint's per-file counts) rather than a hand-written table: 1,596 `text-white`, 160 raw headings, 58 inline hex, 38 pills, 39 bare empty strings, 4 "Loading…" at the start; the count only falls.

Second run 2026-10-15 (run 38754830554, 197 screenshots, the theme named outright):

- **Both themes render as named now**; the light theme holds on every walked surface, and Hugo's seat sits beside the admin home as designed.
- **For the sweep:** the admin home's Workforce snapshot tiles clip their sparkline captions ("— hires vs la…") at desktop width inside the two-thirds column; the supervisor's phone header spent a full row on three buttons before the first useful line (fixed in slice 1: one primary action in the header, the rest as ways in at the foot); the driver's two stacked warnings (fixed in slice 1: one banner).

## 4. Competitors

- **Workday.** Reviewers describe the interface as confusing and unintuitive, with complicated navigation, a steep learning curve and updates that add complexity; a 2026 Change Job redesign was needed because the old flow was "an unnecessary start page, then a seemingly endless series of fields" (sources below). Its Agent System of Record (Rising 2025, general availability 2026) is a governance console for agents: identity, roles, permissions, oversight, with Entra Agent ID integration. That is the direct competitor to our registry, gates and decision record. Workday shows governance as configuration; we can show it as evidence.
- **Rippling.** Rated 4.8 against Workday's 4.1 on G2; reviewers name intuitive navigation, ease of setup (9.3 vs 8.3) and an app "designed for employees." Its model is one record, one system, clean screens. It has no frontline, multilingual or agent story.
- **UKG Pro.** 4.3 on Capterra; the employee app is praised for one dashboard for pay and time off and criticised for glitches, a mobile experience that lags desktop and hard-to-find menus.
- **Deel.** Consistently positive on the employee app: tabs that make modules easy to find, fast payments. No shift or clock-in depth.
- **Gusto Wallet.** Pay, early access and savings in one app; clock-in sits inside the wallet. Vendor-authored material only.
- **What "premium" means in the products people name** (Linear, Stripe, Vercel): restraint in colour with one accent used as punctuation, typography as the brand, density that respects the power user, crafted micro-states (hover, focus, disabled, loading), and responsiveness. The consensus is that what can be copied is the process, not the hex values.
- **Trust centers** (Vanta, Drata, Slack as the model): badges with expiry dates, live control status, sub-processors, gated downloads, progressive disclosure, a hybrid public/gated access model, and subscription to changes. None shows a verifiable audit chain; ours can.

The field to win is the one Rippling and Workday do not serve well: the frontline worker on a phone in three languages, the supervisor on a floor, and a buyer who needs to trust agents acting in payroll and compliance.

## 5. Design

### 5.1 Principles (the ones we test for)

1. **The system does the work; the person sees decisions.** Every home opens with what needs that person today, drawn from the queues and desks that exist. Navigation is how you get elsewhere, never the first thing you read.
2. **Premium for every user.** The associate's phone screens are designed to the same standard as the executive's board pack: the same type, spacing, motion and care. No plainer tier.
3. **Restraint.** Gold is the brand's punctuation, not a fill. One hero per surface. Money in the heavy sans, never the display serif. Secondary data behind Details. (These rules exist; they become the written standard.)
4. **Trust you can see.** Evidence, chain status, decision records and gates are first-class surfaces with their own home, not panels.
5. **One language.** Tenant terms, EN/ES/TR, icons that mean what their labels say, one word for one thing across the product.
6. **Nothing hand-rolled twice.** A pattern used on two pages becomes a component with a documented state set (empty, loading, error, disabled, offline).

### 5.2 The design system (built first)

A document and a code package, both in the repository, both tested:

- **Tokens by job, not by brand.** `surface`, `surface-raised`, `text`, `text-muted`, `border`, `accent`, `accent-on`, `positive`, `caution`, `negative`, `info`, mapped from the brand palette in both themes, so light mode stops needing overrides. Brand names stay as aliases while pages are migrated; a lint rule retires `text-white` on new code.
- **Type scale.** Six sizes with jobs (hero, title, section, body, caption, micro), one display face for titles and greetings only, tabular numerals for money and time.
- **Spacing, radius, elevation, motion.** One radius ladder (sm, md, lg), the existing elevation ladder, duration and easing tokens, reduced-motion honoured everywhere.
- **Page templates (five).** Home (hero, decisions, changes, ways in), List (FilterBar + DataGrid + Drawer), Record (header, tabs, timeline), Settings (left rail, sections, status), Desk (queue, item, action, closure). Every page names its template in a comment; the walk screenshots are grouped by template so a reviewer compares like with like.
- **Component states.** Every component documents and renders its states; EmptyState, QueryError, Skeleton and Badge become mandatory through lint where a hand-rolled version is found.
- **Iconography.** One set, one weight, a table of icon-to-meaning so a dollar sign is never Analytics.
- **Voice.** The copy rules already followed (short sentences, specifics, the tenant's words, no jargon, three languages) written down with examples.
- **Published.** As a Markdown document in `docs/design-system.md` and as a living page in the app for designers and engineers (behind `view:product-analytics`), rendered from the same tokens so it cannot drift.

### 5.3 Role homes

Six homes replace the thirteen dashboards' independent structures while keeping each hero that already earns its place:

| Person | Opens with | Then |
|---|---|---|
| Associate (phone first) | The shift (on the clock, late, next, none) and this week's pay estimate | Things that need me (documents, acknowledgements, rides to confirm), my week, Hugo |
| Supervisor | My floor against the line, right now | Decisions (approvals, swaps, no-shows, agent proposals), today shift by shift, the next seven days |
| HR / operations admin | Today's decisions: approvals, desk items, agent proposals, alerts, counted and ranked | What changed since yesterday, the pipelines, ways in |
| Client manager (portal) | The floor against the contracted line, hour by hour | Requests, schedule, history, the Message button |
| Executive | Margin and its week-over-week change | Decision queue, the board pack, the pulse, the charts |
| IT / compliance admin | Trust status: chain verified, controls passing, sign-ins healthy, agents certified | Settings & Trust rail |

Hugo sits in the same place on every home, offered only what is on for that tenant and role. Navigation collapses to the six Products as groups, with search and recents in the palette and the sidebar; the 93 modules remain as destinations reached from a decision or a search.

### 5.4 Settings & Trust

One area with a left rail and one page template:

Organization · Sites and org units · Users & access · Roles & permissions · Sign-in & provisioning (OIDC, SAML, domains, SCIM, groups) · Audit & integrity (viewer, chain, retention, archive, SIEM, export) · Security & compliance (evidence, controls, access review, security contact, dependency scan, backups) · Agents & gates (registry, gates, decision record, certification, MCP) · Billing · Developers & integrations · Branding & terminology.

Every page in it shows status the same way (a badge with the last check and its time), has the same header, the same two-column layout, and the same place for danger. Nothing moves in the API; this is routing and templates.

### 5.5 Trust Center

One page in two variants, built from data the app already collects:

- **In-app (IT/compliance admin):** chain verified at a time, with the head; the daily controls and their last result; the quarterly access review; agents and their certification; the decision record count and its last counsel review; retention and archives; sinks delivering.
- **Public (prospects, gated downloads):** what we are (the positioning), the controls and their status, SOC 2 progress, sub-processors, data residency and retention, responsible-AI commitments (the gates and the decision record), the security contact, and a subscription to changes. Downloads behind a request.

### 5.6 The roster

`/people`, `/agents` and `/workers` become views of one roster: every worker (person, agent, robot) with type, owner, status, site, capabilities and scorecard; filters by type; the record page's tabs differ by type (a person's employment and pay; an agent's gates, decision record and certification). The Agents page keeps its registration flow and controls as the agent record's tabs. Hidden-by-module stays for robots until Phase 3 ships them.

### 5.7 The sweep

Every one of the 93 modules is scored against its template (title, header, filter row, grid, drawer, empty, loading, error, mobile, terms, icons, light theme) in a table kept in the repository; a module is brought in line when touched or in the sweep, the score moves, and the walk screenshots are the proof.

## 6. Measurement

Product analytics already collects route usage, errors and web vitals. Add three events and read them before and after each step: time from sign-in to the first decision taken (approve, assign, acknowledge), decisions per session by role, and searches that end on a settings page (a proxy for "I could not find it"). Axe, the overflow guard, the contrast test and the size budget remain gates; the walk runs on every design brief.

## 7. Rollout

| Step | Content | Size |
|---|---|---|
| 0. Walk and score | Run the design walk; read every screenshot; fill section 3.1; score the 93 modules against the templates | 2 days |
| 1. Design system | Tokens by job with aliases, type and spacing scales, five templates, component states, icon table, voice; `docs/design-system.md` and the in-app page; lint for `text-white`, hand-rolled pills and empty text on new code | 1.5 weeks |
| 2. Role homes | The six homes on the Home template; Products as groups; recents in palette and sidebar; the decision strip from the existing queues | 2 weeks |
| 3. Settings & Trust | The area, the rail, the Settings template; eleven pages moved by routing; status badges unified | 1 week |
| 4. Trust Center | In-app and public variants from existing data; gated downloads; subscription | 1 week |
| 5. The roster | One worker list and record with type-specific tabs; `/agents` and `/workers` as views | 1 week |
| 6. The sweep | The 93 modules onto the templates, highest-traffic first by product analytics; empty, loading and error states; terms; icons | 3 weeks, in slices |

Each step: tests, the walk, acceptance reported before the next.

**Step 6, slice 1 (2026-10-15): the homes still on their own order.** The supervisor, executive and driver homes moved onto the Home template. Supervisor: the greeting is the title, the place with its client and address the subtitle, the live "as of" the meta line, the shift banner the interrupt, the floor the hero, the decision queue "Needs you", the four KPI tiles and the day's cards beneath, the five links the supervisor works from as ways in. Executive: the margin story is the hero, the chairman's queue "Needs you" (counted), the week's narrative "what changed", the board pack the one action. Driver: the run that defines the day is the hero (on the road, else next up, else the last finished, else the empty day), seat requests "Needs you" (counted), and ONE setup banner where the walk found two. Shared: one `greetingFor` helper replaces four page copies; the template's aside takes its column only when Hugo rendered something (`:has(aside:not(:empty))`); the two queue cards can run headless under the template's section title. The lint baseline fell (`text-white` 1,591 → 1,585, raw headings 157 → 152). Proof: the web unit suite (973 tests) and the third walk.

**Step 6, slice 2 (2026-10-15): the last three internal homes, and one greeting in three languages.** Recruiter: today's interviews are the hero, the recruiter's own queue "Waiting on you" (counted, headless under the template's title), the pipeline's doors as ways in. Workforce: the instrument row is the hero, the decision queue "Needs you", the board beneath, the six doors as ways in. Finance: payday is the hero, what needs finance today "Needs you" (counted), the four numbers and the rest beneath. The greeting is one localized helper now (`useGreeting`, keys `home.greet*` in EN/ES/TR): the driver, supervisor and workforce homes greeted in English only on surfaces a Spanish- or Turkish-speaking person opens, and two homes drew the afternoon boundary differently. The admin home's Workforce snapshot tiles go two across until xl and let their captions wrap (the second walk's clipping). Baseline: `text-white` 1,585 → 1,580, raw headings 152 → 147. Still on their own order: the transport director's desk (a Desk, not a Home), the portal's store and region homes (next slice, with the portal doctrine).

**Step 6, slice 3 (2026-10-15): the first lists on the List template.** The people directory, onboarding applications and Fieldglass timesheets declare the template (`data-template="list"`): the header, the summary strip, the one filter row, the grid and the drawer are the template's slots now, and nothing moved on screen. Third walk (slice 1 on main, run 38759893348): the supervisor home reads as designed on desktop and phone (banner, greeting, place, the floor, "Needs you", the tiles, ways in at the foot); the driver's phone shows one setup banner above the greeting and the empty day as the hero. One fix from it: the supervisor's four KPI tiles squeezed four-across in the template's main column, so they go two across until xl like the admin's.

Fourth and fifth walks (slices 2 and 3 on main, runs 38761596161 and 38762874711): the recruiter, workforce and finance homes read as designed (greeting, hero, "Needs you" counted, Hugo's seat); the people directory, onboarding and timesheets lists are unchanged on screen. Two fixes: the recruiter's "New applicants" card stretched to the aside's row height (`h-full` inside the template's column), and the finance KPI tiles clipped their captions four-across (two until xl now). Rule for the sweep: inside a Home's main column, a four-tile strip is `xl:grid-cols-4`, and no card carries `h-full` unless it sits in its own grid row.

**Step 6, slices 4–7 (2026-10-15, owner: "do it all").**
- *Slice 4, the approvals desk.* The approvals page is a Desk (§4.5): the five queues (walk-ins, time off, swaps, pickups, not-confirmed) and the timesheets link are the queue column with their counts; the open queue's panel, with its rows, bulk bar and decisions, is the item. Desktop opens the first queue with work by itself; a phone shows the queue list and a tap opens the worklist over it with an "All queues" way back. Notification deep links open the right queue before its panel mounts. An empty open queue says so.
- *Slice 5, the portal homes.* The client's store site and the region command center are on the Home template. Both title the place, not the person: the store (or region) is the identity a client signs into. The floor against the contracted line is the hero; the push prompt is the interrupting banner; the service report and history are the ways in.
- *Slice 6, the tabbed views.* Time & attendance, Payroll and Scheduling declare the List template: hero/KPI strips as the summary, the tabs as the page's lists with their own filter rows, the entry or run drawer in the drawer slot; Scheduling keeps its print-only header (the template's header takes `no-print`). Nothing moved on screen.
- *Slice 7, the long tail.* A codemod (`apps/web/scripts/list-template-codemod.mjs`) declared the List template on 77 pages shaped header-then-content (a pull-to-refresh indicator may precede the header): the root becomes `ListTemplate`, the header's props become the template's, everything else stays as children. Honest limits: these pages keep their drawers and dialogs as children rather than in the drawer slot, and three pages are still to be done by hand (the payroll year-to-date print page, the onboarding analytics board with its back link, and the module placeholder). Excluded on purpose: Settings & Trust pages (Settings template), the relay, store-ops, HR-case, support, compliance and transport desks (Desk candidates), the kiosk, messages, and the client record (a Record).
- *Slices 8–9, by hand.* The three codemod leftovers (payroll year-to-date keeps its print area; onboarding analytics trades its back link for a breadcrumb; the module placeholder keeps its centering) and six excluded pages whose shape is in fact a list with tabs (the relay, support, HR cases, the compliance home, kiosk admin, the transport director's board) declare the List template. The client record is the first page on the Record template (§4.3): the client's nine section cards became tabs, `?section=<key>` is the open tab (the QuickBooks OAuth return still lands on its tab), and the statements tab appears only for payroll holders.
- *Slice 10.* The portal's candidates, store-ops, requests and schedule pages, the OSHA/WC/EEO home, the platform support inbox and the associate's rides page declare the List template (codemod by name). The portal's today and history pages and the store-ops checklist followed once the codemod accepted an expression class and a comment above the header. Still on their own layout: the messages page (a fixed-height chat layout); the trust pages and the design-system page declare their template themselves; the Settings & Trust pages sit inside the Settings template through their area layout.
- *Slice 12, the approvals desk's queue column.* The six queues were chart-kit stat tiles stacked in a column, each a big number over a caption, and the not-confirmed tile showed "48h" as if it were a count. They are queue rows now: the queue's name with its one-line state beneath, the count on the right (red when the queue is urgent), a bell where the not-confirmed queue has no count, the failed-timesheets fallback in the same frame. Nothing else on the desk moved.

**The premium sweep (2026-10-15, owner: "fix it all as an expert").** What the twelfth walk still showed a buyer, fixed in the order a buyer meets it.
- *Leakage (10108cf5).* No mode names, code paths, environment variables, hard-coded clients or version strings on a screen: Payroll's "STUB MODE" banner became one calm line and the full health tile moved to Settings & Trust › Integrations as the first Connection; built-in agents carry product model names and the boot sweep renames rows written earlier; the roster labels catalog capabilities by name; the scorecard is "Contract compliance scorecard" for the client in scope, names no vendor, and open critical actions cost five points each so it never reads 100 / A beside a red row; the sign-in family carries a copyright line, not v0.1.0.
- *One interrupt per screen (cd1bf9bb).* The admin home drops its day-one Welcome card and the second "caught up" card; the date and company clock read in sentence case with the role chip as the row's one chip. The associate home makes an unfinished checklist the hero with the shift beneath it. Recent never lists the page a person is on. A store where no shift has ended has no grade yet. The shift row's status badge takes its own row on a phone.
- *Control density (b377a103).* Scheduling: Export · Templates · New shift in the header, the timezone note on the filter row's scope line, the list's date range on that same row (three rows where there were six). Payroll: New run, Financial changes while it carries work, the seven rooms behind More.
- *The demo tenant.* `DEMO_DATA=1 npm -w apps/api run seed:demo` (apps/api/scripts/seed-demo.ts, the pure parts in lib/demoSeed.ts with a seeded PRNG and a test): a third client, six more stores, sixty associates in three languages, a year of shifts and punches, ten disbursed payroll runs, open approvals, cases, incidents, candidates, agent proposals and store messages, anchored on today and idempotent. The design walk runs it after the base seed; CI's E2E job never does, so the suite is unchanged.
- *Accessibility and status.* The axe sweep covers every walk persona in dark (and admin and associate in light) at WCAG 2.2 AA, fails on serious or critical, and runs as its own CI job (`a11y`, `A11Y_SWEEP=1`) with an allowlist that starts empty; a public /accessibility statement. A public /status page (API `/status/public`, rate-limited and cached) derives each component's state from the reliability rollup, with incidents posted from the Reliability page; linked from the Trust Center and the sign-in footer.

## 8. Risks

1. **A repaint without a restructure.** Mitigation: steps 2 to 5 change where things are; step 1 changes what they look like; neither ships alone.
2. **Breaking muscle memory.** Admins know where things are today. Mitigation: old routes redirect, the palette finds everything, "What's new" explains each move, pins survive.
3. **Bundle budget.** New shells cost bytes. Mitigation: the schema change today freed 19 KB of the main chunk; templates are shared code, so a sweep should shrink pages, not grow them; the budget stays a gate.
4. **Light mode migration.** Retiring the overrides page by page risks a half-themed screen. Mitigation: aliases keep the old classes working; the walk shoots light mode on every step.
5. **Terms and languages.** Every moved string must stay translated and termized. Mitigation: the i18n lint and the ES/TR walk screens.
6. **Scope.** 93 modules invite a never-ending sweep. Mitigation: the score table and traffic ranking decide the order; the sweep is sliced and each slice is a brief.

## 9. Owner decisions

1. **Order: design system first, then homes, Settings & Trust, Trust Center, roster, sweep.** Recommendation: yes; the system makes every later step cheaper and keeps 93 modules from drifting again.
2. **Tokens by job, brand names kept as aliases during migration.** Recommendation: yes; it is what fixes light mode for good.
3. **Products as the navigation groups (six), modules reached from decisions and search.** Recommendation: yes; it is the taxonomy the owner set on 2026-10-13.
4. **One Settings & Trust area; old routes redirect.** Recommendation: yes.
5. **A public Trust Center with gated downloads.** Recommendation: yes, with the owner approving the public text and the sub-processor list before it goes live.
6. **One roster for people, agents and robots, with `/agents` kept as a view.** Recommendation: yes.
7. **Measure with three new product-analytics events.** Recommendation: yes.
8. **The display serif stays for titles and greetings only; gold stays the single accent.** Recommendation: yes; both are the brand, and restraint is what reads as premium.

## 10. Acceptance mapping

| Standard | Proven by |
|---|---|
| Every user feels premium | The walk: every persona, desktop and phone, dark and light, EN/ES/TR, reviewed against the templates; zero ad-hoc empty, loading or error states on walked screens; axe and contrast clean |
| Decisions before menus | Time to first decision and decisions per session improve for admin, supervisor and manager after step 2 |
| Trust you can see | Settings & Trust and the Trust Center render chain, controls, review, agents and retention from live data; a prospect can be sent the public page |
| One roster | A person, an agent and a robot appear in one list with owner and status; the agent's gates and decision record are its tabs |
| Nothing drifts again | `docs/design-system.md` and the in-app page exist; lint fails new `text-white`, hand-rolled pills and empty text; every page names its template |

## Owner approval

**Approved 2026-10-15, every decision as recommended** ("go ahead … build it"), with the standard restated: a Fortune 500 product; every user, associate to executive, feels premium; polish is part of done. Building proceeds in the rollout order; each step lands with its tests and the design walk, and is reported before the next.

## Sources

- Workday interface criticism: [DevX](https://www.devx.com/daily-news/workdays-user-interface-criticized-despite-popularity/), [KillerStartups](https://killerstartups.com/workdays-software-criticized-for-complexity/), [Capterra reviews](https://www.capterra.com/p/66908/Workday-HCM/reviews/?page=23), [Change Job redesign (Syssero)](https://syssero.com/insights/why-workdays-change-job-ui-overhaul-is-a-win-for-everyone-a-consultants-perspective/)
- Workday Agent System of Record: [Futurum on Rising 2025](https://futurumgroup.com/insights/workday-rising-2025-ai-agents-data-cloud-and-flex-credits-unveiled), [TechTarget](https://www.techtarget.com/searchhrsoftware/news/366625056/Workday-adds-seven-agents-to-Illuminate-platform), [CIO](https://cio.com/article/3821624/workday-aims-to-manage-ai-agents-like-employees.html)
- Rippling vs Workday: [G2 comparison](https://www.g2.com/compare/rippling-vs-workday-hcm), [People Managing People](https://peoplemanagingpeople.com/tools/rippling-vs-workday/)
- UKG Pro and Deel employee apps: [Capterra UKG Pro](https://www.capterra.com/p/480/UKG-Pro/reviews/), [GetApp Deel](https://www.getapp.com/hr-employee-management-software/a/deel/reviews/), [Gusto Wallet](https://gusto.com/wallet)
- Frontline app criteria: [Darwinbox ESS roundup](https://darwinbox.com/blog/10-best-employee-self-service-ess-software-enterprise-hr), [Guideflow](https://www.guideflow.com/blog/frontline-worker-software)
- Premium design principles: [Mantlr on Stripe, Linear, Vercel](https://mantlr.com/blog/stripe-linear-vercel-premium-ui), [OpenDesigner](https://opendesigner.io/blog/recreating-stripe-linear-vercel-design-systems-with-design-md)
- Trust centers: [Vanta guide](https://help.vanta.com/en/articles/11487960-vanta-trust-center-implementation-guide), [Webstacks examples](https://www.webstacks.com/blog/trust-center-examples), [Procurize](https://www.procurize.ai/blog/how-to-build-a-trust-page), [Orbiq](https://orbiqhq.com/blog/the-ultimate-guide-to-trust-centers)
