import type { PrismaClient, Role } from '@prisma/client';
import { hasCapability, rolesWithCapability } from '@alto-people/shared';
import { enqueueAudit } from './audit.js';
import { notifyUser } from './notify.js';
import { send } from './notifications.js';
import { ALTO_TENANT_ID, tenantIdForWrite } from './tenant.js';
import { platformJob } from './tenantJobs.js';

/**
 * Brief 2-5 step 7 — alerting from the audit trail
 * (docs/soc2-controls-investigation.md §4.2, §4.5; CC6.3, CC7.2).
 *
 *   Every five minutes, over the last fifteen minutes of audit rows:
 *
 *     FAILED_SIGNINS_IP  ten or more failed sign-ins from one address
 *     LOCKED_ACCOUNT     sign-in attempts on a locked account
 *     MFA_OFF_ADMIN      two-step sign-in turned off on an admin account
 *     PRIVILEGE_CHANGE   an account given an admin-capable role or a region,
 *                        an agent's scopes widened, a gated agent action approved
 *     EXPORTS            twenty or more exports by one person, or an export of
 *                        pay, tax, identity or bank data
 *
 *   One alert per rule and key an hour, to the security contact by email
 *   (OrgSetting.securityContactEmail) and in the bell of the operator's
 *   org admins (never Finance: the handoff-spine rule). Each alert is a
 *   SecurityAlert row and an audit row. No request path slows down.
 */

type Db = PrismaClient;

export const ALERT_WINDOW_MS = 15 * 60_000;
const DEDUPE_MS = 60 * 60_000;
const FAILED_SIGNIN_THRESHOLD = 10;
const EXPORT_THRESHOLD = 20;
const SENSITIVE_EXPORT = /payroll|tax|w-?2|w-?4|1099|i-?9|ssn|bank|payout|disburse|garnish|salary|comp/i;

export type AlertRule = 'FAILED_SIGNINS_IP' | 'LOCKED_ACCOUNT' | 'MFA_OFF_ADMIN' | 'PRIVILEGE_CHANGE' | 'EXPORTS' | 'AUDIT_CHAIN';

export interface Candidate {
  rule: AlertRule;
  key: string;
  summary: string;
  auditLogIds: string[];
}

const adminCapable = (role: string | null | undefined) => !!role && (hasCapability(role as Role, 'manage:org') || hasCapability(role as Role, 'view:hr-admin'));

type Row = { id: string; action: string; actorUserId: string | null; entityId: string; metadata: unknown; createdAt: Date };
const meta = (r: Row) => (r.metadata as Record<string, unknown> | null) ?? {};

/** The alerts the rows in the window call for (pure over the rows; roles looked up for MFA). */
export async function evaluateAlertRules(db: Db, rows: Row[]): Promise<Candidate[]> {
  const out: Candidate[] = [];

  const failed = rows.filter((r) => r.action === 'auth.login_failed');
  const byIp = new Map<string, Row[]>();
  for (const r of failed) {
    const ip = String(meta(r).ip ?? '');
    if (!ip) continue;
    byIp.set(ip, [...(byIp.get(ip) ?? []), r]);
  }
  for (const [ip, list] of byIp) {
    if (list.length >= FAILED_SIGNIN_THRESHOLD) out.push({ rule: 'FAILED_SIGNINS_IP', key: ip, summary: `${list.length} failed sign-ins from ${ip} in 15 minutes.`, auditLogIds: list.map((r) => r.id) });
  }

  const locked = new Map<string, Row[]>();
  for (const r of failed.filter((x) => meta(x).reason === 'locked')) {
    const email = String(meta(r).email ?? r.entityId);
    locked.set(email, [...(locked.get(email) ?? []), r]);
  }
  for (const [email, list] of locked) out.push({ rule: 'LOCKED_ACCOUNT', key: email, summary: `A locked account (${email}) is still being tried: ${list.length} attempt${list.length === 1 ? '' : 's'}.`, auditLogIds: list.map((r) => r.id) });

  const mfaOff = rows.filter((r) => r.action === 'auth.mfa_disabled');
  if (mfaOff.length) {
    const users = await db.user.findMany({ where: { id: { in: mfaOff.map((r) => r.entityId) } }, select: { id: true, email: true, role: true } });
    for (const r of mfaOff) {
      const u = users.find((x) => x.id === r.entityId);
      if (u && adminCapable(u.role)) out.push({ rule: 'MFA_OFF_ADMIN', key: u.id, summary: `Two-step sign-in was turned off on an admin account (${u.email}).`, auditLogIds: [r.id] });
    }
  }

  for (const r of rows) {
    const m = meta(r);
    if (r.action === 'admin.user_updated') {
      const changes = (m.changes as Record<string, { to?: unknown }> | undefined) ?? {};
      const toRole = changes.role?.to as string | undefined;
      const toExtra = (changes.additionalRoles?.to as string[] | undefined) ?? [];
      if (adminCapable(toRole) || toExtra.some(adminCapable) || m.regionApprover) {
        out.push({ rule: 'PRIVILEGE_CHANGE', key: `user:${r.entityId}`, summary: `An account was given ${m.regionApprover ? 'a region' : `an admin-capable role (${toRole ?? toExtra.join(', ')})`}.`, auditLogIds: [r.id] });
      }
    } else if (r.action === 'agent.scopes_added') {
      out.push({ rule: 'PRIVILEGE_CHANGE', key: `agent:${r.entityId}`, summary: 'An AI agent’s scopes were widened.', auditLogIds: [r.id] });
    } else if (r.action === 'agent.approval.approved') {
      out.push({ rule: 'PRIVILEGE_CHANGE', key: `approval:${r.entityId}`, summary: `A gated agent action was approved (${String(m.gated ?? 'action')}).`, auditLogIds: [r.id] });
    }
  }

  const exports = rows.filter((r) => r.action === 'http.export' || r.action === 'auth.data_exported');
  const byActor = new Map<string, Row[]>();
  for (const r of exports) {
    const who = r.actorUserId ?? 'unknown';
    byActor.set(who, [...(byActor.get(who) ?? []), r]);
    const route = String(meta(r).route ?? '');
    if (SENSITIVE_EXPORT.test(route)) out.push({ rule: 'EXPORTS', key: `sensitive:${r.id}`, summary: `A sensitive export: ${route}.`, auditLogIds: [r.id] });
  }
  for (const [who, list] of byActor) {
    if (list.length >= EXPORT_THRESHOLD) out.push({ rule: 'EXPORTS', key: `burst:${who}`, summary: `${list.length} exports by one account in 15 minutes.`, auditLogIds: list.map((r) => r.id) });
  }
  return out;
}

/** The tick: evaluate, de-duplicate per rule and key an hour, deliver, record. */
export async function runSecurityAlerts(db: Db, now: Date = new Date()): Promise<number> {
  const rows = await db.auditLog.findMany({
    where: { createdAt: { gte: new Date(now.getTime() - ALERT_WINDOW_MS), lte: now }, action: { in: ['auth.login_failed', 'auth.mfa_disabled', 'admin.user_updated', 'agent.scopes_added', 'agent.approval.approved', 'http.export', 'auth.data_exported'] } },
    select: { id: true, action: true, actorUserId: true, entityId: true, metadata: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
    take: 5000,
  });
  if (!rows.length) return 0;
  const candidates = await evaluateAlertRules(db, rows);
  if (!candidates.length) return 0;

  let raised = 0;
  for (const c of candidates) {
    if (await raiseSecurityAlert(db, c, now)) raised += 1;
  }
  return raised;
}

/**
 * One alert, delivered and recorded: the security contact by email, the
 * operator's org admins in their bell, a SecurityAlert row and an audit
 * row. De-duplicated per (rule, key) for an hour. Shared by the five
 * audit-trail rules above and the nightly audit-chain check
 * (lib/auditChain), so a broken chain reaches the same people the same way.
 * Returns false when the same alert was raised within the hour.
 */
export async function raiseSecurityAlert(db: Db, c: Candidate & { linkUrl?: string }, now: Date = new Date()): Promise<boolean> {
  const recent = await db.securityAlert.findFirst({ where: { rule: c.rule, key: c.key, createdAt: { gte: new Date(now.getTime() - DEDUPE_MS) } }, select: { id: true } });
  if (recent) return false;
  const setting = await db.orgSetting.findUnique({ where: { tenantId: tenantIdForWrite() }, select: { securityContactEmail: true } });
  const admins = await db.user.findMany({ where: { tenantId: ALTO_TENANT_ID, status: 'ACTIVE', deletedAt: null, role: { in: rolesWithCapability('manage:org') } }, select: { id: true }, take: 10 });
  const deliveredTo: string[] = [];
  if (setting?.securityContactEmail) {
    try {
      await send({ channel: 'EMAIL', recipient: { userId: null, phone: null, email: setting.securityContactEmail }, subject: `Security alert: ${c.rule.replace(/_/g, ' ').toLowerCase()}`, body: `${c.summary}${c.auditLogIds.length ? `\n\nAudit rows: ${c.auditLogIds.slice(0, 20).join(', ')}` : ''}`, category: 'security_alert' });
      deliveredTo.push('security-contact');
    } catch (err) {
      console.error('[alto-people/api] security alert email failed:', err);
    }
  }
  for (const a of admins) {
    void notifyUser(a.id, { subject: 'Security alert', body: c.summary, category: 'security_alert', linkUrl: c.linkUrl ?? '/admin/audit' });
    deliveredTo.push(`user:${a.id}`);
  }
  const alert = await db.securityAlert.create({ data: { rule: c.rule, key: c.key.slice(0, 200), summary: c.summary.slice(0, 500), auditLogIds: c.auditLogIds.slice(0, 200), deliveredTo } });
  enqueueAudit({ actorUserId: null, clientId: null, tenantId: ALTO_TENANT_ID, action: 'security.alert_raised', entityType: 'SecurityAlert', entityId: alert.id, metadata: { rule: c.rule, deliveredTo: deliveredTo.length } }, 'securityAlerts');
  return true;
}

let timer: NodeJS.Timeout | null = null;
export function startSecurityAlertsCron(db: Db): void {
  if (timer) return;
  const tick = () => void platformJob('securityAlerts', () => runSecurityAlerts(db))().catch((err) => console.error('[alto-people/api] security alerts failed:', err));
  timer = setInterval(tick, 5 * 60_000);
  timer.unref();
  console.log('[alto-people/api] security alerting armed (every 5 minutes over the audit trail)');
}
export const securityAlertsArmed = () => timer !== null;
