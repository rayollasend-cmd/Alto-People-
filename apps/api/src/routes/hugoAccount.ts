import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireCapability } from '../middleware/auth.js';
import { modelAvailable } from '../lib/assistantModel.js';
import { type Asker, contextFor } from '../lib/hugoRegistry.js';
import { clearHugoThread, hugoAdminUsage, hugoProfileView, hugoThread, setHugoReadAloud } from '../lib/hugoThread.js';
import { assertCompanyWide } from '../lib/scope.js';

/**
 * One Hugo per account (lib/hugoThread) — mounted inside routes/hugo:
 *
 *   GET    /hugo/thread        the person's own conversation (last 50 turns, kept 90 days)
 *   DELETE /hugo/thread        "Start over" — on every device
 *   GET    /hugo/profile       their Hugo settings: read aloud, last start-over, how long turns are kept
 *   PATCH  /hugo/profile       { readAloud }
 *   GET    /hugo/admin/usage   manage:org, company-wide: this month's spend on Hugo's thinking
 *
 * The person's own rows only, keyed by the session — never an id in the
 * request. Their routes answer as GET /hugo does for someone Hugo doesn't
 * serve (403) or while he's switched off (409).
 */
export const hugoAccountRouter = Router();

const ProfilePatchSchema = z.object({ readAloud: z.boolean() }).strict();

hugoAccountRouter.get('/thread', requireAuth, async (req, res) => {
  await contextFor(req.user! as Asker);
  res.json(await hugoThread(req.user!.id));
});

hugoAccountRouter.delete('/thread', requireAuth, async (req, res) => {
  await contextFor(req.user! as Asker);
  res.json(await clearHugoThread(req.user!));
});

hugoAccountRouter.get('/profile', requireAuth, async (req, res) => {
  await contextFor(req.user! as Asker);
  res.json(await hugoProfileView(req.user!.id));
});

hugoAccountRouter.patch('/profile', requireAuth, async (req, res) => {
  await contextFor(req.user! as Asker);
  const { readAloud } = ProfilePatchSchema.parse(req.body ?? {});
  res.json(await setHugoReadAloud(req.user!, readAloud));
});

/**
 * The organization's spend on Hugo's thinking, this month. Whole-company by
 * design (it names the people who spent the most): an account narrowed to
 * sites or regions is refused, like the executive views.
 */
hugoAccountRouter.get('/admin/usage', requireAuth, requireCapability('manage:org'), async (req, res) => {
  assertCompanyWide(req.user!, 'Hugo’s spend covers the whole company; ask someone without a site limit.');
  res.json(await hugoAdminUsage(modelAvailable()));
});
