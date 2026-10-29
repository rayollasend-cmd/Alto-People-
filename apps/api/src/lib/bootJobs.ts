import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { armJob, runJobNow, type JobDefinition } from './jobs.js';
import { runForEachTenant, tenantJob } from './tenantJobs.js';
import { onPlatformScope, runWithTenant } from './tenant.js';
import { enqueueAudit } from './audit.js';
import { ensurePersonWorkers } from './workers.js';
import { ensureBuiltInAgents, expireApprovals } from './agents.js';
import { syncAllPlans } from './retirement.js';
import { applyDueBackupWithholding } from './contractors.js';
import { sweepTenantSchedules } from './payScheduleMembership.js';
import { runBooksJobs } from './books/jobs.js';
import { runScheduledSyncs } from './integrations/sync.js';
import { sampleRobots } from './robots.js';

/**
 * The sweeps the boot used to wire by hand in index.ts (audit 2026-10-29,
 * CRAWL-4 / CODE-23).
 *
 *   Each was a bare setInterval: no in-flight guard (a slow QuickBooks pull
 *   let two book sweeps overlap), nothing on the Scheduled jobs panel, and
 *   one of them (the agent approvals' expiry) ran AFTER its per-tenant loop,
 *   with no tenant in context, so the tenancy wall refused it every 15
 *   minutes and nothing ever expired. Every one now goes through armJob (the
 *   guard, the panel) and runs per tenant (runForEachTenant / tenantJob).
 *   bootJobs.test.ts runs each definition under the strict wall, and
 *   timerTenancy.test.ts keeps index.ts free of hand-wired timers.
 */
export interface BootJob extends JobDefinition {
  /** The first tick waits this long after boot (heavier sweeps stagger off the warm-up). */
  firstDelaySeconds?: number;
}

export function bootJobDefinitions(db: PrismaClient = defaultPrisma): BootJob[] {
  return [
    {
      // Brief 1D-1: a PERSON worker for every associate, so an import that bypassed the API still ends up owned.
      name: 'personWorkers',
      label: 'Person workers for every associate',
      intervalSeconds: 15 * 60,
      run: tenantJob('workers', () => ensurePersonWorkers(db)),
    },
    {
      // Brief 1D-2 + agent families step 0: built-in agents per tenant, and unanswered approval requests expire — inside the same tenant.
      name: 'agentSweep',
      label: 'Built-in agents and expiring agent approvals',
      intervalSeconds: 15 * 60,
      run: () =>
        runForEachTenant('agents', async (tenantId) => {
          await ensureBuiltInAgents(db, tenantId);
          await expireApprovals(db, new Date(), tenantId);
        }),
    },
    {
      // DEDUCT: 401(k) eligibility, auto-enroll after the opt-out window, and yearly escalation (idempotent).
      name: 'retirementElections',
      label: 'Retirement elections (eligibility, auto-enroll, escalation)',
      intervalSeconds: 6 * 60 * 60,
      firstDelaySeconds: 10 * 60,
      run: tenantJob('retirement-elections', () => syncAllPlans(db)),
    },
    {
      // Contractors: backup withholding starts on payees whose B-notice deadline passed unanswered (IRS Pub 1281).
      name: 'backupWithholding',
      label: 'Contractor backup withholding',
      intervalSeconds: 60 * 60,
      run: tenantJob('backup-withholding', () => applyDueBackupWithholding(db)),
    },
    {
      // Pay schedules: everyone against the membership rules, and the mirror flipped for moves that start today.
      name: 'paySchedules',
      label: 'Pay schedule membership',
      intervalSeconds: 3 * 60 * 60,
      firstDelaySeconds: 5 * 60,
      run: tenantJob('pay-schedules', () => sweepTenantSchedules(db)),
    },
    {
      // The books: recurring bills, bank feeds, accrual reversals, depreciation, the QuickBooks outbox and pull.
      name: 'books',
      label: 'Books (recurring bills, feeds, QuickBooks)',
      intervalSeconds: 5 * 60,
      firstDelaySeconds: 2 * 60,
      run: tenantJob('books', () => runBooksJobs(db)),
    },
    {
      // Brief 3-5: the HR and VMS connections sync on their schedule (the clock is checked per tenant).
      name: 'integrations',
      label: 'Integration syncs on schedule',
      intervalSeconds: 5 * 60,
      immediate: false,
      run: () => runForEachTenant('integrations', (tenantId) => runScheduledSyncs(tenantId)),
    },
    {
      // Brief 3-1: every robot's fleet status, once a minute per tenant with robotics on.
      name: 'robotSampling',
      label: 'Robot fleet sampling',
      intervalSeconds: 60,
      run: () => runForEachTenant('robots', (tenantId) => sampleRobots(db, tenantId), { module: 'robotics' }),
    },
  ];
}

/** Arm every boot sweep through the jobs registry (in-flight guard, Scheduled jobs panel). */
export function armBootJobs(db: PrismaClient = defaultPrisma): void {
  for (const def of bootJobDefinitions(db)) {
    const { firstDelaySeconds, ...job } = def;
    if (firstDelaySeconds === undefined) {
      armJob(job);
      continue;
    }
    // A delayed first tick still goes through the registry, so it can't stack on a timer tick.
    if (armJob({ ...job, immediate: false })) setTimeout(() => void runJobNow(job.name), firstDelaySeconds * 1000).unref();
  }
}

/**
 * Brief 2-1, step two: every cross-tenant view the platform opens is on the
 * record — once an hour per call site (a timed flush must not write an audit
 * row a minute). The row is written as the scope's own tenant: the hook runs
 * where the scope was opened, which at boot or in a timer is no tenant at all,
 * and the wall refused every one of these rows (CRAWL-5).
 */
export function installPlatformScopeAudit(): () => void {
  const seen = new Map<string, number>();
  let installed = true;
  onPlatformScope((ctx, callSite) => {
    if (!installed) return;
    const last = seen.get(callSite) ?? 0;
    if (Date.now() - last < 3_600_000) return;
    seen.set(callSite, Date.now());
    void runWithTenant(ctx.tenantId, 'job', () =>
      enqueueAudit(
        { actorUserId: null, clientId: null, action: 'platform.scope_opened', entityType: 'Tenant', entityId: ctx.tenantId, metadata: { callSite } },
        'tenancy',
      ),
    );
  });
  // Tests uninstall it; the boot never does.
  return () => {
    installed = false;
  };
}
