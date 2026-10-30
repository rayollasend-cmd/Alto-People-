import { Router, type Request } from 'express';
import { z } from 'zod';
import { HUGO_MEMORY_MAX, HugoMemoryInputSchema, HugoMemoryPatchSchema, HugoMemorySettingsInputSchema, type HugoMemoryListResponse } from '@alto-people/shared';
import { requireAuth } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { type Asker, contextFor } from '../lib/hugoRegistry.js';
import { modelServes } from '../lib/hugoAllowance.js';
import { addHugoMemory, editHugoMemory, forgetAllHugoMemory, hugoMemoryFor, memoryOnFor, removeHugoMemory, setHugoMemoryOn } from '../lib/hugoMemory.js';

/**
 * What Hugo knows (lib/hugoMemory) — the person's own facts, mounted at
 * /hugo/memory by routes/hugo:
 *
 *   GET    /hugo/memory            { memoryOn, facts, max }
 *   POST   /hugo/memory            { text, kind } → 201 { fact } (200 when it was already kept);
 *                                  422 memory_refused { reason } when the guard says no; 409 memory_off
 *   PATCH  /hugo/memory/:id        { text?, kind? } → { fact } (the same guard for new words)
 *   DELETE /hugo/memory/:id        → { ok } ("Remove", or Undo under an answer)
 *   DELETE /hugo/memory            { confirm: true } → { forgot } (Forget everything — the app asks first)
 *   PUT    /hugo/memory/settings   { memoryOn } → { memoryOn }
 *
 * Only ever the caller's own rows: another person's id is a 404. Reading
 * and removing work whenever the person is signed in — their right to see
 * and erase what is kept doesn't depend on the assistant being switched on;
 * adding, changing and the switch need the assistant to serve them.
 * An associate's Hugo answers without the model, which is the only reader
 * of these facts: adding and changing are 409 hugo_no_memory for them.
 * Every change is audited with kinds and counts, never the words.
 */

export const hugoMemoryRouter = Router();

const IdParam = z.object({ id: z.string().uuid() });

/** The assistant serves this person here (403 no_hugo / 409 hugo_off otherwise). */
async function served(req: Request) {
  await contextFor(req.user! as Asker);
  return req.user!;
}

/** Facts are for the model to read: an associate's Hugo never uses it (lib/hugoAllowance modelServes), so it keeps nothing new. */
function keepsFacts(req: Request): void {
  if (!modelServes(req.user!.role, req.user!.primaryRole)) throw new HttpError(409, 'hugo_no_memory', 'Hugo doesn’t keep notes for you here.');
}

hugoMemoryRouter.get('/', requireAuth, async (req, res) => {
  const user = req.user!;
  const [memoryOn, facts] = await Promise.all([memoryOnFor(user.id), hugoMemoryFor(user.id)]);
  const out: HugoMemoryListResponse = { memoryOn, facts, max: HUGO_MEMORY_MAX };
  res.json(out);
});

hugoMemoryRouter.post('/', requireAuth, async (req, res) => {
  const user = await served(req);
  keepsFacts(req);
  const { text, kind } = HugoMemoryInputSchema.parse(req.body ?? {});
  const out = await addHugoMemory(user, text, kind);
  res.status(out.existing ? 200 : 201).json(out);
});

hugoMemoryRouter.put('/settings', requireAuth, async (req, res) => {
  const user = await served(req);
  const { memoryOn } = HugoMemorySettingsInputSchema.parse(req.body ?? {});
  res.json({ memoryOn: await setHugoMemoryOn(user, memoryOn) });
});

hugoMemoryRouter.patch('/:id', requireAuth, async (req, res) => {
  const user = await served(req);
  keepsFacts(req);
  const { id } = IdParam.parse(req.params);
  const patch = HugoMemoryPatchSchema.parse(req.body ?? {});
  res.json({ fact: await editHugoMemory(user, id, patch) });
});

hugoMemoryRouter.delete('/:id', requireAuth, async (req, res) => {
  const { id } = IdParam.parse(req.params);
  const via = req.query.via === 'undo' ? 'undo' : 'list';
  await removeHugoMemory(req.user!, id, via);
  res.json({ ok: true });
});

/** Forget everything is never one stray request: the body says so. */
const ForgetAllSchema = z.object({ confirm: z.literal(true) });

hugoMemoryRouter.delete('/', requireAuth, async (req, res) => {
  ForgetAllSchema.parse(req.body ?? {});
  res.json({ forgot: await forgetAllHugoMemory(req.user!) });
});
