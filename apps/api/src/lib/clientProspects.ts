import type { Prisma } from '@prisma/client';
import {
  can,
  isOpenProspectStage,
  PROSPECT_STAGE_WEIGHTS,
  prospectAnnualValue,
  prospectWeightedValue,
  rolesWithCapability,
  toDateOnly,
  type ProspectInput,
  type ProspectListResponse,
  type ProspectOwner,
  type ProspectRow,
  type ProspectStageKey,
  type ProspectUpdate,
} from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { enqueueAudit } from './audit.js';
import { orgDateKey } from './timeAnomalies.js';
import type { SessionUser } from '../types/express.js';

/**
 * The new-business pipeline — one place for its reads, writes and maths.
 *
 *   Read:  view:executive (the dashboard's concentration hedge) or
 *          manage:clients (the people who work the pipeline).
 *   Write: manage:clients.
 *   Money: est. bill rate and every value derived from it go only to a
 *          caller who can read client money (statements: process:payroll or
 *          view:executive). Anyone else gets the fields left out, never 0.
 *
 * The routes (/client-prospects, and the older /executive/prospects the
 * executive dashboard reads) both call in here, so a stage moved from
 * either keeps "days in stage" true.
 */

const DAY_MS = 86_400_000;

export interface ProspectAccess {
  read: boolean;
  write: boolean;
  money: boolean;
}

export function prospectAccess(user: SessionUser): ProspectAccess {
  const write = can(user, 'manage:clients');
  return {
    read: write || can(user, 'view:executive'),
    write,
    money: can(user, 'process:payroll') || can(user, 'view:executive'),
  };
}

const ROW_INCLUDE = {
  owner: { select: { id: true, email: true, displayName: true, associate: { select: { firstName: true, lastName: true } } } },
  wonClient: { select: { id: true, name: true, deletedAt: true } },
} satisfies Prisma.ClientProspectInclude;

type ProspectWithRelations = Prisma.ClientProspectGetPayload<{ include: typeof ROW_INCLUDE }>;

export function userDisplayName(u: { email: string; displayName?: string | null; associate?: { firstName: string; lastName: string } | null }): string {
  if (u.displayName?.trim()) return u.displayName.trim();
  const fromAssociate = u.associate ? `${u.associate.firstName} ${u.associate.lastName}`.trim() : '';
  if (fromAssociate) return fromAssociate;
  return u.email.split('@')[0] || u.email;
}

/** YYYY-MM-DD `days` after a YYYY-MM-DD. */
function addDays(day: string, days: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function toProspectRow(p: ProspectWithRelations, now: Date, money: boolean): ProspectRow {
  const rate = p.estBillRate === null ? null : Number(p.estBillRate);
  const annual = prospectAnnualValue(p.estWeeklyHours, rate);
  const row: ProspectRow = {
    id: p.id,
    name: p.name,
    stage: p.stage as ProspectStageKey,
    ownerUserId: p.ownerUserId,
    ownerName: p.owner ? userDisplayName(p.owner) : null,
    contactName: p.contactName,
    contactEmail: p.contactEmail,
    estWeeklyHours: p.estWeeklyHours,
    expectedStartDate: toDateOnly(p.expectedStartDate),
    stageChangedAt: p.stageChangedAt.toISOString(),
    daysInStage: Math.max(0, Math.floor((now.getTime() - p.stageChangedAt.getTime()) / DAY_MS)),
    lostReason: p.lostReason,
    wonClientId: p.wonClient && !p.wonClient.deletedAt ? p.wonClient.id : null,
    wonClientName: p.wonClient && !p.wonClient.deletedAt ? p.wonClient.name : null,
    notes: p.notes,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
  if (money) {
    row.estBillRate = rate;
    row.annualValue = annual;
    row.weightedValue = prospectWeightedValue(p.stage, annual);
  }
  return row;
}

/** The whole pipeline for one tenant, with the header's totals. */
export async function listProspects(tenantId: string, access: ProspectAccess, now = new Date()): Promise<ProspectListResponse> {
  const rows = await prisma.clientProspect.findMany({
    where: { tenantId, deletedAt: null },
    include: ROW_INCLUDE,
    orderBy: [{ stageChangedAt: 'asc' }, { name: 'asc' }],
    take: 1000,
  });
  const prospects = rows.map((p) => toProspectRow(p, now, access.money));

  const today = orgDateKey(now);
  const horizon = addDays(today, 90);
  let open = 0;
  let unpriced = 0;
  let weighted = 0;
  let unweighted = 0;
  let startsNext90 = 0;
  let startsNext90Won = 0;
  rows.forEach((p, i) => {
    const row = prospects[i]!;
    if (isOpenProspectStage(p.stage)) {
      open += 1;
      const annual = prospectAnnualValue(p.estWeeklyHours, p.estBillRate === null ? null : Number(p.estBillRate));
      if (annual === null) unpriced += 1;
      else {
        unweighted += annual;
        weighted += prospectWeightedValue(p.stage, annual) ?? 0;
      }
    }
    const start = row.expectedStartDate;
    if (p.stage !== 'LOST' && start && start >= today && start <= horizon) {
      startsNext90 += 1;
      if (p.stage === 'WON') startsNext90Won += 1;
    }
  });

  return {
    today,
    prospects,
    totals: {
      open,
      unpriced,
      ...(access.money
        ? { weightedValue: Math.round(weighted * 100) / 100, unweightedValue: Math.round(unweighted * 100) / 100 }
        : {}),
      startsNext90,
      startsNext90Won,
    },
    weights: { ...PROSPECT_STAGE_WEIGHTS },
    money: access.money,
    canWrite: access.write,
  };
}

/** One prospect, shaped as the list shapes it. */
export async function getProspectRow(tenantId: string, id: string, access: ProspectAccess, now = new Date()): Promise<ProspectRow> {
  const p = await prisma.clientProspect.findFirst({ where: { id, tenantId, deletedAt: null }, include: ROW_INCLUDE });
  if (!p) throw new HttpError(404, 'not_found', 'Prospect not found.');
  return toProspectRow(p, now, access.money);
}

/** The people who can own a prospect: active accounts in the tenant that can work the pipeline. */
export async function prospectOwners(tenantId: string): Promise<ProspectOwner[]> {
  const users = await prisma.user.findMany({
    where: { tenantId, status: 'ACTIVE', deletedAt: null, role: { in: rolesWithCapability('manage:clients') } },
    select: { id: true, email: true, displayName: true, associate: { select: { firstName: true, lastName: true } } },
    take: 500,
  });
  return users.map((u) => ({ id: u.id, name: userDisplayName(u) })).sort((a, b) => a.name.localeCompare(b.name));
}

async function assertOwner(tenantId: string, ownerUserId: string | null | undefined): Promise<void> {
  if (!ownerUserId) return;
  const ok = await prisma.user.findFirst({
    where: { id: ownerUserId, tenantId, status: 'ACTIVE', deletedAt: null, role: { in: rolesWithCapability('manage:clients') } },
    select: { id: true },
  });
  if (!ok) throw new HttpError(400, 'invalid_owner', 'The owner must be an active account that can work the pipeline.');
}

async function assertWonClient(tenantId: string, clientId: string | null | undefined): Promise<void> {
  if (!clientId) return;
  const ok = await prisma.client.findFirst({ where: { id: clientId, tenantId, deletedAt: null }, select: { id: true } });
  if (!ok) throw new HttpError(400, 'invalid_client', 'That client was not found.');
}

const dateOrNull = (v: string | null | undefined): Date | null | undefined =>
  v === undefined ? undefined : v === null ? null : new Date(`${v}T00:00:00Z`);

/**
 * The stage rules, applied to a create and to an edit alike:
 *   LOST needs a reason; leaving LOST clears it.
 *   A client link only on WON; leaving WON clears it.
 *   Any change of stage restarts "days in stage".
 */
function stageFields(
  next: ProspectStageKey,
  prev: { stage: ProspectStageKey; lostReason: string | null; wonClientId: string | null } | null,
  input: { lostReason?: string | null; wonClientId?: string | null },
  now: Date,
): Pick<Prisma.ClientProspectUncheckedUpdateInput, 'stage' | 'lostReason' | 'wonClientId' | 'stageChangedAt'> {
  const out: Pick<Prisma.ClientProspectUncheckedUpdateInput, 'stage' | 'lostReason' | 'wonClientId' | 'stageChangedAt'> = {};
  const changed = !prev || prev.stage !== next;
  if (changed) {
    out.stage = next;
    out.stageChangedAt = now;
  }
  const reason = input.lostReason !== undefined ? (input.lostReason?.trim() || null) : (prev?.lostReason ?? null);
  if (next === 'LOST') {
    if (!reason) throw new HttpError(400, 'lost_reason_required', 'Say why it was lost.');
    out.lostReason = reason;
  } else if (prev?.lostReason || input.lostReason) {
    out.lostReason = null;
  }
  const won = input.wonClientId !== undefined ? input.wonClientId : (prev?.wonClientId ?? null);
  if (won && next !== 'WON') {
    if (input.wonClientId) throw new HttpError(400, 'won_client_needs_won', 'Only a won prospect links to a client.');
    out.wonClientId = null;
  } else if (input.wonClientId !== undefined) {
    out.wonClientId = input.wonClientId;
  }
  return out;
}

export async function createProspect(tenantId: string, input: ProspectInput, actorUserId: string, now = new Date()): Promise<{ id: string }> {
  await assertOwner(tenantId, input.ownerUserId);
  await assertWonClient(tenantId, input.wonClientId);
  const stage = (input.stage ?? 'LEAD') as ProspectStageKey;
  const stageData = stageFields(stage, null, input, now);
  const row = await prisma.clientProspect.create({
    data: {
      tenantId,
      name: input.name,
      stage,
      stageChangedAt: now,
      ownerUserId: input.ownerUserId ?? null,
      contactName: input.contactName?.trim() || null,
      contactEmail: input.contactEmail?.trim() || null,
      estWeeklyHours: input.estWeeklyHours ?? null,
      estBillRate: input.estBillRate ?? null,
      expectedStartDate: dateOrNull(input.expectedStartDate) ?? null,
      notes: input.notes?.trim() || null,
      lostReason: (stageData.lostReason as string | null | undefined) ?? null,
      wonClientId: (stageData.wonClientId as string | null | undefined) ?? null,
    },
  });
  enqueueAudit(
    {
      actorUserId,
      action: 'client_prospect.created',
      entityType: 'ClientProspect',
      entityId: row.id,
      metadata: { name: row.name, stage: row.stage },
    },
    'clientProspects.create',
  );
  return { id: row.id };
}

export async function updateProspect(tenantId: string, id: string, input: ProspectUpdate, actorUserId: string, now = new Date()): Promise<void> {
  const existing = await prisma.clientProspect.findFirst({ where: { id, tenantId, deletedAt: null } });
  if (!existing) throw new HttpError(404, 'not_found', 'Prospect not found.');
  if (input.ownerUserId !== undefined) await assertOwner(tenantId, input.ownerUserId);
  if (input.wonClientId !== undefined) await assertWonClient(tenantId, input.wonClientId);

  const next = (input.stage ?? existing.stage) as ProspectStageKey;
  const stageData = stageFields(
    next,
    { stage: existing.stage as ProspectStageKey, lostReason: existing.lostReason, wonClientId: existing.wonClientId },
    input,
    now,
  );
  const data: Prisma.ClientProspectUncheckedUpdateInput = { ...stageData };
  if (input.name !== undefined) data.name = input.name;
  if (input.ownerUserId !== undefined) data.ownerUserId = input.ownerUserId;
  if (input.contactName !== undefined) data.contactName = input.contactName?.trim() || null;
  if (input.contactEmail !== undefined) data.contactEmail = input.contactEmail?.trim() || null;
  if (input.estWeeklyHours !== undefined) data.estWeeklyHours = input.estWeeklyHours;
  if (input.estBillRate !== undefined) data.estBillRate = input.estBillRate;
  if (input.expectedStartDate !== undefined) data.expectedStartDate = dateOrNull(input.expectedStartDate);
  if (input.notes !== undefined) data.notes = input.notes?.trim() || null;

  await prisma.clientProspect.update({ where: { id: existing.id }, data });

  const stageChanged = next !== existing.stage;
  enqueueAudit(
    {
      actorUserId,
      action: stageChanged ? 'client_prospect.stage_changed' : 'client_prospect.updated',
      entityType: 'ClientProspect',
      entityId: existing.id,
      clientId: (data.wonClientId as string | null | undefined) ?? existing.wonClientId ?? null,
      metadata: stageChanged
        ? {
            from: existing.stage,
            to: next,
            ...(next === 'LOST' ? { lostReason: data.lostReason ?? existing.lostReason } : {}),
            ...(next === 'WON' && data.wonClientId ? { wonClientId: data.wonClientId } : {}),
          }
        : { fields: Object.keys(data).filter((k) => k !== 'stageChangedAt') },
    },
    'clientProspects.update',
  );
}

export async function deleteProspect(tenantId: string, id: string, actorUserId: string): Promise<void> {
  const existing = await prisma.clientProspect.findFirst({ where: { id, tenantId, deletedAt: null }, select: { id: true, name: true } });
  if (!existing) throw new HttpError(404, 'not_found', 'Prospect not found.');
  await prisma.clientProspect.updateMany({ where: { id, tenantId, deletedAt: null }, data: { deletedAt: new Date() } });
  enqueueAudit(
    {
      actorUserId,
      action: 'client_prospect.deleted',
      entityType: 'ClientProspect',
      entityId: id,
      metadata: { name: existing.name },
    },
    'clientProspects.delete',
  );
}

