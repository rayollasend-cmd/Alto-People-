import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import {
  SavedViewInputSchema,
  SavedViewScopeSchema,
  SavedViewUpdateSchema,
  hasCapability,
  type Capability,
  type SavedViewScope,
} from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import type { SessionUser } from '../types/express.js';

/**
 * Saved views — a named set of filters on a list, kept by whoever made it
 * or shared with everyone who can see that list.
 *
 * A view stores the list's own URL params and nothing else, so opening one
 * is the same as following a link to it, and it can never show anyone
 * more than the list itself would. Only the owner renames, changes,
 * shares or deletes a view; a shared view is read-only to everyone else,
 * who can save their own copy.
 */

export const savedViewsRouter = Router();
savedViewsRouter.use(requireAuth);

/** Who may see a scope's views: whoever can see the list itself. */
const SCOPE_CAPABILITY: Record<SavedViewScope, Capability> = {
  'recruiting.candidates': 'view:recruiting',
};

const MAX_VIEWS_PER_OWNER = 50;

function assertScope(user: SessionUser, scope: SavedViewScope): void {
  if (!hasCapability(user.role, SCOPE_CAPABILITY[scope])) {
    throw new HttpError(403, 'forbidden', 'You cannot see this list.');
  }
}

type Row = Prisma.SavedViewGetPayload<{
  include: { owner: { select: { email: true; associate: { select: { firstName: true; lastName: true } } } } };
}>;

function view(row: Row, me: string) {
  const a = row.owner.associate;
  return {
    id: row.id,
    scope: row.scope as SavedViewScope,
    name: row.name,
    query: row.query as Record<string, string>,
    shared: row.shared,
    mine: row.ownerId === me,
    ownerName: a ? `${a.firstName} ${a.lastName}` : row.owner.email,
    updatedAt: row.updatedAt.toISOString(),
  };
}

const INCLUDE = {
  owner: { select: { email: true, associate: { select: { firstName: true, lastName: true } } } },
} as const;

async function ownView(id: string, me: string) {
  const row = await prisma.savedView.findUnique({ where: { id }, include: INCLUDE });
  // Someone else's private view doesn't exist for you.
  if (!row || (row.ownerId !== me && !row.shared)) throw new HttpError(404, 'not_found', 'View not found');
  if (row.ownerId !== me) throw new HttpError(403, 'not_owner', 'Only the person who made this view can change it.');
  return row;
}

/** GET /saved-views?scope= — mine first, then the team's shared ones. */
savedViewsRouter.get('/', async (req, res, next) => {
  try {
    const scope = SavedViewScopeSchema.parse(req.query.scope);
    assertScope(req.user!, scope);
    const me = req.user!.id;
    const rows = await prisma.savedView.findMany({
      where: { scope, OR: [{ ownerId: me }, { shared: true }] },
      include: INCLUDE,
      orderBy: [{ name: 'asc' }],
      take: 200,
    });
    const views = rows.map((r) => view(r, me));
    views.sort((a, b) => Number(b.mine) - Number(a.mine));
    res.json({ views });
  } catch (err) {
    next(err);
  }
});

savedViewsRouter.post('/', async (req, res, next) => {
  try {
    const input = SavedViewInputSchema.parse(req.body);
    assertScope(req.user!, input.scope);
    const me = req.user!.id;
    const count = await prisma.savedView.count({ where: { ownerId: me, scope: input.scope } });
    if (count >= MAX_VIEWS_PER_OWNER) {
      throw new HttpError(409, 'too_many_views', `You have ${MAX_VIEWS_PER_OWNER} views here already — delete one first.`);
    }
    const row = await prisma.savedView.create({
      data: { ownerId: me, scope: input.scope, name: input.name, query: input.query, shared: input.shared ?? false },
      include: INCLUDE,
    });
    res.status(201).json(view(row, me));
  } catch (err) {
    next(err);
  }
});

savedViewsRouter.patch('/:id', async (req, res, next) => {
  try {
    const input = SavedViewUpdateSchema.parse(req.body);
    const me = req.user!.id;
    const row = await ownView(req.params.id, me);
    const updated = await prisma.savedView.update({
      where: { id: row.id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.query !== undefined ? { query: input.query } : {}),
        ...(input.shared !== undefined ? { shared: input.shared } : {}),
      },
      include: INCLUDE,
    });
    res.json(view(updated, me));
  } catch (err) {
    next(err);
  }
});

savedViewsRouter.delete('/:id', async (req, res, next) => {
  try {
    const row = await ownView(req.params.id, req.user!.id);
    await prisma.savedView.delete({ where: { id: row.id } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
