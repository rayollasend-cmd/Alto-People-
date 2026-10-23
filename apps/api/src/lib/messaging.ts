import type { PrismaClient, Role } from '@prisma/client';
import { regionSiteIds } from './orgUnits.js';
import { ROLE_LABELS } from '@alto-people/shared';
import { personDisplayName } from './displayName.js';
import { prisma as defaultPrisma } from '../db.js';
import { notifyUser } from './notify.js';
import { emitLiveEvent } from './liveEvents.js';

/**
 * The messenger's rules — who may message whom, the store channel every
 * store gets, and how a new message reaches people.
 *
 * WHO MAY MESSAGE WHOM (a rule, not a directory):
 *   - A store manager (CLIENT_PORTAL) reaches their store's supervisors
 *     and floor leads, and the Alto desks (Workforce, Operations, HR,
 *     Finance). Never another client, never an associate.
 *   - A supervisor / floor lead reaches their client's portal accounts,
 *     the other supervisors at their client, and every internal desk.
 *   - Internal roles reach every internal person, every portal account,
 *     and every supervisor.
 *   - An associate (field roles, 2026-10) reaches the Alto desks and the
 *     supervisors of a store they are placed at, and those reach them —
 *     the record's Message button lands in their app, not an SMS. A store
 *     manager still never reaches an associate directly (that bypasses
 *     Alto's supervision), and associates never reach each other here:
 *     the crew's channel is the supervisor.
 */

export const MESSAGING_ROLES: Role[] = [
  'EXECUTIVE_CHAIRMAN',
  'HR_ADMINISTRATOR',
  'OPERATIONS_MANAGER',
  'CLIENT_PORTAL',
  'FINANCE_ACCOUNTANT',
  'INTERNAL_RECRUITER',
  'MANAGER',
  'WORKFORCE_MANAGER',
  'MARKETING_MANAGER',
  'SHIFT_SUPERVISOR',
  'FLOOR_SUPERVISOR',
  // Transportation: the director and the drivers reach the desks and the
  // store supervisors ("Van 2 is running 15 late").
  'TRANSPORTATION_DIRECTOR',
  'DRIVER',
  // The person themself: their supervisors and the desks, nobody else.
  'ASSOCIATE',
];
const STORE_ROLES: Role[] = ['SHIFT_SUPERVISOR', 'FLOOR_SUPERVISOR'];
const DESK_ROLES: Role[] = [
  'WORKFORCE_MANAGER',
  'OPERATIONS_MANAGER',
  'HR_ADMINISTRATOR',
  'FINANCE_ACCOUNTANT',
];
const INTERNAL_ROLES: Role[] = MESSAGING_ROLES.filter(
  (r) => r !== 'CLIENT_PORTAL' && r !== 'ASSOCIATE' && !STORE_ROLES.includes(r),
);

export interface Messenger {
  id: string;
  role: Role;
  clientId: string | null;
  locationId?: string | null;
  regionId?: string | null;
  /** The person's own record, for an associate's login. */
  associateId?: string | null;
}

/** Clients an associate is placed at — an approved application or an open store assignment. */
export async function placedClientsOf(associateId: string, prisma: PrismaClient = defaultPrisma): Promise<string[]> {
  const [apps, assignments] = await Promise.all([
    prisma.application.findMany({ where: { associateId, status: 'APPROVED', deletedAt: null }, select: { clientId: true } }),
    prisma.associateAssignment.findMany({ where: { associateId, endedAt: null }, select: { location: { select: { clientId: true } } } }),
  ]);
  return [...new Set([...apps.map((a) => a.clientId), ...assignments.map((a) => a.location.clientId)].filter((id): id is string => id !== null))];
}

export function canUseMessenger(role: Role): boolean {
  return MESSAGING_ROLES.includes(role);
}

/** May `from` open a thread with `to`? Symmetric by construction. */
export function canMessage(from: Messenger, to: Messenger): boolean {
  if (from.id === to.id) return false;
  if (!canUseMessenger(from.role) || !canUseMessenger(to.role)) return false;
  const sameClient = !!from.clientId && from.clientId === to.clientId;
  if (from.role === 'CLIENT_PORTAL') {
    // A region account: its store checks are async (the region's clients)
    // — canMessageAsync covers it; here only the desks are certain.
    if (!from.clientId && from.regionId) return DESK_ROLES.includes(to.role) || STORE_ROLES.includes(to.role);
    if (STORE_ROLES.includes(to.role)) return sameClient;
    if (DESK_ROLES.includes(to.role)) return true;
    return false;
  }
  // An associate: the desks, and (checked against their placements in
  // canMessageAsync) the supervisors of a store they work at.
  if (from.role === 'ASSOCIATE') return INTERNAL_ROLES.includes(to.role) || STORE_ROLES.includes(to.role);
  if (STORE_ROLES.includes(from.role)) {
    if (to.role === 'CLIENT_PORTAL' || STORE_ROLES.includes(to.role)) return sameClient;
    // Their crew: an associate placed at their client (canMessageAsync).
    if (to.role === 'ASSOCIATE') return !!from.clientId;
    return INTERNAL_ROLES.includes(to.role);
  }
  // Internal roles: everyone.
  return true;
}

/** Clients that have a store in the caller's region (region accounts). */
export async function regionClientIds(regionId: string, prisma: PrismaClient = defaultPrisma): Promise<string[]> {
  // Brief 2-1b step 5: a region's stores are the sites under its unit.
  const rows = await prisma.site.findMany({
    where: { id: { in: await regionSiteIds(prisma, regionId) }, deletedAt: null },
    select: { clientId: true },
    distinct: ['clientId'],
    take: 500,
  });
  // Region channels are a client thing; a client-less store (a direct employer) contributes none.
  return rows.map((r) => r.clientId).filter((id): id is string => id !== null);
}

/** canMessage, plus the region check a store target needs. */
export async function canMessageAsync(from: Messenger, to: Messenger, prisma: PrismaClient = defaultPrisma): Promise<boolean> {
  if (!canMessage(from, to)) return false;
  if (from.role === 'CLIENT_PORTAL' && !from.clientId && from.regionId && STORE_ROLES.includes(to.role)) {
    return !!to.clientId && (await regionClientIds(from.regionId, prisma)).includes(to.clientId);
  }
  // A supervisor and an associate: the associate must be placed at the supervisor's client.
  const pair =
    from.role === 'ASSOCIATE' && STORE_ROLES.includes(to.role)
      ? { associateId: from.associateId, clientId: to.clientId }
      : to.role === 'ASSOCIATE' && STORE_ROLES.includes(from.role)
        ? { associateId: to.associateId, clientId: from.clientId }
        : null;
  if (pair) {
    if (!pair.associateId || !pair.clientId) return false;
    return (await placedClientsOf(pair.associateId, prisma)).includes(pair.clientId);
  }
  return true;
}

/** The "where" the caller may message into, as a Prisma filter over users. */
export function directoryWhere(from: Messenger, regionClients: string[] = [], placedClients: string[] = []) {
  const base = { status: 'ACTIVE' as const, deletedAt: null, id: { not: from.id } };
  const noClient = '00000000-0000-0000-0000-000000000000';
  if (from.role === 'ASSOCIATE') {
    return {
      ...base,
      OR: [
        { role: { in: INTERNAL_ROLES } },
        { role: { in: STORE_ROLES }, clientId: { in: placedClients.length ? placedClients : [noClient] } },
      ],
    };
  }
  if (from.role === 'CLIENT_PORTAL' && !from.clientId && from.regionId) {
    return {
      ...base,
      OR: [
        { role: { in: STORE_ROLES }, clientId: { in: regionClients.length ? regionClients : ['00000000-0000-0000-0000-000000000000'] } },
        { role: { in: DESK_ROLES } },
      ],
    };
  }
  if (from.role === 'CLIENT_PORTAL') {
    return {
      ...base,
      OR: [
        { role: { in: STORE_ROLES }, clientId: from.clientId ?? '00000000-0000-0000-0000-000000000000' },
        { role: { in: DESK_ROLES } },
      ],
    };
  }
  if (STORE_ROLES.includes(from.role)) {
    const clientId = from.clientId ?? noClient;
    return {
      ...base,
      OR: [
        {
          role: { in: ['CLIENT_PORTAL', ...STORE_ROLES] as Role[] },
          clientId,
        },
        { role: { in: INTERNAL_ROLES } },
        // Their crew: associates placed at their client.
        {
          role: 'ASSOCIATE' as Role,
          associate: {
            OR: [
              { assignments: { some: { endedAt: null, location: { clientId } } } },
              { applications: { some: { clientId, status: 'APPROVED' as const, deletedAt: null } } },
            ],
          },
        },
      ],
    };
  }
  return { ...base, role: { in: MESSAGING_ROLES } };
}

/** A person's name in the messenger — the shared rule (lib/displayName): never the email's local part. */
export function displayName(u: {
  email: string;
  role?: Role | string | null;
  displayName?: string | null;
  associate?: { firstName: string; lastName: string } | null;
}): string {
  return personDisplayName(u);
}

export function roleLabel(role: Role): string {
  return ROLE_LABELS[role] ?? role;
}

/**
 * Every store gets a channel: the client's portal accounts (store-scoped
 * ones for their own store) plus the supervisors and floor leads bound to
 * the client. Membership is re-synced whenever someone who belongs opens
 * their inbox, so a new supervisor appears without anyone adding them.
 * Returns the conversation ids the caller belongs to.
 */
/** Who belongs in a store channel right now: the client's supervisors and
 *  leads, plus its portal accounts (store accounts for their own store,
 *  market accounts for every store). */
async function storeChannelMembers(clientId: string, locationId: string | null, prisma: PrismaClient): Promise<string[]> {
  const members = await prisma.user.findMany({
    where: { clientId, status: 'ACTIVE', deletedAt: null, role: { in: ['CLIENT_PORTAL', ...STORE_ROLES] as Role[] } },
    select: { id: true, role: true, locationId: true },
  });
  return members
    .filter((m) => m.role !== 'CLIENT_PORTAL' || !locationId || !m.locationId || m.locationId === locationId)
    .map((m) => m.id);
}

/**
 * Bring one store channel in line with the store's people before a
 * message goes out: add whoever belongs (a manager invited this morning
 * hears the next message, not the one after they first open Messages),
 * remove whoever moved store or left. Returns the members, or null when
 * the conversation is not a store channel.
 */
export async function syncStoreChannel(conversationId: string, prisma: PrismaClient = defaultPrisma): Promise<string[] | null> {
  const convo = await prisma.conversation.findFirst({
    where: { id: conversationId, kind: 'STORE_CHANNEL' },
    select: { id: true, clientId: true, locationId: true, participants: { select: { userId: true } } },
  });
  if (!convo || !convo.clientId) return null;
  const want = new Set(await storeChannelMembers(convo.clientId, convo.locationId, prisma));
  const have = new Set(convo.participants.map((p) => p.userId));
  const add = [...want].filter((id) => !have.has(id));
  const remove = [...have].filter((id) => !want.has(id));
  if (add.length > 0) {
    await prisma.conversationParticipant.createMany({
      data: add.map((userId) => ({ conversationId: convo.id, userId })),
      skipDuplicates: true,
    });
  }
  if (remove.length > 0) {
    await prisma.conversationParticipant.deleteMany({ where: { conversationId: convo.id, userId: { in: remove } } });
  }
  return [...want];
}

export async function ensureStoreChannels(
  user: Messenger,
  prisma: PrismaClient = defaultPrisma,
): Promise<string[]> {
  // Anyone who no longer belongs to a store (moved to a region, left the
  // client, changed role) drops out of every store channel.
  const leaveAll = async () => {
    await prisma.conversationParticipant.deleteMany({
      where: { userId: user.id, conversation: { kind: 'STORE_CHANNEL' } },
    });
    return [] as string[];
  };
  if (!user.clientId) return leaveAll();
  if (user.role !== 'CLIENT_PORTAL' && !STORE_ROLES.includes(user.role)) return leaveAll();
  const client = await prisma.client.findFirst({
    where: { id: user.clientId, deletedAt: null },
    select: {
      id: true,
      name: true,
      locations: {
        where: { deletedAt: null, isActive: true },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      },
    },
  });
  if (!client) return [];
  // One channel per store when the client has several; one for the
  // client when it has a single site (or none on file) — named by that
  // store, not the client (F500 G5).
  const stores =
    client.locations.length > 1
      ? client.locations
      : [{ id: null as string | null, name: client.locations[0]?.name ?? client.name }];
  const members = await prisma.user.findMany({
    where: {
      clientId: client.id,
      status: 'ACTIVE',
      deletedAt: null,
      role: { in: ['CLIENT_PORTAL', ...STORE_ROLES] as Role[] },
    },
    select: { id: true, role: true, locationId: true },
  });
  const ids: string[] = [];
  for (const store of stores) {
    const belongs = members.filter(
      (m) =>
        m.role !== 'CLIENT_PORTAL' || !store.id || !m.locationId || m.locationId === store.id,
    );
    if (!belongs.some((m) => m.id === user.id)) continue;
    let convo = await prisma.conversation.findFirst({
      where: { kind: 'STORE_CHANNEL', clientId: client.id, locationId: store.id },
      select: { id: true, participants: { select: { userId: true } } },
    });
    if (!convo) {
      convo = await prisma.conversation.create({
        data: {
          kind: 'STORE_CHANNEL',
          clientId: client.id,
          locationId: store.id,
          title: store.name,
          participants: { create: belongs.map((m) => ({ userId: m.id })) },
        },
        select: { id: true, participants: { select: { userId: true } } },
      });
    } else {
      const have = new Set(convo.participants.map((p) => p.userId));
      const missing = belongs.filter((m) => !have.has(m.id));
      if (missing.length > 0) {
        await prisma.conversationParticipant.createMany({
          data: missing.map((m) => ({ conversationId: convo!.id, userId: m.id })),
          skipDuplicates: true,
        });
      }
    }
    ids.push(convo.id);
  }
  // A manager moved to another store (or client) leaves the old channels.
  await prisma.conversationParticipant.deleteMany({
    where: { userId: user.id, conversation: { kind: 'STORE_CHANNEL' }, conversationId: { notIn: ids } },
  });
  return ids;
}

/**
 * A new message reaches the other participants: the bell row + push for
 * everyone, email only if the recipient hasn't been told about this
 * thread in the last 10 minutes (a conversation is not twenty emails).
 * Open tabs refresh through the live channel.
 */
export async function fanOutMessage(
  opts: {
    conversationId: string;
    title: string;
    senderName: string;
    preview: string;
    recipientIds: string[];
  },
  prisma: PrismaClient = defaultPrisma,
): Promise<void> {
  const linkUrl = `/messages/${opts.conversationId}`;
  const since = new Date(Date.now() - 10 * 60_000);
  await Promise.all(
    opts.recipientIds.map(async (id) => {
      const recent = await prisma.notification.findFirst({
        where: { recipientUserId: id, category: 'message', linkUrl, createdAt: { gte: since } },
        select: { id: true },
      });
      await notifyUser(
        id,
        {
          subject: `${opts.senderName} · ${opts.title}`,
          body: opts.preview,
          category: 'message',
          linkUrl,
          quiet: !!recent,
        },
        prisma,
      );
      emitLiveEvent(id, 'message');
    }),
  );
}
