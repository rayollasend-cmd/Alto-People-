import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireAnyCapability, requireAuth, requireCapability } from '../middleware/auth.js';
import { enqueueAudit } from '../lib/audit.js';
import { currentStoreWindows, ledWindows } from '../lib/shiftWindows.js';

/**
 * Supervisor shift windows — assign a supervisor to the store shift windows
 * they lead ("Overnight 10p–6a"), the way they're assigned a client.
 *
 *   GET /me/shift-windows                 the caller's own windows (focus)
 *   GET /admin/shift-windows?clientId=    a client's stores, their windows,
 *                                         and who leads each (gaps show)
 *   GET /admin/shift-windows/gaps         every client: shifts nobody leads,
 *                                         supervisors with no shift
 *   PUT /admin/users/:id/shift-windows    set a supervisor's windows
 *
 * The reads are open to whoever can view the users admin OR assign a
 * shift (manage:org — the Workforce Manager staffs supervisors without
 * the HR admin view); the write is manage:org, as assigning a client is.
 *
 * Focus, not a lock — see lib/shiftWindows.ts.
 */
export const shiftWindowsRouter = Router();

const WINDOW_ROLES = new Set(['SHIFT_SUPERVISOR']);

function personName(u: { email: string; associate: { firstName: string; lastName: string } | null }) {
  return u.associate ? `${u.associate.firstName} ${u.associate.lastName}` : (u.email.split('@')[0] ?? u.email);
}

shiftWindowsRouter.get('/me/shift-windows', requireAuth, async (req, res) => {
  if (!WINDOW_ROLES.has(req.user!.role)) {
    res.json({ windows: [] });
    return;
  }
  const windows = await ledWindows(prisma, { userId: req.user!.id });
  res.json({
    windows: windows.map((w) => ({
      locationId: w.locationId,
      locationName: w.locationName,
      timezone: w.timezone,
      label: w.label,
      startMinute: w.startMinute,
      endMinute: w.endMinute,
      targetCount: w.targetCount,
    })),
  });
});

const CAN_READ = requireAnyCapability('view:hr-admin', 'manage:org');

shiftWindowsRouter.get('/admin/shift-windows/gaps', CAN_READ, async (_req, res) => {
  const stores = await prisma.location.findMany({
    where: { deletedAt: null, isActive: true, client: { deletedAt: null, status: 'ACTIVE' } },
    select: { id: true, name: true, clientId: true, client: { select: { name: true } } },
  });
  const [defs, supervisors] = await Promise.all([
    currentStoreWindows(prisma, stores.map((s) => s.id)),
    prisma.user.findMany({
      where: {
        role: 'SHIFT_SUPERVISOR',
        status: 'ACTIVE',
        deletedAt: null,
        clientId: { in: [...new Set(stores.map((s) => s.clientId))] },
      },
      select: {
        id: true,
        email: true,
        clientId: true,
        associate: { select: { firstName: true, lastName: true } },
        supervisorShiftWindows: { select: { locationId: true, label: true } },
      },
      orderBy: { createdAt: 'asc' },
    }),
  ]);
  const storeById = new Map(stores.map((s) => [s.id, s]));
  const byClient = new Map<string, { clientId: string; clientName: string }>();
  for (const s of stores) byClient.set(s.clientId, { clientId: s.clientId, clientName: s.client.name });

  let total = 0;
  let covered = 0;
  const clients = [];
  for (const c of [...byClient.values()].sort((a, b) => a.clientName.localeCompare(b.clientName))) {
    const windows = [...defs.values()].filter((w) => storeById.get(w.locationId)?.clientId === c.clientId);
    if (windows.length === 0) continue;
    const sups = supervisors
      .filter((u) => u.clientId === c.clientId)
      .map((u) => ({
        userId: u.id,
        name: personName(u),
        email: u.email,
        // Only assignments the store still defines count as a shift.
        windows: u.supervisorShiftWindows
          .filter((w) => defs.has(`${w.locationId}|${w.label}`))
          .map((w) => ({ ...w, locationName: storeById.get(w.locationId)?.name ?? '' })),
      }));
    const led = new Set(sups.flatMap((u) => u.windows.map((w) => `${w.locationId}|${w.label}`)));
    const uncovered = windows
      .filter((w) => !led.has(`${w.locationId}|${w.label}`))
      .sort(
        (a, b) =>
          (storeById.get(a.locationId)?.name ?? '').localeCompare(storeById.get(b.locationId)?.name ?? '') ||
          a.startMinute - b.startMinute,
      )
      .map((w) => ({
        locationId: w.locationId,
        locationName: storeById.get(w.locationId)?.name ?? '',
        label: w.label,
        startMinute: w.startMinute,
        endMinute: w.endMinute,
      }));
    const noShift = sups.filter((u) => u.windows.length === 0);
    total += windows.length;
    covered += windows.length - uncovered.length;
    if (uncovered.length === 0 && noShift.length === 0) continue;
    clients.push({ ...c, uncovered, noShift: noShift.map((u) => u.userId), supervisors: sups });
  }
  res.json({ total, covered, clients });
});

shiftWindowsRouter.get(
  '/admin/shift-windows',
  CAN_READ,
  async (req, res) => {
    const clientId = z.string().uuid().parse(req.query.clientId);
    const stores = await prisma.location.findMany({
      where: { clientId, deletedAt: null, isActive: true },
      select: { id: true, name: true, timezone: true },
      orderBy: { name: 'asc' },
    });
    const [defs, assignments] = await Promise.all([
      currentStoreWindows(prisma, stores.map((s) => s.id)),
      prisma.supervisorShiftWindow.findMany({
        where: {
          locationId: { in: stores.map((s) => s.id) },
          user: { role: 'SHIFT_SUPERVISOR', status: 'ACTIVE', deletedAt: null, clientId },
        },
        select: {
          locationId: true,
          label: true,
          user: { select: { id: true, email: true, associate: { select: { firstName: true, lastName: true } } } },
        },
      }),
    ]);
    res.json({
      stores: stores.map((s) => ({
        locationId: s.id,
        locationName: s.name,
        timezone: s.timezone,
        windows: [...defs.values()]
          .filter((w) => w.locationId === s.id)
          .sort((a, b) => a.startMinute - b.startMinute)
          .map((w) => ({
            label: w.label,
            startMinute: w.startMinute,
            endMinute: w.endMinute,
            targetCount: w.targetCount,
            leads: assignments
              .filter((a) => a.locationId === s.id && a.label === w.label)
              .map((a) => ({ userId: a.user.id, name: personName(a.user) })),
          })),
      })),
    });
  },
);

const PutInput = z.object({
  windows: z
    .array(z.object({ locationId: z.string().uuid(), label: z.string().trim().min(1).max(80) }))
    .max(20),
});

shiftWindowsRouter.put(
  '/admin/users/:id/shift-windows',
  // Same gate as assigning the client (PATCH /admin/users/:id).
  requireCapability('manage:org'),
  async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const input = PutInput.parse(req.body);
    const target = await prisma.user.findUnique({
      where: { id },
      select: { id: true, role: true, clientId: true, deletedAt: true },
    });
    if (!target || target.deletedAt) throw new HttpError(404, 'not_found', 'User not found.');
    if (!WINDOW_ROLES.has(target.role)) {
      throw new HttpError(400, 'not_a_supervisor', 'Only shift supervisors lead shift windows.');
    }
    if (!target.clientId) {
      throw new HttpError(400, 'client_required', 'Assign the supervisor a client first.');
    }
    const stores = await prisma.location.findMany({
      where: { clientId: target.clientId, deletedAt: null },
      select: { id: true },
    });
    const defs = await currentStoreWindows(prisma, stores.map((s) => s.id));
    const wanted = new Map(input.windows.map((w) => [`${w.locationId}|${w.label}`, w]));
    for (const key of wanted.keys()) {
      if (!defs.has(key)) {
        throw new HttpError(
          400,
          'window_not_found',
          "That shift isn't one of this client's store shift windows.",
        );
      }
    }
    // Every supervisor has a shift — once the client's stores define any.
    if (wanted.size === 0 && defs.size > 0) {
      throw new HttpError(400, 'shift_required', 'A shift supervisor needs at least one shift.');
    }

    await prisma.$transaction([
      prisma.supervisorShiftWindow.deleteMany({ where: { userId: id } }),
      prisma.supervisorShiftWindow.createMany({
        data: [...wanted.values()].map((w) => ({ userId: id, locationId: w.locationId, label: w.label })),
      }),
    ]);
    enqueueAudit(
      {
        actorUserId: req.user!.id,
        action: 'user.shift_windows_set',
        entityType: 'User',
        entityId: id,
        metadata: { windows: [...wanted.values()] },
      },
      'user.shift_windows_set',
    );
    res.json({ windows: [...wanted.values()] });
  },
);
