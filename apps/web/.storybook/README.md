# Storybook

The shared kit (`src/components/ui`), the page templates (`src/components/templates`)
and shell pieces such as `StartingPayCard`, each rendered alone with the app's own
providers, tokens and fonts. Storybook 10 (React + Vite).

```sh
npm -w apps/web run storybook         # the workshop, http://localhost:6006
npm -w apps/web run build-storybook   # static build → apps/web/storybook-static/
npm -w apps/web run test-storybook    # every story in Chromium + axe, light then dark
```

`test-storybook` needs Playwright's Chromium (`npx playwright install chromium`,
already there if you run the E2E suite).

## Writing a story

Put `Thing.stories.tsx` next to `Thing.tsx`. Nothing in the app imports a story,
so it never reaches the app bundle, and `tailwind.config.js` leaves stories out of
the app's CSS (a class only a story uses is not generated — use the kit's classes).

Every story gets, from `.storybook/decorators.tsx`:

| What | Default | Per story (`parameters`) |
| --- | --- | --- |
| React Query | a fresh client per story, no retries | — |
| i18n | English | — |
| Theme | toolbar: Light / Dark (writes `alto.theme` and `<html data-theme>`, like the app) | `globals: { theme: 'dark' }` |
| Viewport | toolbar: Phone 390 / Desktop 1440 (default 1440) | `globals: { viewport: { value: 'phone' } }` |
| Signed in | an HR administrator at Alto HR, every capability of the role | `auth: { role: 'INTERNAL_RECRUITER' }`, `auth: { capabilities: [...] }`, `auth: null` (signed out) |
| Router | a MemoryRouter at `/` | `route: '/approvals?request=r2'` |
| API | every `/api/*` call answers 404 | `api: [{ path: '/comp/associates/:id/hire-pay', body }]` |

The fake API (`.storybook/mockApi.ts`) patches `fetch` for `/api/*` only, so the
component's real `apiFetch` runs and sees the same `ApiError` / `NetworkError` it
would in production. A mock can set `method`, `status`, `body` (or a function of
the request), `delay` (`Infinity` = stays loading) and `networkError`.
`StartingPayCard.stories.tsx` is the worked example.

Made-up people for lists are in `.storybook/fixtures.ts` (60 rows, a few long
names on purpose).

## The story tests

`vitest.storybook.config.ts` runs every story through `@storybook/addon-vitest`
in real Chromium (Vitest browser mode, Playwright): the story renders at its
viewport, its `play` function runs, then axe checks the result with the same
rules as the full-stack sweep (WCAG 2.0/2.1/2.2 A and AA). `parameters.a11y.test`
is `'error'`, so a violation fails the test, and the run repeats with
`VITE_SB_THEME=dark` so both palettes are checked. The unit suite
(`npm -w apps/web test`, jsdom) never picks up a story.

CI runs it in the **Storybook** job (`.github/workflows/ci.yml`): build the static
Storybook, then the story tests; the static build is kept as an artifact.

### Known findings

The first run (2026-10-23) found four real accessibility problems in the kit;
all four are fixed and their stories now check them in both themes:

| Component | Problem | Fix |
| --- | --- | --- |
| `QueryError` | "Details for support" was `text-xs opacity-80` in the alert banner: 4.06:1 in the light theme | opacity dropped |
| `DataGrid` | the loading skeleton had `aria-label` on a role-less `div` (`aria-prohibited-attr`) | `role="status"` on it |
| `RingMeter` | `percent={null}` kept `role="meter"` without `aria-valuenow` | `role="img"` without a value |
| `Toaster` | sonner's light success toast was 4.25:1 (warning ~3:1) | sonner's colour variables set from the status tokens (index.css) |

A new finding gets the same treatment: switch the one rule off for the one
story, write `KNOWN FINDING` and the reason on the story, and list it here.

## Chromatic (needs the owner's Chromatic account)

`npm -w apps/web run chromatic` builds Storybook and uploads it to Chromatic for
visual review of every story. It is prepared, not wired into CI: it needs a
Chromatic project, whose token the CLI reads from `CHROMATIC_PROJECT_TOKEN`.

```sh
CHROMATIC_PROJECT_TOKEN=chpt_… npm -w apps/web run chromatic
```

To run it on every pull request, add the token as a repository secret and a step
`npm -w apps/web run chromatic` with `env: { CHROMATIC_PROJECT_TOKEN: ${{ secrets.CHROMATIC_PROJECT_TOKEN }} }`
to the Storybook job.
