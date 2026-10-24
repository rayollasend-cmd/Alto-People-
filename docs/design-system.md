# Alto People design system

Effective 2026-10-15 (UX upgrade step 1; docs/ux-upgrade-investigation.md). This is the written standard the code follows. When a screen is touched it is brought in line with this page; the design lint (§7) stops new drift; the design walk (§8) is the proof. The living version renders from the same tokens at `/design-system` in the app.

## 1. Principles

1. **The system does the work; the person sees decisions.** A home opens with what needs that person today. Navigation is how you get elsewhere, never the first thing you read.
2. **Premium for every user.** The associate's phone screens get the same type, spacing, motion and care as the executive's board pack. There is no plainer tier.
3. **Restraint.** Gold is the brand's punctuation, not a fill. One hero per surface. Money and time in the sans with tabular numerals, never the display serif. Secondary data behind Details.
4. **Trust you can see.** Evidence, chain status, decision records and gates are first-class surfaces.
5. **One language.** The tenant's terms, EN/ES/TR, icons that mean what their labels say, one word for one thing.
6. **Nothing hand-rolled twice.** A pattern used on two pages becomes a component with documented states.

## 2. Tokens

Tokens are named for their **job**. They are defined in `apps/web/src/index.css` in terms of the brand palette, so they flip with the theme by construction; `tailwind.config.js` exposes them as classes. The brand names (`navy`, `silver`, `gold`…) remain as aliases while existing pages migrate; new code uses the job names.

| Job | Class | Dark | Light | Use |
|---|---|---|---|---|
| App background | `bg-surface-sunken` | #080F20 | #F8FAFC | the page behind cards |
| Surface | `bg-surface` | #0B1832 | #FFFFFF | cards, panels, sheets |
| Raised | `bg-surface-raised` | #142B52 | #E2E8F0 | hover, selected row, rail active |
| Line | `border-line` | #142B52 | #E2E8F0 | borders, dividers |
| Ink | `text-ink` | #FFFFFF | #0F172A | primary text |
| Ink muted | `text-ink-muted` | #C0D0E0 | #334155 | secondary text, captions |
| Ink subtle | `text-ink-subtle` | #666666 | #94A3B8 | placeholders, disabled |
| Accent | `text-accent` | #D9B967 | #87680C | the one accent, as text and icon |
| Accent fill | `bg-accent-fill` + `text-accent-on` | #D9B967 / #0B1832 | #B8860B / #0B1832 | the primary button, the one highlighted thing |
| Positive | `positive` | #34A874 | #065F46 | done, healthy, paid |
| Caution | `caution` | #EDB23C | #92400E | waiting, due soon |
| Negative | `negative` | #E96255 | #B91C1C | failed, late, refused, danger |
| Info | `info` | #60A5FA | #2563EB | links, informational |
| On solid | `text-on-solid` | #FFFFFF | #FFFFFF | ink on a saturated fill |
| Chart 1/2/3 | `chart-1/2/3` | #B08C2E / #3B82F6 / #0D9488 | #B8860B / #2563EB / #0D9488 | marks only, never text |

Rules: no inline hex in page code; status colours mean status (never decoration); gold never fills an area larger than a button; every pair in this table clears WCAG AA in both themes (`src/__tests__/a11y/tokenContrast.test.ts`).

## 3. Type, space, shape, motion

**Faces.** Geist (sans) for everything that is read or compared; Cormorant Garamond (display) for page titles and greetings only. Money, hours, counts: `font-sans tabular-nums`.

**Scale (six jobs).**

| Job | Class | Component |
|---|---|---|
| Hero | `font-display text-hero md:text-hero-lg` | `PageHeader` title; a home's greeting |
| Title | `text-xl text-ink` | `EmptyState` title, a drawer title, a card hero number's label |
| Section | `text-base font-medium text-ink` | `SectionTitle` |
| Body | `text-sm md:text-base text-ink` | prose, table cells |
| Caption | `text-xs2 text-ink-muted` | meta, timestamps, hints |
| Micro | `text-2xs uppercase tracking-[0.18em] text-ink-muted` | eyebrows and column labels (one tracking value: `0.18em`) |

**Space.** Tailwind's 4-px grid. Page sections are `space-y-6`; a card's padding is `p-5` (`p-4` on dense admin cards); a list row is `py-3`.

**Shape.** Three radii: `rounded-md` (6 px: controls, chips, inputs), `rounded-lg` (8 px: cards, sheets), `rounded-full` (avatars, pills). `rounded-xl` and larger are not used.

**Elevation.** `elev-1` (card at rest), `elev-2` (hover, drawer), `elev-3` (dialog). No raw `shadow-*`.

**Motion.** Open 220 ms, close 180 ms, standard easing; count-ups and sparklines on numbers that just loaded; `prefers-reduced-motion` honoured everywhere (Celebrate, shimmer, count-up).

**Touch.** Every control is at least 44 px tall on a coarse pointer and inputs are 16 px so iOS never zooms. These are enforced in the components, never undone with `md:`.

## 3.1 Navigation: rows and doors

The sidebar is a dozen rows for every role, never the hundred. In order: Home · Inbox (every decision waiting on the person, one count) · Messages · Relay · the person's Pinned and Recent · then the **doors** — one row each, which open to the pages behind them: Me, My team, People, Hiring, Time & scheduling, Pay & finance, Compliance, Operations, Transportation, Clients, Communications, Insights, Settings & trust. The six Products of the taxonomy survive as the doors; what changed is the depth. A door opens when the page inside it is the current one and stays the way the person last left it; in the icon rail a door is one icon that opens a menu of its pages. The phone's drawer draws the same shape, and its tab bar may only name destinations the rail shows that role.

Rules. A module is reached through a door, the palette, and by URL — never by URL alone: `__tests__/lib/navCoverage.test.ts` fails the build for a signed-in route with no way in, a module in no door, a role whose rail grows past twenty rows, or a phone tab outside the rail. Counts beside rows come from the one inbox request (`GET /me/inbox`), keyed by path. The assistant is one pane at the right of the page (full screen on a phone), opened from the spark in the top bar, ⌘J, the seat on a home, the phone menu or the palette — one thread that stays while the person moves between pages, which carries the page and the record on it with every question, and which can offer a hand-off to a person but never sends one unconfirmed. Settings & trust is one door; its overview at `/admin` and the area rail read one list (`pages/settings/settingsRail.ts`).

## 4. The five page templates

Every page is one of these and says so (`data-template` on the root; `src/components/templates`). The design walk groups screenshots by template.

### 4.1 Home (`HomeTemplate`)
Banners that interrupt · greeting · **one hero** · decisions ("Needs you", counted) · what changed · Hugo's seat · ways in. On it today: associate, supervisor, manager, admin, executive, driver, recruiter, workforce, finance. Still on their own order, for the sweep: the portal's store and region homes (the transport director's page is a Desk). The greeting word comes from `useGreeting()` in `lib/greeting.ts` (EN/ES/TR), never a page-local copy. The aside takes its column only when Hugo rendered something; a queue card under the "Needs you" title runs headless (`title={null}` / `headless`) so the section is titled once.

### 4.2 List (`ListTemplate`)
`PageHeader` · optional summary strip · **one `FilterBar`** · `DataGrid` · the record in a `Drawer`. The list never leaves the screen when a record opens. A page with tabs is a List whose tabs are its lists, each with its own filter row (Time & attendance, Payroll, Scheduling); a page with a print-only header passes `headerClassName="no-print"`. Seventy pages declare it after the sweep's long-tail codemod; where a page keeps its drawer as a child rather than in the `drawer` slot the screen is the same, and the slot is used as pages are next touched.

### 4.3 Record (`RecordTemplate`)
Breadcrumb · identity + title + status + actions · optional summary · `Tabs` for the facets · an aside for the timeline. A person's "Employment" and an agent's "Compliance record" read alike.

### 4.4 Settings (`SettingsTemplate` + `SettingsSection`)
Left rail (a strip on phones) · pages of sections · every section: title, description, **status in the same place** (last check and its time, On/Off, n of m), a small action · danger last, with a negative edge.

### 4.5 Desk (`DeskTemplate`)
Counts · one filter row · the queue · the open item · the action inside the item · closure recorded where the item was. On phones the queue is the page and the item opens over it.

## 5. Components and their states

The UI kit is `src/components/ui`. Every component renders all of its states; pages never improvise one.

| Need | Component | Never |
|---|---|---|
| A page title | `PageHeader` | a raw `<h1>` |
| A section heading | `SectionTitle` | a raw `<h2 className=…>` |
| A list of records | `DataGrid` | a hand-built table |
| Filters | `FilterBar`, `FilterChip`, `SearchInput` | ad-hoc inputs in a row |
| A status | `Badge` (default, success, pending, destructive, accent, info, outline) | `rounded-full px-2 py-0.5` |
| Nothing here | `EmptyState` (icon, title, description, action) | "No … yet" in a paragraph |
| Loading | `Skeleton`, `SkeletonRows` shaped like the content | "Loading…" |
| Could not load | `QueryError` (with Retry) | a bare error string |
| A warning or notice in flow | `ErrorBanner` (error, warning, info) | coloured text |
| A number that matters | `MetricCard` | a big bold div |
| A record's details | `Drawer` | a route change |
| A short form or confirm | `Dialog` (a sheet on phones), `ConfirmDialog` | `window.confirm` |
| A choice among a few | `SegmentedControl` | a row of buttons |
| Tabs | `Tabs` | links styled as tabs |
| Any action | `Button` (primary, secondary, outline, ghost, destructive, link) | a styled `<button>` |
| A select or textarea | `Select`, `Textarea` inside `Field` | raw elements |
| A date | `fmtDate`, `fmtTime`, `fmtDateTime` | `toLocaleDateString` |

## 6. Icons and voice

**Icons.** Lucide, one weight, 16 px in rows and 20 px in headers. The meaning table: Analytics = `BarChart3`, Clients = `Building2`, Compliance = `ShieldCheck`, Payroll = `Wallet`, Scheduling = `CalendarDays`, Time = `Clock`, People = `Users`, Agents = `Bot`, Robots = `Cpu`, Workforce roster = `BookUser`, Audit = `ScrollText`, Settings = `Settings`, Trust = `ShieldCheck`. One glyph per concept wherever it appears (the rail, the roster, Tasks' holder marks, the Control Room, empty states); an agent's own family mark is `AgentGlyph`. An icon never says something its label does not.

**Icon sizes and weight** (2026-10-23). The scale: `h-3` 12 px inline with `text-xs`, `h-3.5` 14 px in dense rows and small buttons, `h-4` 16 px the default, `h-5` 20 px in headers and the tab bar, `h-6` 24 px; `h-2.5` 10 px only as a mark inside a badge; `h-8` and up are illustrations (empty states, the kiosk). Width always equals height. The stroke is set once per size in `index.css` — 1.25 / 1.4 / 1.5 / 1.75 / 2 px on screen, whatever the size, so a 12 px icon is as crisp as a 24 px one — and never per icon: `icon-bold` (+0.5 px) is for a status check or cross, `icon-active` (a soft fill in the icon's own colour) marks the current nav row or tab. A status dot is a round `span`, not a 6 px `Circle`. No emoji or typed ✓ ✗ in the interface: they render differently on every device — use the Lucide icon. Arrows in link text (→) are typography and stay.

**Every icon-only control has a name.** A button or link whose only content is an icon carries `aria-label` (or `title`, `aria-labelledby`, or an `sr-only` child); a `Button size="icon…"` always does. A control kept out of the accessibility tree on purpose (a tree row's own toggle) says so with `aria-hidden`.

**Voice.** Short sentences, specifics (numbers, names, dates), the tenant's words through `useTerm`, three languages through `t()`. Buttons say what happens ("Approve 3 timesheets"). Empty states say what would fill them and offer the first step. Errors say what to do next. No exclamation marks in system copy; celebration is for the person's own milestones.

## 7. The design lint

`apps/web/scripts/design-lint.mjs` counts, per page file, the patterns this system retires (`text-white`, inline hex, hand-rolled pills, bare empty text, raw headings, "Loading…") and compares them with `apps/web/design-baseline.json`. A file whose count rises fails CI (`npm -w apps/web run lint:design`); debt paid down shrinks the baseline (`--write`). The baseline on 2026-10-15 is the starting line of the sweep.

`apps/web/scripts/icon-lint.mjs` (part of `lint:design`) parses every TSX file and fails on an icon-only control with no name, a `strokeWidth` on an icon up to 24 px, or an icon off the size scale — with no baseline: all three were zero on 2026-10-23.

## 8. The proof

- `npm -w apps/web run test` includes the token contrast test and the axe tests.
- The design walk (`.github/workflows/design-walk.yml`) screenshots every persona and surface, desktop and phone, dark and light, EN/ES/TR; it runs on every design brief and its PNGs are reviewed against §4 and §5.
- The size budget (`size-budget.json`) is a gate; templates are shared code and should shrink pages.
- The in-app page `/design-system` renders the tokens, scale and components from the live CSS so documentation cannot drift from the product.
