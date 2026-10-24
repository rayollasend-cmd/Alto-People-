# Product analytics (PostHog)

PostHog Cloud, US region — project **684496** (https://us.posthog.com/project/684496).
Sentry stays the tool for errors and performance traces; PostHog is usage,
funnels, web vitals and staff session replays. One recording tool, not two.

## Switching it on and off

- `VITE_POSTHOG_KEY` (the project's public `phc_…` key) on the Railway service.
  It is read at **build** time, so changing it needs a deploy.
- Unset → nothing: the build contains no PostHog code at all (Rollup drops the
  load path), which is how CI, Lighthouse and the visual baselines build.
- Code: `apps/web/src/lib/analytics.ts` (policy, scrubbing, recording rules),
  `components/AnalyticsIdentity.tsx` (who is signed in),
  `apps/api/src/routes/analyticsRelay.ts` (the relay).

## How it reaches PostHog

The SDK sends to `/api/ux` on our own origin; the API forwards it to
`us.i.posthog.com` (events, recordings, flags) or `us-assets.i.posthog.com`
(`/array`, `/static` — project settings). So:

- ad blockers don't drop staff analytics;
- the CSP stays `connect-src 'self'` and `script-src 'self'`: no PostHog host,
  and no script from PostHog's CDN — the SDK, web vitals, dead clicks and the
  recorder are our own chunks, pinned in package-lock (`posthog-js` exact);
- PostHog sees the API's address, never an employee's: the relay forwards the
  body and content-type / content-encoding / user-agent / accept only — no
  cookies, no authorization header, no X-Forwarded-For. Location reports in
  PostHog therefore show the server's region, not people's.

## The privacy rules (owner's defaults, 2026-10-23)

- **Identity:** internal user id, the role being worn, and the company id.
  Never a name or an email. Visitors who aren't signed in get no person
  profile and nothing stored in their browser (memory persistence); signed-in
  people get localStorage, no cookie.
- **Autocapture:** that a button was pressed and where — never its text or
  attributes (`mask_all_text`, `mask_all_element_attributes`).
- **URLs:** query strings dropped (search boxes put names there) except
  `utm_*` campaign tags; hashes dropped; secret-link tokens
  (`/offer/:token`, `/reset-password/:token`, …) masked. Page titles dropped —
  a person's record is titled with their name.
- **Not tracked at all:** the whistleblower hotline (`/hotline`) and the
  clock-in kiosk. Their events are dropped, the page after them forgets them
  (`$prev_pageview_*`, referrer), and the SDK doesn't load if a tab opens on them.
- **Recordings:** office roles only (not associates, drivers or client-portal
  users), never in the phone app. Every word and input masked, images, video
  and canvas blocked, no console logs, no network headers or bodies. Stopped
  on pay, payroll, compensation, benefits, Books, finance, a person's record,
  onboarding tasks and applications, documents, compliance, HR cases,
  discipline, separations, leave, messages, audit, the hotline inbox, and
  every secret-link page — the list is `PRIVATE_PATHS` in lib/analytics.ts.
  Mark any other element `data-private` to block it from recordings.
- **Do Not Track** is honoured. Sentry handles exceptions (`capture_exceptions: false`);
  surveys, product tours, conversations and web experiments are off.

Consider a line in the employee privacy notice that app usage is measured —
a policy call, not a code one.

## PostHog project settings this relies on

- **Session replay → Record user sessions: on.** Recording starts only when
  the project allows it; the code decides *who* and *where*.
- **Session replay → Capture network requests: leave off** (the code masks
  query strings anyway).
- **Project → Discard client IP data: on** is harmless and belt-and-braces —
  the relay already withholds it.
- **Autocapture, heatmaps, web vitals: on.**
