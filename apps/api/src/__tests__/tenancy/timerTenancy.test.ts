import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { TENANT_EXEMPT_MODELS } from '../../lib/tenantGuard.js';

/**
 * Audit 2026-10-29 (CRAWL-4, CRAWL-5, crawl upgrade #4): every timer and boot
 * step the API arms from index.ts runs inside a tenant (runForEachTenant /
 * tenantJob / runWithTenant) or the audited platform scope (platformJob /
 * withPlatformScope). Four jobs were hand-wired wrong and the tenancy wall
 * refused them every boot or every 15 minutes, silently: the agents'
 * approval expiry, the platform-scope audit row, the webhook secret seal and
 * the SOP library seed.
 *
 * A static walk with the TypeScript compiler, no database:
 *   1. index.ts arms no timers of its own (lib/bootJobs.ts does, via armJob).
 *   2. For every start / install / arm function index.ts calls, and every
 *      module-local function those reach (a setInterval tick, a `run`), a
 *      Prisma call (`prisma.model.op(…)`) or a call handed the Prisma client
 *      (`sweep(prisma)`) must sit inside one of the wrappers. index.ts's own
 *      boot steps are held to the same rule.
 *   3. A ratchet: the modules still arming a bare setInterval (no in-flight
 *      guard, not on the Scheduled jobs panel) are listed here, and the list
 *      only shrinks — new timers go through armJob.
 * bootJobs.test.ts runs the same jobs against the database under the wall.
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const INDEX = resolve(SRC, 'index.ts');

const WRAPPERS = new Set(['tenantJob', 'runForEachTenant', 'platformJob', 'withPlatformScope', 'runWithTenant', 'withTenantTelemetry']);
const CLIENT_NAMES = new Set(['prisma', 'defaultPrisma', 'db', 'appPrisma']);

/**
 * Boot calls that hand over the client but are safe outside a tenant, each with its reason.
 * Keyed "file:callee".
 */
const SAFE_OUTSIDE_TENANT: Record<string, string> = {
  'index.ts:verifyKeyring': 'field-encryption key canaries are platform rows (KeyCanary is not tenant-scoped)',
  'lib/keepalive.ts:ping': 'SELECT 1 on the pool; no model',
};

/**
 * Modules that still arm a bare setInterval. Convert one to armJob (the in-flight guard and the
 * Scheduled jobs panel come with it) and delete it here; never add to this list.
 */
const LEGACY_RAW_TIMERS = new Set([
  'lib/accessCertification.ts', 'lib/accessChanges.ts', 'lib/accessCleanup.ts', 'lib/agentControls.ts', 'lib/attestationReminder.ts',
  'lib/autoClockOut.ts', 'lib/banking/cron.ts', 'lib/billing.ts', 'lib/clientNps.ts', 'lib/complianceAgent.ts', 'lib/complianceSnapshot.ts',
  'lib/dailyPay.ts', 'lib/documentMaintenance.ts', 'lib/dormancySweep.ts', 'lib/equityExpiry.ts', 'lib/evidence.ts', 'lib/executiveAlerts.ts',
  'lib/executiveDigest.ts', 'lib/expirationDigest.ts', 'lib/forecast/cron.ts', 'lib/hrCaseSla.ts', 'lib/inviteDelivery.ts', 'lib/inviteReminder.ts',
  'lib/keepalive.ts', 'lib/laborRules/shadow.ts', 'lib/marketWages.ts', 'lib/memoryWatch.ts', 'lib/noShowRisk.ts', 'lib/notificationDelivery.ts',
  'lib/notificationRetention.ts', 'lib/offerLetters.ts', 'lib/onboardingPurge.ts', 'lib/opsDigest.ts', 'lib/payrollAgent.ts', 'lib/policyCampaigns.ts',
  'lib/portalCoverageAlert.ts', 'lib/portalDigest.ts', 'lib/portalEngagement.ts', 'lib/productEvents.ts', 'lib/programDigest.ts', 'lib/readyToWork.ts',
  'lib/recruitingCleanup.ts', 'lib/relayEscalation.ts', 'lib/reliabilityDigest.ts', 'lib/reportScheduleRunner.ts', 'lib/retention.ts',
  'lib/securityAlerts.ts', 'lib/serviceReportMailer.ts', 'lib/shiftAutofill.ts', 'lib/staleNudge.ts', 'lib/statementDunning.ts', 'lib/storeShiftSop.ts',
  'lib/tasks/sweep.ts', 'lib/timeOffPolicy.ts', 'lib/uploadsBackup.ts',
  'lib/usageTracker.ts', 'lib/webVitals.ts', 'lib/workflow.ts', 'middleware/idempotency.ts',
]);

interface Parsed {
  rel: string;
  sf: ts.SourceFile;
  fns: Map<string, ts.Node>;
}

const cache = new Map<string, Parsed>();
function parse(rel: string): Parsed {
  const hit = cache.get(rel);
  if (hit) return hit;
  const text = readFileSync(resolve(SRC, rel), 'utf8');
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  // Module-level and nested named functions / arrow consts, by name (a tick, a run, a sweep).
  const fns = new Map<string, ts.Node>();
  const visit = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) && n.name && n.body) fns.set(n.name.text, n.body);
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) {
      fns.set(n.name.text, n.initializer.body);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  const p = { rel, sf, fns };
  cache.set(rel, p);
  return p;
}

function calleeName(call: ts.CallExpression): string | null {
  const c = call.expression;
  if (ts.isIdentifier(c)) return c.text;
  if (ts.isPropertyAccessExpression(c)) return c.name.text;
  return null;
}

/** The identifier at the root of `a.b.c(...)`. */
function rootOf(e: ts.Expression): string | null {
  let cur: ts.Expression = e;
  while (ts.isPropertyAccessExpression(cur) || ts.isCallExpression(cur) || ts.isNonNullExpression(cur)) cur = ts.isCallExpression(cur) ? cur.expression : cur.expression;
  return ts.isIdentifier(cur) ? cur.text : null;
}

/** A call to a wrapper: `tenantJob(…)`, or `tenantJob(…)()` (the wrapper's returned job, called). */
function isWrapperCall(call: ts.CallExpression): boolean {
  if (ts.isIdentifier(call.expression) && WRAPPERS.has(call.expression.text)) return true;
  if (ts.isCallExpression(call.expression)) return isWrapperCall(call.expression);
  return false;
}

interface Finding {
  where: string;
  call: string;
}

/**
 * Walk `body` (in `p`) for Prisma use outside a wrapper. Subtrees that are a wrapper call's
 * arguments are skipped; calls to local functions are followed once.
 */
function walk(p: Parsed, body: ts.Node, out: Finding[], seen: Set<string>, imported: Set<string>): void {
  const visit = (n: ts.Node) => {
    // A named local function's body is walked where it is referenced (it runs then), not where it is declared.
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name) && p.fns.get(n.parent.name.text) === n.body) return;
    if (ts.isFunctionDeclaration(n) && n.name && n !== body.parent) return;
    if (ts.isCallExpression(n)) {
      if (isWrapperCall(n)) return; // everything inside runs in a tenant or the platform scope
      const name = calleeName(n);
      const root = rootOf(n.expression);
      const at = `${p.rel}:${p.sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
      // prisma.model.op(...) — but not the client's own $-methods (raw SQL on the pool, disconnect),
      // nor the models the wall exempts (Tenant itself: a job lists the tenants it then enters).
      if (root && CLIENT_NAMES.has(root) && ts.isPropertyAccessExpression(n.expression) && !n.expression.name.text.startsWith('$')) {
        const model = ts.isPropertyAccessExpression(n.expression.expression) ? n.expression.expression.name.text : '';
        if (!TENANT_EXEMPT_MODELS.has(model.charAt(0).toUpperCase() + model.slice(1))) out.push({ where: at, call: n.expression.getText(p.sf) });
      } else if (
        name &&
        !imported.has(name) &&
        // A local function is followed below and its body checked; the client handed to anything else runs right here.
        !(ts.isIdentifier(n.expression) && p.fns.has(name)) &&
        !SAFE_OUTSIDE_TENANT[`${p.rel}:${name}`] &&
        n.arguments.some((a) => ts.isIdentifier(a) && CLIENT_NAMES.has(a.text))
      ) {
        out.push({ where: at, call: `${name}(${n.arguments.map((a) => a.getText(p.sf)).join(', ')})` });
      }
    }
    // A local function referenced here (setInterval(tick), run: sweep, tick()) runs too: follow it.
    if (ts.isIdentifier(n) && p.fns.has(n.text) && !seen.has(`${p.rel}#${n.text}`)) {
      const parent = n.parent;
      const isDecl = (ts.isVariableDeclaration(parent) && parent.name === n) || (ts.isFunctionDeclaration(parent) && parent.name === n);
      if (!isDecl) {
        seen.add(`${p.rel}#${n.text}`);
        walk(p, p.fns.get(n.text)!, out, seen, imported);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(body);
}

/** index.ts's imports: local name → module path (relative to src). */
function indexImports(): Map<string, string> {
  const p = parse('index.ts');
  const map = new Map<string, string>();
  for (const st of p.sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const spec = st.moduleSpecifier.text;
    if (!spec.startsWith('./')) continue;
    const rel = spec.slice(2).replace(/\.js$/, '.ts');
    const named = st.importClause?.namedBindings;
    if (named && ts.isNamedImports(named)) for (const el of named.elements) map.set(el.name.text, rel);
  }
  return map;
}

/** The start / install / arm functions index.ts calls, with their modules. */
function bootEntryPoints(): Array<{ name: string; rel: string }> {
  const imports = indexImports();
  const p = parse('index.ts');
  const called = new Set<string>();
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) called.add(n.expression.text);
    ts.forEachChild(n, visit);
  };
  visit(p.sf);
  return [...imports.entries()]
    .filter(([name]) => called.has(name) && /^(start|install|arm)[A-Z]/.test(name))
    .map(([name, rel]) => ({ name, rel }));
}

describe('timers and boot steps run inside a tenant (CRAWL-4 / CRAWL-5)', () => {
  it('index.ts arms no timer of its own before the shutdown section', () => {
    const text = readFileSync(INDEX, 'utf8');
    const boot = text.slice(0, text.indexOf('// Graceful shutdown'));
    expect(boot.length).toBeGreaterThan(1000);
    const lines = boot.split('\n').map((l, i) => ({ l, i: i + 1 })).filter(({ l }) => /\bset(Interval|Timeout)\(/.test(l) && !l.trim().startsWith('//'));
    expect(lines.map(({ l, i }) => `index.ts:${i} ${l.trim()}`)).toEqual([]);
  });

  it('finds the boot entry points (sanity: the walk sees what index.ts arms)', () => {
    const names = bootEntryPoints().map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(['armBootJobs', 'installPlatformScopeAudit', 'startWebhookDeliveryCron', 'startOpsSopCron', 'startAuditSinkCron']));
    expect(names.length).toBeGreaterThan(60);
  });

  it('no Prisma call reachable from a boot step or its timers runs outside a wrapper', () => {
    const imported = new Set(indexImports().keys());
    const findings: Finding[] = [];
    // index.ts's own boot steps (its imported start*/arm* calls are walked in their modules below).
    const index = parse('index.ts');
    walk(index, index.sf, findings, new Set(), imported);
    for (const { name, rel } of bootEntryPoints()) {
      if (!existsSync(resolve(SRC, rel))) continue;
      const p = parse(rel);
      const body = p.fns.get(name);
      expect(body, `${rel} exports ${name}`).toBeDefined();
      walk(p, body!, findings, new Set([`${rel}#${name}`]), new Set());
    }
    expect(findings.map((f) => `${f.where} ${f.call}`)).toEqual([]);
  });

  it('the walk would have caught the four jobs the audit found', () => {
    const fixture = `
      import { tenantJob, runForEachTenant } from './tenantJobs.js';
      export function startX(): void {
        void sealLegacyWebhookSecrets(defaultPrisma).catch(() => {});
        void ensureOpsSeed(defaultPrisma);
        const tick = () => void tenantJob('x', () => deliver(defaultPrisma))().catch(() => {});
        setInterval(tick, 1000);
        const sweep = () => runForEachTenant('agents', (t) => ensureBuiltInAgents(prisma, t)).then(() => expireApprovals(prisma));
        setInterval(sweep, 1000);
        setInterval(run, 1000);
      }
      async function run() { await prisma.webhook.findMany(); }
    `;
    const sf = ts.createSourceFile('fixture.ts', fixture, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const fns = new Map<string, ts.Node>();
    const collect = (n: ts.Node) => {
      if (ts.isFunctionDeclaration(n) && n.name && n.body) fns.set(n.name.text, n.body);
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isArrowFunction(n.initializer)) fns.set(n.name.text, n.initializer.body);
      ts.forEachChild(n, collect);
    };
    collect(sf);
    const out: Finding[] = [];
    walk({ rel: 'fixture.ts', sf, fns }, fns.get('startX')!, out, new Set(['fixture.ts#startX']), new Set());
    expect(out.map((f) => f.call)).toEqual(['sealLegacyWebhookSecrets(defaultPrisma)', 'ensureOpsSeed(defaultPrisma)', 'expireApprovals(prisma)', 'prisma.webhook.findMany']);
  });

  it('bare setInterval timers only shrink (new ones go through armJob)', () => {
    const raw = new Set<string>();
    for (const { rel } of bootEntryPoints()) {
      if (!existsSync(resolve(SRC, rel))) continue;
      const text = readFileSync(resolve(SRC, rel), 'utf8');
      if (/\bsetInterval\(/.test(text)) raw.add(rel);
    }
    const added = [...raw].filter((r) => !LEGACY_RAW_TIMERS.has(r)).sort();
    const converted = [...LEGACY_RAW_TIMERS].filter((r) => !raw.has(r)).sort();
    expect({ newBareTimers: added, convertedStillListed: converted }).toEqual({ newBareTimers: [], convertedStillListed: [] });
  });
});
