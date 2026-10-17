import type { Prisma, Role } from '@prisma/client';
import { prisma } from '../db.js';
import type { SessionUser } from '../types/express.js';
import { atClient, internalSites, scopeAssociates } from './scope.js';
import { accountPhotoUrlFor, profilePhotoUrlFor } from './profilePhotoUrl.js';
import { localDateKey } from './timezone.js';
import { tenantIdForWrite } from './tenant.js';

/**
 * The org chart, two ways — both returned as a flat list of nodes with a
 * parent, so the page draws one tree and searches one list.
 *
 *   company  the people who run the company: every staff account (with or
 *            without a person record behind it) and everyone in an
 *            explicit reporting line (a manager, or reports of their own),
 *            under their manager. Open seats sit under the manager they
 *            report to as dotted cards. Associates who are only on the
 *            field roster are counted, not drawn — they live in Field.
 *
 *   field    the tree a staffing company runs on: region → client →
 *            store → the shift and floor leads placed there → the crew
 *            on an open assignment there, with today's coverage on each
 *            store. Open seats sit under their client.
 *
 * Both honour the caller's reach (scopeAssociates, the site/region
 * binding) and an optional client. People without a place go to one
 * labelled "not yet placed" group instead of crowding the top.
 */

export type OrgChartView = 'company' | 'field';

export type OrgNodeKind = 'person' | 'staff' | 'lead' | 'vacancy' | 'region' | 'client' | 'store' | 'group';

export interface OrgNode {
  id: string;
  parentId: string | null;
  kind: OrgNodeKind;
  name: string;
  /** Job title (people), position code (seats), or what a group holds. */
  subtitle: string | null;
  /** Staff and leads: the account's role, worded by the page in the tenant's terms. */
  role: Role | null;
  /** Leads: the shifts they lead at their store; null when they lead client-wide. */
  shiftLabels: string[] | null;
  photoUrl: string | null;
  /** The person's record, when there is one to open. */
  associateId: string | null;
  userId: string | null;
  departmentId: string | null;
  departmentName: string | null;
  clientId: string | null;
  clientName: string | null;
  siteName: string | null;
  /** Direct reports (company) or crew (store). */
  reports: number;
  /** Store only: today's shifts and how many have someone on them. */
  shiftsToday: number | null;
  filledToday: number | null;
  /** Vacancy only: PLANNED waits on its requisition; OPEN is hiring; FROZEN on hold. */
  positionStatus: 'PLANNED' | 'OPEN' | 'FROZEN' | null;
  /** Former people are returned only when asked for. */
  former: boolean;
}

export interface OrgChart {
  view: OrgChartView;
  nodes: OrgNode[];
  /** Company view: field-only associates left to the Field view. */
  fieldOnly: number;
  /** People the caller can see but who have no place in this view. */
  unplaced: number;
  /** True when the people list hit the cap and the chart is partial. */
  truncated: boolean;
  limit: number;
}

const LIMIT = 5000;
const UNPLACED = 'group:unplaced';
const OPEN_SEATS = 'group:open-seats';
const UNPLACED_DRAWN = 500;

/** Roles that are the field, not the office: drawn in Field (leads) or not at all. */
const NOT_STAFF: Role[] = ['ASSOCIATE', 'CLIENT_PORTAL', 'SHIFT_SUPERVISOR', 'FLOOR_SUPERVISOR'];

const name = (p: { firstName: string; lastName: string }) => `${p.firstName} ${p.lastName}`.trim();

function blank(partial: Partial<OrgNode> & Pick<OrgNode, 'id' | 'kind' | 'name'>): OrgNode {
  return {
    parentId: null,
    subtitle: null,
    role: null,
    shiftLabels: null,
    photoUrl: null,
    associateId: null,
    userId: null,
    departmentId: null,
    departmentName: null,
    clientId: null,
    clientName: null,
    siteName: null,
    reports: 0,
    shiftsToday: null,
    filledToday: null,
    positionStatus: null,
    former: false,
    ...partial,
  };
}

export async function buildOrgChart(
  user: SessionUser,
  opts: { view: OrgChartView; clientId?: string | null; includeFormer?: boolean },
  now = new Date(),
): Promise<OrgChart> {
  return opts.view === 'field' ? fieldChart(user, opts, now) : companyChart(user, opts);
}

/* ----- Company ------------------------------------------------------------ */

async function companyChart(
  user: SessionUser,
  opts: { clientId?: string | null; includeFormer?: boolean },
): Promise<OrgChart> {
  const tenantId = tenantIdForWrite();
  const where: Prisma.AssociateWhereInput = {
    AND: [
      { tenantId, deletedAt: null },
      scopeAssociates(user),
      opts.includeFormer ? {} : { deactivatedAt: null },
      opts.clientId ? atClient(opts.clientId) : {},
    ],
  };
  const [associates, staff] = await Promise.all([
    prisma.associate.findMany({
      where,
      take: LIMIT + 1,
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      select: {
        id: true,
        firstName: true,
        lastName: true,
        photoS3Key: true,
        photoUpdatedAt: true,
        managerId: true,
        deactivatedAt: true,
        departmentId: true,
        department: { select: { name: true } },
        jobProfile: { select: { title: true } },
        _count: { select: { directReports: true } },
      },
    }),
    // Staff accounts: the office. Their names come from the person behind
    // the login when there is one, else the account's own display name.
    prisma.user.findMany({
      where: {
        tenantId,
        deletedAt: null,
        status: opts.includeFormer ? undefined : { not: 'DISABLED' },
        role: { notIn: NOT_STAFF },
      },
      take: 1000,
      select: {
        id: true,
        email: true,
        displayName: true,
        role: true,
        associateId: true,
        status: true,
        reportsToUserId: true,
        photoS3Key: true,
        photoUpdatedAt: true,
        associate: { select: { id: true, firstName: true, lastName: true, photoS3Key: true, photoUpdatedAt: true } },
      },
    }),
  ]);
  const truncated = associates.length > LIMIT;
  const rows = associates.slice(0, LIMIT);
  const staffByAssociate = new Map(staff.filter((s) => s.associateId).map((s) => [s.associateId!, s]));
  const visible = new Set(rows.map((r) => r.id));
  // A staff account's node: its person record when it has one, else the account.
  const staffNode = new Map(staff.map((s) => [s.id, s.associateId ? `a:${s.associateId}` : `u:${s.id}`]));
  const reportsToNode = (userId: string | null | undefined) => (userId ? (staffNode.get(userId) ?? null) : null);

  // Who is in a reporting line: has a manager in view, or someone in view reports to them.
  const managers = new Set(rows.map((r) => r.managerId).filter((m): m is string => !!m && visible.has(m)));
  for (const s of staff) {
    const target = reportsToNode(s.reportsToUserId);
    if (target?.startsWith('a:')) managers.add(target.slice(2));
  }
  const inLine = (r: (typeof rows)[number]) => (r.managerId && visible.has(r.managerId)) || managers.has(r.id) || staffByAssociate.has(r.id);

  const nodes: OrgNode[] = [];
  let fieldOnly = 0;
  for (const r of rows) {
    if (!inLine(r)) {
      fieldOnly += 1;
      continue;
    }
    const account = staffByAssociate.get(r.id);
    nodes.push(
      blank({
        id: `a:${r.id}`,
        // The person record's manager first; a staff account's "reports to" second.
        parentId: r.managerId && visible.has(r.managerId) ? `a:${r.managerId}` : reportsToNode(account?.reportsToUserId),
        kind: account ? 'staff' : 'person',
        name: name(r),
        subtitle: r.jobProfile?.title ?? null,
        role: account?.role ?? null,
        photoUrl: profilePhotoUrlFor(r),
        associateId: r.id,
        userId: account?.id ?? null,
        departmentId: r.departmentId,
        departmentName: r.department?.name ?? null,
        reports: r._count.directReports,
        former: !!r.deactivatedAt,
      }),
    );
  }
  // Staff with no person record: no manager can be recorded for them, so
  // they stand at the top, named by their role.
  for (const s of staff) {
    if (s.associateId) continue;
    nodes.push(
      blank({
        id: `u:${s.id}`,
        parentId: reportsToNode(s.reportsToUserId),
        kind: 'staff',
        name: s.displayName?.trim() || s.email,
        role: s.role,
        photoUrl: accountPhotoUrlFor(s),
        userId: s.id,
        former: s.status === 'DISABLED',
      }),
    );
  }

  // A parent that isn't drawn (out of reach, former) leaves its child at the top.
  const drawn = new Set(nodes.map((n) => n.id));
  for (const n of nodes) if (n.parentId && !drawn.has(n.parentId)) n.parentId = null;
  const childCount = new Map<string, number>();
  for (const n of nodes) if (n.parentId) childCount.set(n.parentId, (childCount.get(n.parentId) ?? 0) + 1);
  for (const n of nodes) n.reports = childCount.get(n.id) ?? 0;

  // Open seats under the manager they report to; the rest in one group.
  const positions = await prisma.position.findMany({
    where: {
      tenantId,
      deletedAt: null,
      status: { in: ['PLANNED', 'OPEN', 'FROZEN'] },
      ...(opts.clientId ? { clientId: opts.clientId } : {}),
    },
    take: 500,
    select: { id: true, title: true, code: true, status: true, managerAssociateId: true, departmentId: true, department: { select: { name: true } } },
  });
  const ids = new Set(nodes.map((n) => n.id));
  let homeless = 0;
  for (const p of positions) {
    const parent = p.managerAssociateId && ids.has(`a:${p.managerAssociateId}`) ? `a:${p.managerAssociateId}` : OPEN_SEATS;
    if (parent === OPEN_SEATS) homeless += 1;
    nodes.push(
      blank({
        id: `p:${p.id}`,
        parentId: parent,
        kind: 'vacancy',
        name: p.title,
        subtitle: p.code,
        departmentId: p.departmentId,
        departmentName: p.department?.name ?? null,
        positionStatus: p.status as 'PLANNED' | 'OPEN' | 'FROZEN',
      }),
    );
  }
  if (homeless > 0) {
    nodes.push(blank({ id: OPEN_SEATS, kind: 'group', name: 'Open seats', subtitle: 'No manager named yet', reports: homeless }));
  }
  return { view: 'company', nodes, fieldOnly, unplaced: 0, truncated, limit: LIMIT };
}

/* ----- Field --------------------------------------------------------------- */

async function fieldChart(
  user: SessionUser,
  opts: { clientId?: string | null; includeFormer?: boolean },
  now: Date,
): Promise<OrgChart> {
  const tenantId = tenantIdForWrite();
  const reach = internalSites(user);
  const sites = await prisma.site.findMany({
    where: {
      AND: [
        // A direct employer's sites (a hotel's properties) have no client: they still count.
        { tenantId, deletedAt: null, isActive: true },
        reach ?? {},
        opts.clientId ? { clientId: opts.clientId } : {},
        // A bounded account (store manager, lead) sees its own client.
        user.clientId && (user.role === 'SHIFT_SUPERVISOR' || user.role === 'FLOOR_SUPERVISOR' || user.role === 'CLIENT_PORTAL')
          ? { clientId: user.clientId }
          : {},
      ],
    },
    take: 1000,
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      timezone: true,
      clientId: true,
      client: { select: { id: true, name: true, status: true, deletedAt: true } },
      regionId: true,
      region: { select: { id: true, name: true } },
    },
  });
  const live = sites.filter((s) => !s.clientId || (s.client && !s.client.deletedAt));
  const siteIds = live.map((s) => s.id);

  const unplacedWhere: Prisma.AssociateWhereInput = {
    AND: [
      { tenantId, deletedAt: null, deactivatedAt: null },
      scopeAssociates(user),
      opts.clientId ? atClient(opts.clientId) : {},
      { assignments: { none: { endedAt: null } } },
    ],
  };
  const [leads, crew, shifts, positions, unplaced] = await Promise.all([
    prisma.user.findMany({
      where: {
        tenantId,
        deletedAt: null,
        status: { not: 'DISABLED' },
        role: { in: ['SHIFT_SUPERVISOR', 'FLOOR_SUPERVISOR'] },
        OR: [{ locationId: { in: siteIds } }, { locationId: null, clientId: { in: [...new Set(live.map((s) => s.clientId).filter((c): c is string => !!c))] } }],
      },
      select: {
        id: true,
        email: true,
        displayName: true,
        role: true,
        locationId: true,
        clientId: true,
        photoS3Key: true,
        photoUpdatedAt: true,
        associate: { select: { id: true, firstName: true, lastName: true, photoS3Key: true, photoUpdatedAt: true } },
        supervisorShiftWindows: { select: { label: true, locationId: true } },
      },
    }),
    prisma.associateAssignment.findMany({
      where: {
        endedAt: null,
        locationId: { in: siteIds },
        associate: { AND: [{ tenantId, deletedAt: null }, scopeAssociates(user), opts.includeFormer ? {} : { deactivatedAt: null }] },
      },
      take: LIMIT + 1,
      orderBy: { associate: { lastName: 'asc' } },
      select: {
        locationId: true,
        associate: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            photoS3Key: true,
            photoUpdatedAt: true,
            deactivatedAt: true,
            jobProfile: { select: { title: true } },
          },
        },
      },
    }),
    prisma.shift.findMany({
      where: {
        locationId: { in: siteIds },
        status: { not: 'CANCELLED' },
        startsAt: { gte: new Date(now.getTime() - 36 * 3_600_000), lte: new Date(now.getTime() + 36 * 3_600_000) },
      },
      select: { locationId: true, startsAt: true, assignedAssociateId: true },
    }),
    prisma.position.findMany({
      where: {
        tenantId,
        deletedAt: null,
        status: { in: ['PLANNED', 'OPEN', 'FROZEN'] },
        clientId: opts.clientId ? opts.clientId : { in: [...new Set(live.map((s) => s.clientId).filter((c): c is string => !!c))] },
      },
      take: 500,
      select: { id: true, title: true, code: true, status: true, clientId: true },
    }),
    // Everyone the caller can see with no open placement anywhere — drawn
    // (up to a cap) so search finds them, counted in full.
    prisma.associate.findMany({
      where: unplacedWhere,
      take: UNPLACED_DRAWN,
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      select: { id: true, firstName: true, lastName: true, photoS3Key: true, photoUpdatedAt: true, jobProfile: { select: { title: true } } },
    }),
  ]);
  const unplacedCount = unplaced.length < UNPLACED_DRAWN ? unplaced.length : await prisma.associate.count({ where: unplacedWhere });
  const truncated = crew.length > LIMIT;

  const nodes: OrgNode[] = [];
  const regions = new Map<string, string>();
  const clients = new Set<string>();
  for (const s of live) {
    const regionNode = s.region ? `r:${s.region.id}` : null;
    if (s.region && !regions.has(s.region.id)) {
      regions.set(s.region.id, s.region.name);
      nodes.push(blank({ id: regionNode!, kind: 'region', name: s.region.name, subtitle: 'Region' }));
    }
    // A client spanning regions appears once per region, so each region's tree is whole.
    // A site with no client (a direct employer's) hangs straight off its region.
    const clientNode = s.clientId ? `c:${s.clientId}${regionNode ? `@${s.region!.id}` : ''}` : regionNode;
    if (s.clientId && clientNode && !clients.has(clientNode)) {
      clients.add(clientNode);
      nodes.push(
        blank({
          id: clientNode,
          parentId: regionNode,
          kind: 'client',
          name: s.client!.name,
          clientId: s.clientId,
          clientName: s.client!.name,
        }),
      );
    }
    const tz = s.timezone || 'America/New_York';
    const today = localDateKey(now, tz);
    const mine = shifts.filter((x) => x.locationId === s.id && localDateKey(x.startsAt, tz) === today);
    nodes.push(
      blank({
        id: `s:${s.id}`,
        parentId: clientNode,
        kind: 'store',
        name: s.name,
        clientId: s.clientId,
        clientName: s.client?.name ?? null,
        siteName: s.name,
        shiftsToday: mine.length,
        filledToday: mine.filter((x) => x.assignedAssociateId).length,
      }),
    );
  }
  const storeOf = new Map(live.map((s) => [s.id, s]));

  const firstClientNode = new Map<string, string>();
  for (const n of nodes) if (n.kind === 'client' && !firstClientNode.has(n.clientId!)) firstClientNode.set(n.clientId!, n.id);
  for (const l of leads) {
    const site = l.locationId ? storeOf.get(l.locationId) : undefined;
    if (!site) {
      // Placed at a client but no store yet: they lead client-wide.
      const parent = l.clientId ? firstClientNode.get(l.clientId) : undefined;
      if (!parent) continue;
      nodes.push(
        blank({
          id: `l:${l.id}`,
          parentId: parent,
          kind: 'lead',
          name: l.associate ? name(l.associate) : l.displayName?.trim() || l.email,
          role: l.role,
          photoUrl: accountPhotoUrlFor(l),
          associateId: l.associate?.id ?? null,
          userId: l.id,
          clientId: l.clientId,
        }),
      );
      continue;
    }
    const shiftLabels = l.supervisorShiftWindows.filter((w) => w.locationId === site.id).map((w) => w.label);
    nodes.push(
      blank({
        id: `l:${l.id}`,
        parentId: `s:${site.id}`,
        kind: 'lead',
        name: l.associate ? name(l.associate) : l.displayName?.trim() || l.email,
        role: l.role,
        shiftLabels,
        photoUrl: accountPhotoUrlFor(l),
        associateId: l.associate?.id ?? null,
        userId: l.id,
        clientId: site.clientId,
        clientName: site.client?.name ?? null,
        siteName: site.name,
      }),
    );
  }
  const crewCount = new Map<string, number>();
  for (const c of crew.slice(0, LIMIT)) {
    const site = storeOf.get(c.locationId);
    if (!site) continue;
    crewCount.set(site.id, (crewCount.get(site.id) ?? 0) + 1);
    nodes.push(
      blank({
        id: `a:${c.associate.id}@${site.id}`,
        parentId: `s:${site.id}`,
        kind: 'person',
        name: name(c.associate),
        subtitle: c.associate.jobProfile?.title ?? null,
        photoUrl: profilePhotoUrlFor(c.associate),
        associateId: c.associate.id,
        clientId: site.clientId,
        clientName: site.client?.name ?? null,
        siteName: site.name,
        former: !!c.associate.deactivatedAt,
      }),
    );
  }
  for (const n of nodes) if (n.kind === 'store') n.reports = crewCount.get(n.id.slice(2)) ?? 0;

  // Open seats under the client they hire for (its first node, when it spans regions).
  for (const p of positions) {
    const parent = p.clientId ? firstClientNode.get(p.clientId) : undefined;
    if (!parent) continue;
    nodes.push(
      blank({
        id: `p:${p.id}`,
        parentId: parent,
        kind: 'vacancy',
        name: p.title,
        subtitle: p.code,
        clientId: p.clientId,
        positionStatus: p.status as 'PLANNED' | 'OPEN' | 'FROZEN',
      }),
    );
  }
  if (unplacedCount > 0) {
    nodes.push(blank({ id: UNPLACED, kind: 'group', name: 'Not yet placed', subtitle: 'No open assignment anywhere', reports: unplacedCount }));
    for (const a of unplaced) {
      nodes.push(
        blank({
          id: `a:${a.id}@unplaced`,
          parentId: UNPLACED,
          kind: 'person',
          name: name(a),
          subtitle: a.jobProfile?.title ?? null,
          photoUrl: profilePhotoUrlFor(a),
          associateId: a.id,
        }),
      );
    }
  }
  return { view: 'field', nodes, fieldOnly: 0, unplaced: unplacedCount, truncated, limit: LIMIT };
}
