import type { PrismaClient, Role } from '@prisma/client';
import { ROLE_LABELS } from '@alto-people/shared';
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
 *   - Associates are never reachable and never callers: the floor rule is
 *     no phones, and a store messaging an associate directly bypasses
 *     Alto's supervision. Supervisors are the store's line into the crew.
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
];
const STORE_ROLES: Role[] = ['SHIFT_SUPERVISOR', 'FLOOR_SUPERVISOR'];
const DESK_ROLES: Role[] = [
  'WORKFORCE_MANAGER',
  'OPERATIONS_MANAGER',
  'HR_ADMINISTRATOR',
  'FINANCE_ACCOUNTANT',
];
const INTERNAL_ROLES: Role[] = MESSAGING_ROLES.filter(
  (r) => r !== 'CLIENT_PORTAL' && !STORE_ROLES.includes(r),
);

export interface Messenger {
  id: string;
  role: Role;
  clientId: string | null;
  locationId?: string | null;
  regionId?: string | null;
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
  if (STORE_ROLES.includes(from.role)) {
    if (to.role === 'CLIENT_PORTAL' || STORE_ROLES.includes(to.role)) return sameClient;
    return INTERNAL_ROLES.includes(to.role);
  }
  // Internal roles: everyone but associates.
  return true;
}

/** Clients that have a store in the caller's region (region accounts). */
export async function regionClientIds(regionId: string, prisma: PrismaClient = defaultPrisma): Promise<string[]> {
  const rows = await prisma.location.findMany({
    where: { regionId, deletedAt: null },
    select: { clientId: true },
    distinct: ['clientId'],
    take: 500,
  });
  return rows.map((r) => r.clientId);
}

/** canMessage, plus the region check a store target needs. */
export async function canMessageAsync(from: Messenger, to: Messenger, prisma: PrismaClient = defaultPrisma): Promise<boolean> {
  if (!canMessage(from, to)) return false;
  if (from.role === 'CLIENT_PORTAL' && !from.clientId && from.regionId && STORE_ROLES.includes(to.role)) {
    return !!to.clientId && (await regionClientIds(from.regionId, prisma)).includes(to.clientId);
  }
  return true;
}

/** The "where" the caller may message into, as a Prisma filter over users. */
export function directoryWhere(from: Messenger, regionClients: string[] = []) {
  const base = { status: 'ACTIVE' as const, deletedAt: null, id: { not: from.id } };
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
    return {
      ...base,
      OR: [
        {
          role: { in: ['CLIENT_PORTAL', ...STORE_ROLES] as Role[] },
          clientId: from.clientId ?? '00000000-0000-0000-0000-000000000000',
        },
        { role: { in: INTERNAL_ROLES } },
      ],
    };
  }
  return { ...base, role: { in: MESSAGING_ROLES } };
}

export function displayName(u: {
  email: string;
  associate?: { firstName: string; lastName: string } | null;
}): string {
  return u.associate ? `${u.associate.firstName} ${u.associate.lastName}`.trim() : u.email.split('@')[0] ?? u.email;
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
export async function ensureStoreChannels(
  user: Messenger,
  prisma: PrismaClient = defaultPrisma,
): Promise<string[]> {
  if (!user.clientId) return [];
  if (user.role !== 'CLIENT_PORTAL' && !STORE_ROLES.includes(user.role)) return [];
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
  // client when it has a single site (or none on file).
  const stores =
    client.locations.length > 1
      ? client.locations
      : [{ id: null as string | null, name: client.name }];
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
