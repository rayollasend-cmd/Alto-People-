import type { PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';
import { prisma as defaultPrisma } from '../db.js';
import { enqueueAudit } from './audit.js';
import { armJob, stopJob } from './jobs.js';
import { tenantJob } from './tenantJobs.js';

/**
 * Robot incident evidence retention (audit 2026-10-21; docs/robots-investigation.md:
 * "the hour's samples, events and the people on shift copied in as evidence, kept
 * five years"). reportIncident stamps retainUntil five years out; until this sweep
 * nothing read it. Once a day, per tenant with robotics on, every incident past
 * its retainUntil loses the copied evidence — samples, events, people on shift —
 * and is stamped evidencePurgedAt. The report itself (kind, when, what happened,
 * who reported it, the OSHA link) stays: the retention rule is for the evidence,
 * not the record.
 */

export interface IncidentRetentionResult {
  purged: number;
}

export async function purgeExpiredIncidentEvidence(db: PrismaClient = defaultPrisma, tenantId: string | null = null, now: Date = new Date()): Promise<IncidentRetentionResult> {
  const today = new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
  const due = await db.robotIncident.findMany({
    where: { retainUntil: { lt: today }, evidencePurgedAt: null, ...(tenantId ? { tenantId } : {}) },
    select: { id: true, workerId: true, tenantId: true, retainUntil: true },
    take: 1000,
  });
  for (const i of due) {
    await db.robotIncident.update({
      where: { id: i.id },
      data: { samples: [], events: [], peopleOnShift: [], evidencePurgedAt: now },
    });
    enqueueAudit(
      { actorUserId: null, clientId: null, tenantId: i.tenantId, workerId: i.workerId, action: 'robot.incident_evidence_purged', entityType: 'RobotIncident', entityId: i.id, metadata: { retainUntil: i.retainUntil.toISOString().slice(0, 10) } },
      'robots',
    );
  }
  return { purged: due.length };
}

/** Armed through the scheduled-jobs registry so the admin panel shows its last and next run. */
export function startRobotIncidentRetentionCron(): void {
  armJob({
    name: 'robotIncidentRetention',
    label: 'Robot incident evidence retention',
    intervalSeconds: env.ROBOT_INCIDENT_RETENTION_INTERVAL_SECONDS,
    run: tenantJob('robotIncidentRetention', () => purgeExpiredIncidentEvidence(), { module: 'robotics' }),
    // Nothing here is urgent at boot; the first pass waits one interval.
    immediate: false,
    note: 'Removes the copied samples, events and people on shift from robot incidents past their five-year retention; the report stays.',
  });
}

export function stopRobotIncidentRetentionCron(): void {
  stopJob('robotIncidentRetention');
}
