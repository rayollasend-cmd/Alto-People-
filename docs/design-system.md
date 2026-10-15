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

## 4. The five page templates

Every page is one of these and says so (`data-template` on the root; `src/components/templates`). The design walk groups screenshots by template.

### 4.1 Home (`HomeTemplate`)
Banners that interrupt · greeting · **one hero** · decisions ("Needs you", counted) · what changed · Hugo's seat · ways in. Six homes use it: associate, supervisor, admin, client manager, executive, IT/compliance admin.

### 4.2 List (`ListTemplate`)
`PageHeader` · optional summary strip · **one `FilterBar`** · `DataGrid` · the record in a `Drawer`. The list never leaves the screen when a record opens.

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

**Icons.** Lucide, one weight, 16 px in rows and 20 px in headers. The meaning table: Analytics = `BarChart3`, Clients = `Building2`, Compliance = `ShieldCheck`, Payroll = `Wallet`, Scheduling = `CalendarDays`, Time = `Clock`, People = `Users`, Agents = `Bot`, Audit = `ScrollText`, Settings = `Settings`, Trust = `ShieldCheck`. An icon never says something its label does not.

**Voice.** Short sentences, specifics (numbers, names, dates), the tenant's words through `useTerm`, three languages through `t()`. Buttons say what happens ("Approve 3 timesheets"). Empty states say what would fill them and offer the first step. Errors say what to do next. No exclamation marks in system copy; celebration is for the person's own milestones.

## 7. The design lint

`apps/web/scripts/design-lint.mjs` counts, per page file, the patterns this system retires (`text-white`, inline hex, hand-rolled pills, bare empty text, raw headings, "Loading…") and compares them with `apps/web/design-baseline.json`. A file whose count rises fails CI (`npm -w apps/web run lint:design`); debt paid down shrinks the baseline (`--write`). The baseline on 2026-10-15 is the starting line of the sweep.

## 8. The proof

- `npm -w apps/web run test` includes the token contrast test and the axe tests.
- The design walk (`.github/workflows/design-walk.yml`) screenshots every persona and surface, desktop and phone, dark and light, EN/ES/TR; it runs on every design brief and its PNGs are reviewed against §4 and §5.
- The size budget (`size-budget.json`) is a gate; templates are shared code and should shrink pages.
- The in-app page `/design-system` renders the tokens, scale and components from the live CSS so documentation cannot drift from the product.
