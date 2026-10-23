// Must be imported before any route is registered. Monkey-patches Express's
// router so async handlers that throw forward to next(err) instead of becoming
// unhandled rejections (which would crash the process under Express 4).
import { installRouteNaming } from './lib/routeName.js';
import 'express-async-errors';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express, { type Request } from 'express';
import compression from 'compression';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { env } from './config/env.js';
import {
  NAVIGABLE_FILE_PATTERN,
  htmlErrorCopy,
  htmlErrorPage,
  isBrowserNavigation,
  isBuildArtifactRequest,
} from './lib/browserNavigation.js';
import { healthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { oidcAuthRouter } from './routes/oidcAuth.js';
import { publicOrgRouter } from './routes/publicOrg.js';
import { samlAuthRouter } from './routes/samlAuth.js';
import { clientsAccessGate, clientsRouter } from './routes/clients.js';
import { clientAccountRouter } from './routes/clientAccount.js';
import { onboardingRouter } from './routes/onboarding.js';
import { timeRouter } from './routes/time.js';
import { timeCorrectionsRouter } from './routes/timeCorrections.js';
import { overtimeOffersRouter } from './routes/overtimeOffers.js';
import { timeOffRouter } from './routes/timeOff.js';
import { timeOffPoliciesRouter } from './routes/timeOffPolicies.js';
import { earnedWageRouter } from './routes/earnedWage.js';
import { schedulingRouter } from './routes/scheduling.js';
import { calendarFeedRouter } from './routes/calendarFeed.js';
import { payrollRouter } from './routes/payroll.js';
import { associatePayScheduleRouter, paySchedulesRouter } from './routes/paySchedules.js';
import { bankingRouter } from './routes/banking.js';
import { booksRouter } from './routes/books/index.js';
import { payrollGoLiveRouter } from './routes/payrollGoLive.js';
import { booksQuickbooksWebhookRouter } from './routes/books/quickbooksWebhook.js';
import { payBillRouter } from './routes/payBill.js';
import { financialChangesRouter } from './routes/financialChanges.js';
import { payrollTaxesRouter } from './routes/payrollTaxes.js';
import { w4RecollectionRouter } from './routes/w4Recollection.js';
import { documentsRouter } from './routes/documents.js';
import { complianceRouter } from './routes/compliance.js';
import { credentialRequirementsRouter } from './routes/credentialRequirements.js';
import { complianceScorecardRouter } from './routes/complianceScorecard.js';
import { analyticsRouter } from './routes/analytics.js';
import { productAnalyticsRouter } from './routes/productAnalytics.js';
import { scheduledJobsRouter } from './routes/scheduledJobs.js';
import { emergencyRouter } from './routes/emergency.js';
import { programsRouter } from './routes/programs.js';
import { seasonPlansRouter } from './routes/seasonPlans.js';
import { workersRouter } from './routes/workers.js';
import { agentsRouter } from './routes/agents.js';
import { hugoRouter } from './routes/hugo.js';
import { v1Router } from './routes/v1.js';
import { apiClientsRouter } from './routes/apiClients.js';
import { agentApiRouter } from './routes/agentApi.js';
import { mcpRouter } from './routes/mcp.js';
import { laborRulesRouter } from './routes/laborRules.js';
import { identityRouter } from './routes/identity.js';
import { tenantRolesRouter } from './routes/tenantRoles.js';
import { trustRouter } from './routes/trust.js';
import { statusRouter } from './routes/status.js';
import { forecastRouter } from './routes/forecast.js';
import { controlRoomRouter } from './routes/controlRoom.js';
import { integrationConnectionsRouter } from './routes/integrationConnections.js';
import { providerConnectionsRouter } from './routes/providerConnections.js';
import { providerActionsRouter } from './routes/providerActions.js';
import { providerWebhooksRouter } from './routes/providerWebhooks.js';
import { tasksRouter } from './routes/tasks.js';
import { robotsRouter } from './routes/robots.js';
import { billingRouter, stripeWebhookRouter } from './routes/billing.js';
import { supportRouter } from './routes/support.js';
import { telemetryRouter } from './routes/telemetry.js';
import { releaseNotesRouter } from './routes/releaseNotes.js';
import { searchRouter } from './routes/search.js';
import { delegationsRouter } from './routes/delegations.js';
import { communicationsMeRouter, communicationsRouter } from './routes/communications.js';
import { performanceRouter } from './routes/performance.js';
import { performance84Router } from './routes/performance84.js';
import { recruitingRouter } from './routes/recruiting.js';
import { jobsRouter } from './routes/jobs.js';
import { auditRouter } from './routes/audit.js';
import { benefitsRouter } from './routes/benefits.js';
import { branchWebhookRouter } from './routes/branchWebhook.js';
import { resendWebhookRouter } from './routes/resendWebhook.js';
import { whatsappRouter, whatsappWebhookRouter } from './routes/whatsapp.js';
import { emailUnsubscribeRouter } from './routes/emailUnsubscribe.js';
import { orgRouter } from './routes/org.js';
import { externalPaymentsRouter } from './routes/externalPayments.js';
import { opsRouter } from './routes/opsShifts.js';
import { auditPacketRouter } from './routes/auditPacket.js';
import { directoryRouter } from './routes/directory.js';
import { executiveRouter } from './routes/executive.js';
import { clientProspectsRouter } from './routes/clientProspects.js';
import { roleDecisionsRouter } from './routes/roleDecisions.js';
import { inboxRouter } from './routes/inbox.js';
import { positionsRouter } from './routes/positions.js';
import { teamRouter } from './routes/team.js';
import { workflowsRouter } from './routes/workflows.js';
import { customFieldsRouter } from './routes/customFields.js';
import { selfServiceRouter } from './routes/selfService.js';
import { readyToWorkRouter } from './routes/readyToWork.js';
import { compensationRouter } from './routes/compensation.js';
import { qualificationsRouter } from './routes/qualifications.js';
import { projectsAndPayRouter } from './routes/projectsAndPay.js';
import { directoryAndCommsRouter } from './routes/directoryAndComms.js';
import { approvalsRouter } from './routes/approvals.js';
import { approvalRequestsRouter } from './routes/approvalRequests.js';
import { promotionsRouter } from './routes/promotions.js';
import { accessGrantsRouter } from './routes/accessGrants.js';
import { savedViewsRouter } from './routes/savedViews.js';
import { eventsRouter } from './routes/events.js';
import { oshaWcEeoRouter } from './routes/oshaWcEeo.js';
import { docTemplatesRouter } from './routes/docTemplates.js';
import { recruiting90Router } from './routes/recruiting90.js';
// The office pack (2026-10-17): the candidate's page + the recruiter's
// calendar feed, marketing, and client NPS. Each self-gates per handler.
import { candidatePortalRouter } from './routes/candidatePortal.js';
import { marketingRouter } from './routes/marketing.js';
import { clientNpsRouter } from './routes/clientNps.js';
import { marketRatesRouter } from './routes/marketRates.js';
import { credentialsRouter } from './routes/credentials.js';
import { payrollTax91Router } from './routes/payrollTax91.js';
import { federalW4Router } from './routes/federalW4.js';
import { payExpRouter } from './routes/payExp.js';
import { garnishmentDeskRouter } from './routes/garnishmentDesk.js';
import { paperChecksRouter } from './routes/paperChecks.js';
import { retirementRouter } from './routes/retirement.js';
import { benefitCarriersRouter } from './routes/benefitCarriers.js';
import { certifiedPayrollRouter } from './routes/certifiedPayroll.js';
import { contractorSelfRouter, contractorsRouter } from './routes/contractors.js';
import { stateTaxRouter } from './routes/stateTax.js';
import { deductionTreatmentRouter } from './routes/deductionTreatment.js';
import { taxJurisdictionsRouter } from './routes/taxJurisdictions.js';
import { wotcRouter } from './routes/wotc.js';
import { acaRouter } from './routes/aca.js';
import { benefitsLifecycle92Router } from './routes/benefitsLifecycle92.js';
import { apiKeysWebhooks93Router } from './routes/apiKeysWebhooks93.js';
import { lms94Router } from './routes/lms94.js';
import { worktags95Router } from './routes/worktags95.js';
import { reports96Router } from './routes/reports96.js';
import { reimbursements97Router } from './routes/reimbursements97.js';
import { clientPortalRouter } from './routes/clientPortal.js';
import { financeOverviewRouter } from './routes/financeOverview.js';
import { workforceOverviewRouter } from './routes/workforceOverview.js';
import { companyClockRouter } from './routes/companyClock.js';
import { relayRouter } from './routes/relay.js';
import { relayWorkRouter } from './routes/relayWork.js';
import { clientRequestsRouter } from './routes/clientRequests.js';
import { messagesRouter } from './routes/messages.js';
import { regionRouter, regionsAdminRouter } from './routes/region.js';
import { kiosk99Router } from './routes/kiosk99.js';
import { punchPhotosRouter } from './routes/punchPhotos.js';
import { attendanceInsightsRouter } from './routes/attendanceInsights.js';
import { opsActivityRouter } from './routes/opsActivity.js';
import { celebrationsRouter } from './routes/celebrations107.js';
import { assetsRouter } from './routes/assets108.js';
import { pulseSurveysRouter } from './routes/pulseSurveys109.js';
import { headcount110Router } from './routes/headcount110.js';
import { skills111Router } from './routes/skills111.js';
import { mentorship112Router } from './routes/mentorship112.js';
import { expirations113Router } from './routes/expirations113.js';
import { expirationRiskRouter } from './routes/expirationRisk.js';
import { staffingPlanRouter } from './routes/staffingPlan.js';
import { learningPaths114Router } from './routes/learningPaths114.js';
import { succession115Router } from './routes/succession115.js';
import { successionBenchRouter } from './routes/successionBench.js';
import { probation116Router } from './routes/probation116.js';
import { holiday117Router } from './routes/holiday117.js';
import { discipline118Router } from './routes/discipline118.js';
import { separation119Router } from './routes/separation119.js';
import { leaveRouter } from './routes/leave.js';
import { claimsRouter } from './routes/claims.js';
import { internalMobility120Router } from './routes/internalMobility120.js';
import { vaccination121Router } from './routes/vaccination121.js';
import { agreements122Router } from './routes/agreements122.js';
import { hrCases123Router } from './routes/hrCases123.js';
import { kb124Router } from './routes/kb124.js';
import { policyCampaignsRouter } from './routes/policyCampaigns.js';
import { verificationLettersRouter } from './routes/verificationLetters.js';
import { documentRetentionRouter } from './routes/documentRetention.js';
import { massUpdateRouter } from './routes/massUpdate.js';
import { peopleAnalyticsRouter } from './routes/peopleAnalytics.js';
import { ramp125Router } from './routes/ramp125.js';
import { career126Router } from './routes/career126.js';
import { tuition127Router } from './routes/tuition127.js';
import { anonReport128Router } from './routes/anonReport128.js';
import { equity129Router } from './routes/equity129.js';
import { vto130Router } from './routes/vto130.js';
import { profilePhotoRouter } from './routes/profilePhoto.js';
import { nativeAppRouter } from './routes/nativeApp.js';
import { usersRouter } from './routes/users.js';
import { employersRouter } from './routes/employers.js';
import { payrollComplianceRouter } from './routes/payrollCompliance.js';
import { orgUnitsRouter } from './routes/orgUnits.js';
import { structureRouter } from './routes/structure.js';
import { complianceEvidenceRouter } from './routes/complianceEvidence.js';
import { accessCertificationsRouter } from './routes/accessCertifications.js';
import { shiftWindowsRouter } from './routes/shiftWindows.js';
import { floorTeamRouter } from './routes/floorTeam.js';
import { floorRouter } from './routes/floor.js';
import { openShiftInvitesRouter } from './routes/openShiftInvites.js';
import { callOutsRouter } from './routes/callOuts.js';
import { voiceRouter } from './routes/voice.js';
import { retentionRouter } from './routes/retention.js';
import { walletRouter } from './routes/wallet.js';
import { transportRouter } from './routes/transport.js';
import { transportOpsRouter } from './routes/transportOps.js';
import { orgSettingsRouter } from './routes/orgSettings.js';
import { tenancyRouter } from './routes/tenancy.js';
import { requireModule } from './lib/tenantProfile.js';
import { integrationsV1Router } from './routes/integrationsV1.js';
import { scimRouter } from './routes/scim.js';
import { attachUser, requireAuth, requireCapability } from './middleware/auth.js';
import { tenantMiddleware } from './lib/tenant.js';
import { defaultApiLimiter } from './middleware/rateLimit.js';
import { usageTracking } from './middleware/usage.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { requestId } from './middleware/requestId.js';
import { auditFloor } from './middleware/auditFloor.js';

// In production this Express server also serves the built React SPA, so the
// browser sends `/api/*` to disambiguate from static assets and SPA routes.
// Existing routers are mounted at root paths (`/auth`, `/clients`, etc.),
// so we strip the prefix here once at the top of the chain. Tests and the
// dev workflow (Vite proxy already strips `/api/`) hit the routes directly
// — this middleware is a no-op when there's no prefix.
//
// If a user types an `/api/*` URL into the address bar (or clicks a stale
// link), we'd otherwise dump raw JSON onto the page. In production, redirect
// browser navigations to the de-prefixed SPA path so they see the rendered
// page (or the login screen, if unauthenticated). `Sec-Fetch-Mode=navigate`
// + `Sec-Fetch-Dest=document` matches address-bar / link clicks specifically:
// fetch() calls, image requests, iCal pollers, and integration API clients
// don't set those, so they keep getting JSON.
function stripApiPrefix(
  req: Request & { isApiCall?: boolean },
  res: express.Response,
  next: express.NextFunction
) {
  if (req.url.startsWith('/api/') || req.url === '/api') {
    if (isBrowserNavigation(req)) {
      const target = req.url.slice(4) || '/';
      return res.redirect(302, target);
    }
    req.isApiCall = true;
    req.url = req.url.slice(4) || '/';
  }
  next();
}

// Classification + HTML fallbacks live in lib/browserNavigation.ts (unit-
// tested against real browser header sets — Chrome, Safari 15, webviews,
// fetch/XHR, pollers). error.ts uses the same helpers so navigations that
// reach an error path get HTML too, never JSON.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Resolves apps/api/dist/app.js → apps/web/dist
const WEB_DIST = path.resolve(__dirname, '../../web/dist');

export function createApp() {
  // Route-parameterized transaction names for Sentry, taken at the moment
  // Express matches the route (see lib/routeName.ts).
  installRouteNaming();
  const app = express();

  // Behind a proxy in prod (Vercel/Railway/etc.) so req.ip resolves correctly.
  if (env.NODE_ENV === 'production') {
    app.set('trust proxy', 1);
  }

  app.use(stripApiPrefix);
  // Declare the negotiation, or a cache will mix the two answers.
  //
  // Dozens of paths serve BOTH the SPA page and a JSON API resource
  // (/jobs, /separations, /reports…), and which one you get depends on
  // the request headers — Sec-Fetch-Mode/Dest, falling back to Accept.
  // Without Vary, every shared cache between here and the browser (the
  // platform edge, a corporate proxy, the browser's own HTTP cache) is
  // entitled to replay the JSON variant for a page load. That is exactly
  // how a refresh intermittently rendered `{"jobs":[…]}` instead of the
  // page: not a routing bug at the moment of the request, but a cache
  // handing back the other variant of the same URL.
  //
  // Also: business JSON must never sit in an intermediary at all. The
  // handlers that legitimately want caching (static assets, the SPA
  // shell, photos) set their own Cache-Control after this and win.
  app.use((_req, res, next) => {
    res.vary('Accept');
    res.vary('Sec-Fetch-Mode');
    res.vary('Sec-Fetch-Dest');
    // Tied to res.json rather than the request, so it lands on business
    // data and nothing else: the hashed asset bundles keep their year,
    // the SPA shell keeps its revalidate, and a handler that has already
    // chosen a policy for its own response keeps that too.
    const json = res.json.bind(res);
    res.json = (body: unknown) => {
      if (!res.getHeader('Cache-Control')) res.setHeader('Cache-Control', 'no-store');
      return json(body);
    };
    next();
  });
  // Browser PAGE navigations never reach JSON API routes. API routers are
  // mounted at root paths that collide with SPA pages (GET /separations
  // the API list vs /separations the page, plus /agreements, /holidays,
  // /hr-cases, /reports, and a dozen more) — so refreshing or deep-linking
  // those pages rendered raw JSON in the browser. A navigation
  // (Sec-Fetch-Mode=navigate + Dest=document — address-bar loads and link
  // clicks; never fetch()/XHR, images, or integration clients) gets the
  // SPA shell instead, EXCEPT for file-download URLs, which are opened by
  // <a href> navigation on purpose (document downloads, packet/paystub
  // PDFs, CSV exports, calendar feeds). /api/*-tagged calls are exempt so
  // API clients always get JSON.
  // Not gated on NODE_ENV. "A page load is never answered with JSON" is
  // an invariant of the routing table, not a production nicety — gating it
  // meant the one environment that could TEST it was the one environment
  // where it was switched off, and every integration test that seemed to
  // prove it was really only seeing a 401 turned into HTML by the error
  // handler. Where there is no web build (dev, CI), a navigation gets the
  // "refresh in a moment" page instead of the app — still HTML, never JSON.
  app.use((req: Request & { isApiCall?: boolean }, res, next) => {
    if (
      !req.isApiCall &&
      isBrowserNavigation(req) &&
      !NAVIGABLE_FILE_PATTERN.test(req.path)
    ) {
      // A page load NEVER falls through to the JSON routers — even when
      // the web bundle is missing (mid-deploy, broken build), the browser
      // gets an HTML "refresh in a moment" page rather than raw API data.
      if (!existsSync(WEB_DIST)) {
        res
          .status(503)
          .type('html')
          .send(htmlErrorPage({ status: 503, ...htmlErrorCopy(503) }));
        return;
      }
      const isKiosk = req.path === '/kiosk' || req.path.startsWith('/kiosk/');
      res.sendFile(path.join(WEB_DIST, isKiosk ? 'kiosk.html' : 'index.html'), {
        headers: { 'Cache-Control': 'no-cache' },
      });
      return;
    }
    next();
  });
  // gzip everything compressible — API JSON and the SPA bundles alike.
  // Measured before this existed: the main JS chunk left the server as
  // 441 KB raw (Railway's proxy only gzips text/html), which dominated
  // first-load time on store tablets. ~70% smaller on the wire with this.
  // compression() skips already-compressed content types (images, PDFs)
  // via its mime filter, and there are no SSE/streaming endpoints to
  // worry about buffering.
  app.use(compression());
  // Mounted before helmet so every response — including helmet's 4xx /
  // CSP-blocked ones — carries the trace ID. Stays before attachUser so
  // auth-failure logs have an id.
  app.use(requestId);
  // Helmet defaults are mostly fine; we just need to widen connect-src
  // so the browser SDK can POST event envelopes to Sentry's ingest
  // host. The default CSP only declares default-src 'self', which the
  // browser falls back to for connect-src and which blocks any cross-
  // origin fetch — Sentry, but also any future analytics / 3rd-party
  // service. Sentry's ingest is an org-scoped subdomain that varies by
  // region (us / de / global), so we list each wildcard explicitly
  // rather than open up *.sentry.io for everything. No-op for the SDK
  // when VITE_SENTRY_DSN is unset (no POSTs are attempted).
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          // Two Emscripten libraries load on the main thread: OpenCV (the
          // ID / void-cheque capture on onboarding) and libheif via
          // heic2any (turning an iPhone HEIC upload into a JPEG).
          //
          // 'wasm-unsafe-eval' alone was not enough, and the reason is
          // worth writing down: it permits WebAssembly.compile and
          // nothing else. Both libraries are built with embind, which
          // assembles its argument-wiring and method-caller trampolines
          // with `new Function(...)` on every bound call — ordinary
          // JavaScript evaluation, not WASM compilation. So the .wasm
          // instantiated fine and the very first call into it was
          // blocked, which is why the violation moved from script-src to
          // citing 'unsafe-eval'.
          //
          // This is a real widening and not one to enjoy: it re-enables
          // eval() and new Function() for every script on the origin. The
          // narrow fix is to move both libraries into Web Workers and
          // serve those worker scripts with their own looser CSP header,
          // which confines eval to the worker; both are dynamic imports on
          // the main thread today, so that is a refactor rather than a
          // directive change. 'wasm-unsafe-eval' stays listed because it
          // documents the WASM requirement even though 'unsafe-eval'
          // subsumes it.
          'script-src': ["'self'", "'wasm-unsafe-eval'", "'unsafe-eval'"],
          'connect-src': [
            "'self'",
            'https://*.ingest.sentry.io',
            'https://*.ingest.us.sentry.io',
            'https://*.ingest.de.sentry.io',
            // The vans' live map: OpenFreeMap serves the map style, vector
            // tiles, fonts and icons (fetched by MapLibre). The map's web
            // worker is a Vite-bundled file on our own origin (MapLibre 6's
            // ESM build, pointed at it with setWorkerUrl), so worker-src
            // falls through to script-src 'self' and no blob: is needed.
            'https://tiles.openfreemap.org',
          ],
        },
      },
    }),
  );
  app.use(cors({ origin: env.CORS_ORIGIN, credentials: true }));
  // Webhooks run before the session parser, so each gets an anonymous
  // tenant context (tenantMiddleware with no user) and resolves its
  // subject's tenant itself (lib/tenant.ts resolveTenantFrom).
  // Branch webhook MUST be mounted before express.json() so the raw body
  // bytes survive for HMAC verification (the global parser would consume
  // the stream and re-serialization breaks signatures on whitespace).
  app.use('/branch/webhook', tenantMiddleware, branchWebhookRouter);
  // Same deal for Resend's email-event webhook — the Svix signature is
  // computed over the exact raw bytes.
  app.use('/resend/webhook', tenantMiddleware, resendWebhookRouter);
  // And Meta's WhatsApp webhook — X-Hub-Signature-256 over the raw body.
  app.use('/whatsapp/webhook', tenantMiddleware, whatsappWebhookRouter);
  // And Twilio's call-out line (voice + SMS) — X-Twilio-Signature over the URL and form body.
  app.use('/voice', tenantMiddleware, voiceRouter);
  // And Stripe's billing events (Brief 2-6 step 4) — Stripe-Signature over the raw body.
  app.use('/billing/stripe/webhook', tenantMiddleware, stripeWebhookRouter);
  // And every connected service provider (E-Verify agents, Checkr, eScreen, Quest, TaxBandits,
  // Wise) — each adapter verifies its own signature over the raw body.
  app.use('/webhooks/providers', tenantMiddleware, providerWebhooksRouter);
  // And Intuit's change notifications for the company QuickBooks (intuit-signature over the raw body).
  app.use('/books/quickbooks/webhook', tenantMiddleware, booksQuickbooksWebhookRouter);
  // 2mb to accommodate base64-encoded kiosk selfies (1MB raw → ~1.4MB
  // base64 → headroom for the JSON envelope).
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());
  app.use(attachUser);
  // Brief 2-1, step one: every request runs inside a tenant context (Alto HR today). Nothing enforced yet.
  app.use(tenantMiddleware);
  // Backstop rate limit for the whole authenticated surface (skips
  // anonymous requests — those surfaces carry their own limiters).
  // Sits directly after attachUser so req.user keys the bucket.
  app.use(defaultApiLimiter);
  // Counts finished requests, after auth so req.user is known. Everything
  // it does happens on 'finish' — off the path to a response.
  app.use(usageTracking);
  // Brief 2-3 step 1: every data change and every export writes one awaited audit row (middleware/auditFloor).
  app.use(auditFloor);

  app.use('/health', healthRouter);
  // Enterprise SSO (OIDC). Mounted at the same root-path convention as
  // authRouter — its cookies (session + flow state, both path=/) must line
  // up exactly with the password/passkey flows. Mounted before /auth so
  // the more-specific prefix wins outright.
  app.use('/auth/oidc', oidcAuthRouter);
  // Brief 2-3 step 5: SAML 2.0 (the ACS is un-prefixed: a form POST from the IdP).
  app.use('/auth/saml', samlAuthRouter);
  // F500 G5: the organization behind a /login/<slug> address — its name and logo, nothing more.
  app.use('/auth/org', publicOrgRouter);
  app.use('/auth', authRouter);
  // Public integration API (AltoHR / ShiftReport Nexus, etc.). Authenticates
  // via `Authorization: Bearer altop_<hex>` rather than the session cookie,
  // so it sits outside the human-RBAC chain. Mounted early so its 401s
  // don't get tangled with cookie-flow routes if a caller forgets the
  // bearer header.
  app.use('/integrations/v1', requireModule('payrollSync'), integrationsV1Router);
  // Agents call with their own credential, never a session (Brief 1D-2).
  // Tenant profile: agents exist only where the agent builder module is on (404 otherwise, before any credential check).
  app.use('/agent/v1', requireModule('agentBuilder'), agentApiRouter);
  // Brief 2-7: the MCP server over the agent API, agent credentials only.
  app.use('/mcp', mcpRouter);
  // Brief 2-4: the public API. OAuth client credentials, scoped tokens, a
  // generated OpenAPI document at /v1/openapi.json; /integrations/v1 stays for ASN.
  app.use('/v1', v1Router);
  app.use('/api-clients', apiClientsRouter);
  // Brief 2-2: the labor rules in force per site (read-only until step 6).
  app.use('/labor-rules', laborRulesRouter);
  // Brief 2-3 step 2: a tenant's own sign-in, domains and SCIM tokens.
  app.use('/identity', identityRouter);
  app.use('/tenant-roles', tenantRolesRouter);
  // UX upgrade step 4: the Trust Center (public summary and the tenant's view).
  app.use('/trust', trustRouter);
  // The public status page beside the Trust Center, and the operator's incident posts.
  app.use('/status', statusRouter);
  // Brief 3-5: the tenant admin's HR and VMS connections and their sync log.
  app.use('/integration-connections', integrationConnectionsRouter);
  // The service providers (E-Verify, screening, drug tests, tax filing, payouts) and the buttons that use them.
  app.use('/provider-connections', providerConnectionsRouter);
  app.use('/provider-actions', providerActionsRouter);
  // Brief 3-2: tasks and the assignment engine.
  app.use('/tasks', tasksRouter);
  // Brief 3-1: the robot registry, the fleet's status and the safety rules.
  app.use('/robots', robotsRouter);
  // Brief 2-6 step 4: usage by worker type and invoices.
  app.use('/billing', billingRouter);
  // Brief 2-6 step 5: support requests to the platform inbox, and the status link.
  app.use('/support', supportRouter);
  // SCIM 2.0 user provisioning for IdP-driven lifecycle (Microsoft Entra
  // ID / Okta). Self-authenticates with the dedicated SCIM_TOKEN bearer —
  // deliberately NOT the altop_ ApiKey system; see routes/scim.ts for the
  // rationale — so like /integrations/v1 it sits outside the session-
  // cookie RBAC chain. 503s when SCIM_TOKEN is unset.
  app.use('/scim/v2', scimRouter);
  // Public iCal feed — calendar clients poll without credentials, the
  // HMAC token in the URL is the authorization. Mounted before the
  // session-cookie chain so it doesn't get wrapped in view:scheduling.
  app.use('/calendar', calendarFeedRouter);
  // Not a bare requireCapability: the gate lets client-bounded roles
  // (SHIFT_SUPERVISOR, CLIENT_PORTAL) through to GET /:id/locations only —
  // see clientsAccessGate for why.
  // The messenger gates per role inside (associates are never callers).
  // Tenant profile: the messenger is the client portal's store channels (404 where that module is off).
  app.use('/messages', requireModule('clientPortal'), messagesRouter);
  // The region command center (region accounts + admin preview) and the
  // regions admin (manage:org).
  app.use('/region', requireModule('clientPortal'), regionRouter);
  app.use('/regions', requireModule('clientPortal'), regionsAdminRouter);
  app.use('/clients', requireModule('clientPortal'), clientsAccessGate, clientsRouter);
  // The account page: overview, contacts, owner options (routes/clientAccount). Same gate.
  app.use('/clients', requireModule('clientPortal'), clientsAccessGate, clientAccountRouter);
  // The new-business pipeline (Clients → Pipeline). Self-gates: read on
  // view:executive or manage:clients, write on manage:clients.
  app.use('/client-prospects', requireModule('clientPortal'), clientProspectsRouter);
  app.use(
    '/onboarding',
    requireCapability('view:onboarding'),
    onboardingRouter
  );
  app.use('/time-corrections', requireCapability('view:time'), timeCorrectionsRouter);
  app.use('/overtime-offers', overtimeOffersRouter);
  // Photo at punch: who must be photographed at the kiosk (lib/punchPhotoPolicy).
  app.use('/time/punch-photos', requireCapability('view:time'), punchPhotosRouter);
  app.use('/time', requireCapability('view:time'), timeRouter);
  // Attendance trends, heatmap, not-in-yet and team hours (each route gates itself).
  app.use('/attendance', attendanceInsightsRouter);
  // The floor's record for the admin home: call-outs, publishes, swaps, incidents.
  app.use('/ops-activity', opsActivityRouter);
  // Policies before the catch-all: /time-off/policies/* is its own router.
  app.use('/time-off/policies', requireCapability('view:time'), timeOffPoliciesRouter);
  app.use('/time-off', requireCapability('view:time'), timeOffRouter);
  // Earned-wage access: the associate's /me routes and Finance's desk,
  // behind the tenant switch.
  app.use('/', requireModule('earnedWage'), earnedWageRouter);
  app.use(
    '/scheduling',
    requireCapability('view:scheduling'),
    schedulingRouter
  );
  // The Finance queue — mounted before /payroll so its stricter gate
  // (process:payroll) is the one that answers for this path.
  app.use('/payroll/financial-changes', requireCapability('process:payroll'), financialChangesRouter);
  // The payroll-tax desk: liabilities, deposits, returns, notices, agency accounts.
  app.use('/payroll-taxes', requireCapability('process:payroll'), payrollTaxesRouter);
  // The pay ↔ bill desk: reconciliation, margin per paycheck, billing terms, running cost.
  app.use('/pay-bill', requireAuth, payBillRouter);
  // Payroll banking: funding, employer accounts, NACHA files, returns, the payroll calendar.
  app.use('/payroll-banking', requireCapability('view:payroll'), bankingRouter);
  // The company's own books (2027-01): ledger, payables, bank, close, budgets, assets, QuickBooks.
  app.use('/books', booksRouter);
  app.use('/payroll/federal-w4', requireCapability('process:payroll'), federalW4Router);
  // Pay schedules and who is on them (rules, effective-dated moves) — before /payroll so its /:id routes don't shadow these.
  app.use('/payroll/pay-schedules', requireCapability('view:payroll'), paySchedulesRouter);
  // One person's pay schedule: payroll, or the onboarding desk setting a new hire's (gated inside).
  app.use('/associates', requireAuth, associatePayScheduleRouter);
  // Running payroll in-house: the company-level go-live checklist (lib/payrollGoLive).
  app.use('/payroll/go-live', requireCapability('process:payroll'), payrollGoLiveRouter);
  app.use('/payroll', requireCapability('view:payroll'), payrollRouter);
  // W-4 SSN re-collection campaign (2026-06-11 key-rotation remediation).
  // Same capability as the SSN reveal endpoint — this surface names who
  // has an unreadable SSN, which is payroll-admin territory.
  app.use(
    '/w4-recollection',
    requireCapability('process:payroll'),
    w4RecollectionRouter
  );
  // Certified payroll (prevailing wage) and the contractors (1099) desk.
  app.use('/certified-payroll', requireCapability('process:payroll'), certifiedPayrollRouter);
  app.use('/contractors', requireCapability('process:payroll'), contractorsRouter);
  // A contractor's own W-9.
  app.use('/me/w9', requireAuth, contractorSelfRouter);
  app.use(
    '/documents',
    requireCapability('view:documents'),
    documentsRouter
  );
  app.use(
    '/compliance',
    requireCapability('view:compliance'),
    complianceRouter
  );
  // What a site or client requires its people to hold (agent families step 5, coverage.credentials).
  app.use('/credential-requirements', requireCapability('view:compliance'), requireModule('compliance'), credentialRequirementsRouter);
  // Walmart Contract Compliance Scorecard — preventative dashboard
  // (separate from /audit which is the forensic event log).
  app.use(
    '/compliance-scorecard',
    requireCapability('view:compliance'),
    complianceScorecardRouter
  );
  app.use(
    '/analytics',
    requireCapability('view:dashboard'),
    analyticsRouter
  );
  // Product telemetry — a different question and a different audience from
  // the workforce analytics above, so its own capability rather than a
  // sub-path under view:dashboard.
  app.use('/product-analytics', productAnalyticsRouter);
  // The scheduled-jobs panel: last run, next run, last error per job (lib/jobs).
  app.use('/admin/jobs', scheduledJobsRouter);
  // Emergency Mode: the switch and the board are capability-gated inside;
  // /me and /check-in are for any signed-in associate.
  app.use('/emergency', emergencyRouter);
  // WhatsApp consent (any associate) and the admin record (view:communications).
  app.use('/whatsapp', whatsappRouter);
  // Program Lifecycle: J-1 / H-2B records, sponsors, alerts, the
  // transition calendar and sponsor reports (view/manage:compliance).
  app.use('/programs', requireModule('programs'), programsRouter);
  // Season Planner: demand → associates, beds, van seats, recruiting
  // targets; scenarios saved and compared (view/manage:org).
  app.use('/season-plans', requireModule('programs'), seasonPlansRouter);
  // Brief 3-4: the 26-week labor-demand forecast per site, and the planner's one-click start from it.
  app.use('/forecast', requireModule('scheduling'), forecastRouter);
  // Brief 3-3: one screen for people and machines, per site.
  app.use('/control-room', requireModule('scheduling'), controlRoomRouter);
  // Workers: people, agents and robots with an accountable owner (view/manage:org).
  // /workers is the one roster of people, agents and robots: never module-gated. The agent registry is.
  app.use('/workers', workersRouter);
  app.use('/agents', requireModule('agentBuilder'), agentsRouter);
  // Hugo in the app: the same intent registry as WhatsApp, for associates and desks (agent families step 3).
  app.use('/hugo', hugoRouter);
  // The browser's own report card (web vitals). Signed-in only; nothing
  // here is readable, it only feeds the rollups product-analytics reads.
  app.use('/telemetry', telemetryRouter);
  // "What's new" — readable by anyone signed in, written under manage:org.
  app.use('/release-notes', releaseNotesRouter);
  // ⌘K across every record kind; each group is gated by its page's capability.
  app.use('/search', searchRouter);
  // Out-of-office cover for the team inbox (view:my-team on both ends).
  app.use('/delegations', delegationsRouter);
  // One-click unsubscribe: mailbox providers POST this with no session, so
  // it must sit OUTSIDE the view:communications gate below. Mounted first —
  // Express matches the longer prefix before the gated /communications mount.
  app.use('/communications/unsubscribe', emailUnsubscribeRouter);
  // Your own inbox and push subscriptions: every signed-in account,
  // portal accounts included (they hold no communications capability).
  app.use('/communications/me', requireAuth, communicationsMeRouter);
  app.use(
    '/communications',
    requireCapability('view:communications'),
    communicationsRouter
  );
  app.use(
    '/performance',
    requireCapability('view:performance'),
    performanceRouter,
    // Phase 84 — goals/OKRs, 1:1s, kudos, PIPs, 360s. Same view:performance
    // gate at the prefix; per-route MANAGE checks for write paths.
    performance84Router
  );
  app.use(
    '/recruiting',
    requireCapability('view:recruiting'),
    recruitingRouter
  );
  app.use('/jobs', requireCapability('view:scheduling'), jobsRouter);
  // Approvals inbox badge — counts only; the queues render via their own routers.
  app.use('/approvals', approvalsRouter);
  // The approval engine: maker-checker requests, pay changes, delegation.
  app.use('/approvals', approvalRequestsRouter);
  app.use('/promotions', promotionsRouter);
  app.use('/admin/access-grants', accessGrantsRouter);
  // Named filter sets on lists (the candidate pipeline, first).
  app.use('/saved-views', savedViewsRouter);
  // Live "something changed" SSE nudges (bell + badge instant refresh).
  app.use('/events', eventsRouter);
  app.use('/audit', requireCapability('view:audit'), auditRouter);
  app.use('/benefits', requireCapability('view:payroll'), benefitsRouter);
  // Phase 76 — org hierarchy. Routes self-gate read vs write capability.
  app.use('/org', orgRouter);
  app.use('/people', directoryRouter);
  app.use('/executive', executiveRouter);
  app.use('/me', roleDecisionsRouter);
  // Every decision waiting on the signed-in person, as counts with links.
  app.use('/me', inboxRouter);
  // External payroll documentation — pay periods + evidence uploads for the
  // directory drawer's Payments tab. Router self-gates on process:payroll.
  app.use('/external-payments', requireModule('payrollSync'), externalPaymentsRouter);
  app.use('/ops', opsRouter);
  // Client-audit response packets (Walmart-scope ZIP). Self-gates on
  // view:hr-admin + bulk-PII limiter; every generation is critical-audited.
  app.use('/audit-packets', auditPacketRouter);
  // Phase 78 — positions / req-driven hiring.
  app.use('/positions', positionsRouter);
  // Phase 79 — manager-scoped approval queues.
  app.use('/team', teamRouter);
  // Phase 80 — workflow definitions + run history.
  app.use('/workflows', workflowsRouter);
  // Phase 81 — custom field definitions + per-entity values.
  app.use('/custom-fields', customFieldsRouter);
  // Phase 82 — associate self-service (no capability gate; uses
  // req.user.associateId on every route).
  app.use('/self', selfServiceRouter);
  // Ready-to-work handoffs: a supervisor's queue of hires awaiting a first
  // shift, and HR's view of who was told. Routes self-gate.
  app.use('/ready-to-work', requireModule('clientPortal'), readyToWorkRouter);
  // Phase 83 — compensation: routes self-gate per-handler with view:comp
  // / manage:comp.
  app.use('/comp', compensationRouter);
  // Phase 85 — qualifications + open-shift marketplace. Routes self-gate
  // per-handler and the /shifts/* paths sit alongside Phase 24's /scheduling
  // namespace deliberately — open shifts are inherently cross-client for
  // associates with multi-client visibility.
  app.use('/', qualificationsRouter);
  // Phase 86 — projects, premium-pay rules, tip pools. Self-gates per
  // route between view:time / manage:time / view:payroll / process:payroll.
  app.use('/', projectsAndPayRouter);
  // Phase 87 — directory + broadcast + surveys. Self-gates per route.
  app.use('/', directoryAndCommsRouter);
  // Phase 88 — OSHA / WC / EEO. Routes self-gate per-handler with
  // view:compliance / manage:compliance.
  app.use('/', oshaWcEeoRouter);
  // Phase 89 — versioned document templates with mail-merge rendering.
  app.use('/', docTemplatesRouter);
  // Phase 90 — interview kits, offers, referrals, careers page. Routes
  // self-gate per-handler with view:recruiting / manage:recruiting; the
  // /careers/* paths are public (no capability check).
  // Marketing: the careers funnel, employer brand, referral campaigns and
  // bonuses; /careers/brand and /careers/view are public. Mounted BEFORE
  // recruiting90, whose public /careers/:slug would otherwise take "brand".
  app.use('/', marketingRouter);
  app.use('/', recruiting90Router);
  // The candidate's own page (/candidate-portal/* is public, signed link),
  // document requests and the recruiter's iCal feed URL.
  app.use('/', candidatePortalRouter);
  // Client NPS: /executive/nps for the readers, /nps/:token for the answer.
  app.use('/', clientNpsRouter);
  // Pay and bill-rate intelligence: the market rates desk (routes self-gate on view:clients).
  app.use('/', marketRatesRouter);
  // Standards-based credentials: the worker's signed credentials, the issuer's
  // DID documents and revocation list, and the public verifier (routes self-gate).
  app.use('/', credentialsRouter);
  // Phase 91 — garnishments + tax forms (941, 940, W-2, 1099-NEC).
  // Self-gates per-handler with view:payroll / process:payroll.
  app.use('/', payrollTax91Router);
  // PAYEXP — daily pay, manual checks, third-party sick pay, pay check before payday, W-4 estimator (self-gates).
  app.use('/', payExpRouter);
  // DEDUCT — the garnishment desk: e-IWO, state rules, levy tables, electronic remittance (self-gates process:payroll).
  app.use('/', garnishmentDeskRouter);
  // CHECKS — pay by paper check this time, printing, void/reissue/stop, positive pay (self-gates).
  app.use('/', paperChecksRouter);
  // DEDUCT — 401(k) plans, elections, loans and recordkeeper files (self-gates process:payroll).
  app.use('/', retirementRouter);
  // DEDUCT — benefit carrier connections and EDI 834 enrollment files (self-gates process:payroll).
  app.use('/', benefitCarriersRouter);
  // TAXCOMP — state withholding coverage, acknowledgments and certificates.
  app.use('/', stateTaxRouter);
  app.use('/', deductionTreatmentRouter);
  // Local and multi-state taxes: jurisdictions, review, a person's tax setup (lib/taxEngine).
  app.use('/', taxJurisdictionsRouter);
  // TAXCOMP — WOTC screening, filing tracker and credit.
  app.use('/', wotcRouter);
  // TAXCOMP — ACA look-back measurement and the 1095-C feed.
  app.use('/', acaRouter);
  // Phase 92 — open enrollment, QLE, COBRA, ACA reporting. Self-gates
  // per-handler with view:payroll / process:payroll.
  app.use('/', benefitsLifecycle92Router);
  // Phase 93 — public API keys + outbound webhooks. Self-gates per
  // handler with view:integrations / manage:integrations.
  app.use('/', apiKeysWebhooks93Router);
  // Phase 94 — LMS: courses, modules, enrollments, certifications.
  // Self-gates per handler with view:compliance / manage:compliance.
  app.use('/', lms94Router);
  // Phase 95 — worktags: multi-dimensional categorical tags on
  // transactions. Self-gates per handler with view:payroll /
  // process:payroll.
  app.use('/', worktags95Router);
  // Phase 96 — saved reports + scheduled deliveries. All routes
  // require view:dashboard; spec validation prevents column/filter
  // injection.
  app.use('/', reports96Router);
  // Phase 97 — reimbursements + expense lines. Submitting routes are
  // open to authenticated users (route checks ownership); approve/pay
  // require process:payroll.
  app.use('/', reimbursements97Router);
  app.use('/', clientPortalRouter);
  app.use('/', financeOverviewRouter);
  app.use('/', workforceOverviewRouter);
  app.use('/', companyClockRouter);
  app.use('/', relayRouter);
  app.use('/', relayWorkRouter);
  app.use('/', clientRequestsRouter);
  // Phase 99 — kiosk-mode clock in/out. Admin endpoints self-gate with
  // view:time / manage:time; the public /kiosk/punch endpoint authenticates
  // via the device token (no user session needed).
  app.use('/', kiosk99Router);
  app.use('/', celebrationsRouter);
  app.use('/', assetsRouter);
  // Tenant modules `talent` and `perks` (Brief 2-1b). The routers below
  // mount at '/', so the gate sits on their path prefixes rather than the
  // mount: an off module answers 404 on every path it owns and nothing
  // else notices. Keep these lists in step with the routers' paths.
  app.use(
    [
      '/skills', '/associate-skills',
      '/career-ladders', '/career-levels',
      '/mentorships',
      '/succession',
      '/probations',
      '/ramp-plans', '/ramp-milestones',
      '/learning-paths', '/learning-path-steps', '/my/learning-paths',
      '/internal-jobs', '/internal-applications', '/my/internal-applications',
      '/pulse-surveys', '/my/pulse-surveys',
    ],
    requireModule('talent'),
  );
  app.use(
    [
      '/tuition-requests', '/tuition-summary', '/my/tuition-requests',
      '/equity-grants', '/my/equity-grants',
      '/volunteer-entries', '/volunteer-summary', '/vto-policy', '/my/volunteer-entries',
    ],
    requireModule('perks'),
  );
  app.use('/', pulseSurveysRouter);
  app.use('/', headcount110Router);
  app.use('/', skills111Router);
  app.use('/', mentorship112Router);
  app.use('/', expirationRiskRouter);
  app.use('/', staffingPlanRouter);
  app.use('/', expirations113Router);
  app.use('/', learningPaths114Router);
  app.use('/', succession115Router);
  // Succession by store (lead seats and their bench) and the 9-box.
  app.use('/', successionBenchRouter);
  app.use('/', probation116Router);
  app.use('/', holiday117Router);
  app.use('/', discipline118Router);
  app.use('/', separation119Router);
  // Leave of absence and claims (manage:leave / manage:claims; /me/leave for the worker).
  app.use('/', leaveRouter);
  app.use('/', claimsRouter);
  app.use('/', internalMobility120Router);
  app.use('/', vaccination121Router);
  app.use('/', agreements122Router);
  app.use('/', hrCases123Router);
  app.use('/', kb124Router);
  // HR pack (2026-10): policy campaigns, verification letters, retention, mass update.
  app.use('/', policyCampaignsRouter);
  app.use('/', verificationLettersRouter);
  app.use('/', documentRetentionRouter);
  app.use('/', massUpdateRouter);
  app.use('/', peopleAnalyticsRouter);
  app.use('/', ramp125Router);
  app.use('/', career126Router);
  app.use('/', tuition127Router);
  app.use('/', anonReport128Router);
  app.use('/', equity129Router);
  app.use('/', vto130Router);
  // Profile photo upload + stream. Self-gated with requireAuth, plus an
  // associate-only check on the /me/profile-photo write paths.
  app.use('/', profilePhotoRouter);
  // Native apps (apps/mobile): devices + push tokens, the Keychain session,
  // the system-browser sign-in handoff, and the worker's Wallet badge.
  app.use('/', nativeAppRouter);
  // HR user-admin (list / patch role + status / force password reset).
  // Self-gates per route on view:hr-admin.
  app.use('/', usersRouter);
  app.use('/', employersRouter);
  // Pay compliance: limits + Roth catch-up, state pay notices, new-hire reporting. Self-gated per route.
  app.use('/', payrollComplianceRouter);
  app.use('/', orgUnitsRouter);
  app.use('/', structureRouter);
  app.use('/', complianceEvidenceRouter);
  // Access pack: access certification campaigns for every tenant.
  app.use('/', accessCertificationsRouter);
  app.use('/', shiftWindowsRouter);
  // Floor supervisors' shift supervisor, and shift hand-overs (covers).
  app.use('/', floorTeamRouter);
  // The floor from a phone: incidents with a photo, flags, the week, a text
  // to the crew, the handover, and "Cover this shift" (routes/floor.ts).
  app.use('/', floorRouter);
  // Open-shift invitations: Rebroadcast, sent/declined counts, the associate's "Not for me" (lib/openShiftInvites).
  app.use('/', openShiftInvitesRouter);
  // Call-outs: a worker's "I can't make it" from any channel, and the leads' view (lib/callOuts).
  app.use('/', callOutsRouter);
  // Retention desk: flight-risk scores with their reasons, and the plays leads take (lib/retention).
  app.use('/', retentionRouter);
  // The credential wallet: mine, and the link I share (public by its token).
  app.use('/', walletRouter);
  // Transportation — the Alto vans: rides, dispatch, drivers, the
  // director's command center. Gated per route (routes/transport.ts).
  // Brief 2-1b: an off module answers 404 on its whole mount.
  app.use('/transport', requireModule('transportation'), transportRouter);
  // The driver and fleet pack: pre-trip checks, the safety toolkit, incidents,
  // standing bookings, the fleet record, driver shifts (routes/transportOps.ts).
  app.use('/transport', requireModule('transportation'), transportOpsRouter);
  // Org-wide branding (singleton OrgSetting). Admin paths gate on
  // view:hr-admin; the logo GET is open so any signed-in chrome can
  // render it (and so HTML emails — which are public — can fetch it).
  app.use('/', orgSettingsRouter);
  app.use('/', tenancyRouter);
  // Intuit returns to the one redirect URI registered for the app
  // (/api/quickbooks/connect/callback, from the retired per-client payroll
  // connection). The company's own books (lib/books/qbo) is the only
  // QuickBooks integration now, so every return goes on to its callback;
  // it verifies the signed state itself.
  app.get('/quickbooks/connect/callback', (req, res) => {
    const qs = new URLSearchParams(req.query as Record<string, string>).toString();
    res.redirect(`${env.APP_BASE_URL}/api/books/quickbooks/callback?${qs}`);
  });

  // Production: the same Express service hosts the built React SPA. In dev,
  // Vite serves the SPA on its own port (5173) and proxies /api/* here, so
  // there's no static to mount. Gated on `existsSync(WEB_DIST)` as a belt-
  // and-braces check — running the API standalone in prod (no web build
  // present) shouldn't 500 every request from express.static.
  if (env.NODE_ENV === 'production' && existsSync(WEB_DIST)) {
    // Vite content-hashes everything under /assets, so a given URL's bytes
    // can never change — cache forever. A deploy changes the hash, and the
    // no-cache index.html below picks up the new URLs immediately.
    app.use(
      '/assets',
      express.static(path.join(WEB_DIST, 'assets'), {
        maxAge: '1y',
        immutable: true,
        index: false,
      })
    );
    // Everything else in dist (manifest, icons, face-models) isn't hashed —
    // keep the shorter TTL. `index: false` so we explicitly hand `/` to the
    // SPA fallback below.
    // ...except the two files a deploy rewrites under the SAME name: the
    // service worker and the precache manifest it reads. Those revalidate
    // on every request, so a new build is seen the moment it is live.
    app.use(
      express.static(WEB_DIST, {
        maxAge: '1d',
        index: false,
        setHeaders: (res, filePath) => {
          if (/[\\/](sw\.js|asset-manifest\.json)$/.test(filePath)) {
            res.setHeader('Cache-Control', 'no-cache');
          }
        },
      })
    );
    app.get('*', (req, res, next) => {
      // If the original URL was /api/*, the request was tagged by
      // stripApiPrefix. Skip the SPA fallback so unmatched API endpoints
      // return JSON 404 (via notFoundHandler) instead of HTML 200.
      if ((req as Request & { isApiCall?: boolean }).isApiCall) return next();
      // A build artifact that isn't there is a 404, not the app.
      //
      // Every deploy content-hashes the bundles, so a tab that has been
      // open across one asks for chunk names the server no longer has.
      // Answering those with index.html hands the browser HTML where it
      // expects a module, which surfaces as "Failed to fetch dynamically
      // imported module" — a message that describes neither the cause nor
      // the cure. A plain 404 lets the client recognise a stale deploy and
      // reload into the new build.
      if (isBuildArtifactRequest(req.path)) {
        res.status(404).type('text/plain').send('Not found');
        return;
      }
      // The kiosk is a second HTML entry whose <head> statically links the
      // kiosk web-app manifest, so "Add to Home Screen" installs the
      // standalone kiosk app rather than the main SPA. Serve it for /kiosk
      // (and any /kiosk/* deep link). Everything else gets the main SPA.
      const isKiosk =
        req.path === '/kiosk' || req.path.startsWith('/kiosk/');
      const file = isKiosk ? 'kiosk.html' : 'index.html';
      // no-cache (revalidate, not "don't store") so every navigation checks
      // for a new deploy's HTML — the asset URLs inside are what actually
      // bust the immutable /assets cache above.
      res.sendFile(path.join(WEB_DIST, file), {
        headers: { 'Cache-Control': 'no-cache' },
      });
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
