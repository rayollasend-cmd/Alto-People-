import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { can, toDateOnly } from '@alto-people/shared';
import { orgDateKey } from '../lib/timeAnomalies.js';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireAnyCapability, requireCapability } from '../middleware/auth.js';
import { enqueueAudit } from '../lib/audit.js';
import { notifyAssociate } from '../lib/notify.js';
import { assertClientInScope, assertCompanyWide, isInternallyScoped, isNarrowedCaller, scopeAssociates, scopeClients, scopeSites } from '../lib/scope.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { inForceOn, photoPolicyFor, ruleLabel, type PhotoScope } from '../lib/punchPhotoPolicy.js';

/**
 * Photo at punch (lib/punchPhotoPolicy) — who sets it, for whom.
 *
 *   GET    /time/punch-photos                    every rule in force (company, clients, stores, people) + recent history
 *   PUT    /time/punch-photos/rules              { scope: COMPANY|CLIENT|SITE, clientId?, siteId?, required, reason? }   manage:time
 *   DELETE /time/punch-photos/rules/:id          { reason }   end a company / client / store rule      manage:time
 *   GET    /time/punch-photos/associates/:id     what applies to this person, why, their history, their recent punch photos
 *   PUT    /time/punch-photos/associates/:id     { required, reason, endsOn? }   manage:time, or a supervisor for their own people
 *   DELETE /time/punch-photos/associates/:id     { reason }   end the person's own rule (back to the store/client/company rule)
 *
 * Every change is audited; the person is told when a photo becomes required
 * for them (and when it stops), never the reason — that's HR's record.
 */

export const punchPhotosRouter = Router();

const MANAGE = requireCapability('manage:time');
const PERSON = requireAnyCapability('manage:time', 'manage:team-time');

// startsOn/endsOn are @db.Date: the calendar day as stored; "today" is the company's (orgDateKey).
const ymd = (d: Date) => toDateOnly(d)!;
const dateOnly = (s: string) => new Date(`${s}T00:00:00.000Z`);
const Ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

async function names(userIds: Array<string | null>): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter((x): x is string => !!x))];
  if (ids.length === 0) return new Map();
  const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, email: true, displayName: true, associate: { select: { firstName: true, lastName: true } } } });
  return new Map(users.map((u) => [u.id, u.displayName ?? (u.associate ? `${u.associate.firstName} ${u.associate.lastName}` : u.email)]));
}

type RuleRow = Prisma.PunchPhotoRuleGetPayload<object>;

async function shape(rules: RuleRow[]) {
  const [people, sites, clients, users] = await Promise.all([
    prisma.associate.findMany({ where: { id: { in: rules.map((r) => r.associateId).filter((x): x is string => !!x) } }, select: { id: true, firstName: true, lastName: true } }),
    prisma.site.findMany({ where: { id: { in: rules.map((r) => r.siteId).filter((x): x is string => !!x) } }, select: { id: true, name: true } }),
    prisma.client.findMany({ where: { id: { in: rules.map((r) => r.clientId).filter((x): x is string => !!x) } }, select: { id: true, name: true } }),
    names(rules.flatMap((r) => [r.createdById, r.endedById])),
  ]);
  const person = new Map(people.map((p) => [p.id, `${p.firstName} ${p.lastName}`]));
  const site = new Map(sites.map((s) => [s.id, s.name]));
  const client = new Map(clients.map((c) => [c.id, c.name]));
  return rules.map((r) => ({
    id: r.id,
    scope: r.scope as PhotoScope,
    required: r.required,
    clientId: r.clientId,
    clientName: r.clientId ? (client.get(r.clientId) ?? null) : null,
    siteId: r.siteId,
    siteName: r.siteId ? (site.get(r.siteId) ?? null) : null,
    associateId: r.associateId,
    associateName: r.associateId ? (person.get(r.associateId) ?? null) : null,
    label: ruleLabel(r, { client: r.clientId ? client.get(r.clientId) : null, site: r.siteId ? site.get(r.siteId) : null, person: r.associateId ? person.get(r.associateId) : null }),
    reason: r.reason,
    startsOn: ymd(r.startsOn),
    endsOn: r.endsOn ? ymd(r.endsOn) : null,
    setBy: r.createdById ? (users.get(r.createdById) ?? null) : null,
    setAt: r.createdAt.toISOString(),
    endedAt: r.endedAt?.toISOString() ?? null,
    endedBy: r.endedById ? (users.get(r.endedById) ?? null) : null,
    endReason: r.endReason,
  }));
}

type SessionUser = NonNullable<Express.Request['user']>;

/**
 * FLOOR-7 — whose rule is it? The company rule is a company-wide caller's
 * (manage:time alone let a one-client supervisor switch photos on for the
 * whole company). A client rule is for that client's own supervisor, or a
 * company-wide caller — a store-bound office account names its stores
 * instead, since a client rule would reach stores outside its reach. A
 * location rule is for a location inside the caller's reach.
 */
async function assertRuleTargetInReach(user: SessionUser, t: { scope: string; clientId: string | null; siteId: string | null }): Promise<void> {
  if (t.scope === 'COMPANY') {
    assertCompanyWide(user, 'The company-wide photo rule is set by someone without a client or site limit. Set it for your own locations.');
    return;
  }
  if (t.scope === 'CLIENT') {
    if (isInternallyScoped(user)) throw new HttpError(403, 'company_wide', 'A client-wide rule reaches locations outside yours. Set it for your own locations.');
    await assertClientInScope(prisma, user, t.clientId ?? '00000000-0000-0000-0000-000000000000');
    return;
  }
  const site = t.siteId
    ? await prisma.site.findFirst({ where: { AND: [{ id: t.siteId, tenantId: tenantIdForWrite() }, scopeSites(user)] }, select: { id: true } })
    : null;
  if (!site) throw new HttpError(404, 'site_not_found', 'Location not found.');
}

/** End whatever rule is in force for exactly this target (one per target at a time). */
async function endCurrent(where: Prisma.PunchPhotoRuleWhereInput, userId: string, reason: string) {
  await prisma.punchPhotoRule.updateMany({ where: { tenantId: tenantIdForWrite(), endedAt: null, ...where }, data: { endedAt: new Date(), endedById: userId, endReason: reason.slice(0, 500) } });
}

punchPhotosRouter.get('/', requireCapability('manage:time'), async (req, res, next) => {
  try {
    const user = req.user!;
    const tenantId = tenantIdForWrite();
    const today = orgDateKey(new Date());
    // A narrowed caller reads the company rule (it applies to them) and the
    // rules for their own clients, locations and people — not every client's.
    const narrowed = isNarrowedCaller(user);
    let reach: Prisma.PunchPhotoRuleWhereInput = {};
    if (narrowed) {
      const [clients, sites, people] = await Promise.all([
        prisma.client.findMany({ where: { AND: [{ tenantId }, scopeClients(user)] }, select: { id: true } }),
        prisma.site.findMany({ where: { AND: [{ tenantId }, scopeSites(user)] }, select: { id: true } }),
        prisma.associate.findMany({ where: { AND: [{ tenantId }, scopeAssociates(user)] }, select: { id: true } }),
      ]);
      reach = {
        OR: [
          { scope: 'COMPANY' },
          { scope: 'CLIENT', clientId: { in: clients.map((c) => c.id) } },
          { scope: 'SITE', siteId: { in: sites.map((s) => s.id) } },
          { scope: 'ASSOCIATE', associateId: { in: people.map((p) => p.id) } },
        ],
      };
    }
    const [active, ended] = await Promise.all([
      prisma.punchPhotoRule.findMany({ where: { AND: [{ tenantId, ...inForceOn(today) }, reach] }, orderBy: [{ scope: 'asc' }, { createdAt: 'desc' }] }),
      prisma.punchPhotoRule.findMany({ where: { AND: [{ tenantId, endedAt: { not: null } }, reach] }, orderBy: { endedAt: 'desc' }, take: 50 }),
    ]);
    const shaped = await shape(active);
    const missing30 = await prisma.kioskPunch.count({
      where: { tenantId, anomalyKind: 'NO_PHOTO', createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) }, ...(narrowed ? { associate: { is: scopeAssociates(user) } } : {}) },
    });
    // The places a narrowed caller may name, so the picker is never empty for
    // a supervisor whose stores have no kiosk listed yet.
    const places = narrowed
      ? await prisma.site.findMany({
          where: { AND: [{ tenantId, deletedAt: null, isActive: true }, scopeSites(user)] },
          select: { id: true, name: true, clientId: true, client: { select: { name: true } } },
          orderBy: { name: 'asc' },
          take: 500,
        })
      : null;
    res.json({
      // What the web may offer this caller (FLOOR-7): never a button the API refuses.
      canSetCompanyRule: !narrowed,
      canSetClientRules: !isInternallyScoped(user),
      places: places ? places.map((p) => ({ id: p.id, name: p.name, clientId: p.clientId, clientName: p.client?.name ?? '' })) : null,
      company: shaped.find((r) => r.scope === 'COMPANY') ?? null,
      clients: shaped.filter((r) => r.scope === 'CLIENT'),
      sites: shaped.filter((r) => r.scope === 'SITE'),
      people: shaped.filter((r) => r.scope === 'ASSOCIATE'),
      history: await shape(ended),
      noPhotoPunchesLast30Days: missing30,
    });
  } catch (err) {
    next(err);
  }
});

const RuleInput = z
  .object({
    scope: z.enum(['COMPANY', 'CLIENT', 'SITE']),
    clientId: z.string().uuid().optional(),
    siteId: z.string().uuid().optional(),
    required: z.boolean(),
    reason: z.string().trim().max(500).optional(),
  })
  .refine((v) => (v.scope === 'CLIENT' ? !!v.clientId && !v.siteId : v.scope === 'SITE' ? !!v.siteId : !v.clientId && !v.siteId), { message: 'Name the client for a client rule, the location for a location rule, and nothing for the company.' });

punchPhotosRouter.put('/rules', MANAGE, async (req, res, next) => {
  try {
    const input = RuleInput.parse(req.body);
    const tenantId = tenantIdForWrite();
    await assertRuleTargetInReach(req.user!, { scope: input.scope, clientId: input.clientId ?? null, siteId: input.siteId ?? null });
    if (input.clientId && !(await prisma.client.findFirst({ where: { id: input.clientId, tenantId }, select: { id: true } }))) throw new HttpError(404, 'client_not_found', 'Client not found.');
    if (input.siteId && !(await prisma.site.findFirst({ where: { id: input.siteId, tenantId }, select: { id: true } }))) throw new HttpError(404, 'site_not_found', 'Location not found.');
    const target: Prisma.PunchPhotoRuleWhereInput = { scope: input.scope, clientId: input.clientId ?? null, siteId: input.siteId ?? null, associateId: null };
    await endCurrent(target, req.user!.id, 'Replaced');
    const rule = await prisma.punchPhotoRule.create({
      data: { tenantId, scope: input.scope, clientId: input.clientId ?? null, siteId: input.siteId ?? null, required: input.required, reason: input.reason || null, startsOn: dateOnly(orgDateKey(new Date())), createdById: req.user!.id },
    });
    const [shaped] = await shape([rule]);
    enqueueAudit({ actorUserId: req.user!.id, action: 'time.punch_photo.rule_set', entityType: 'PunchPhotoRule', entityId: rule.id, metadata: { scope: rule.scope, required: rule.required, clientId: rule.clientId, siteId: rule.siteId, summary: shaped!.label } }, 'punchPhotos');
    res.json({ rule: shaped });
  } catch (err) {
    next(err);
  }
});

const EndInput = z.object({ reason: z.string().trim().min(3).max(500) });

punchPhotosRouter.delete('/rules/:id', MANAGE, async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const { reason } = EndInput.parse(req.body ?? {});
    const rule = await prisma.punchPhotoRule.findFirst({ where: { id, tenantId: tenantIdForWrite(), endedAt: null } });
    if (!rule || rule.scope === 'ASSOCIATE') throw new HttpError(404, 'rule_not_found', 'Rule not found.');
    // Ending a rule is setting one: the same reach (FLOOR-7).
    await assertRuleTargetInReach(req.user!, rule);
    await prisma.punchPhotoRule.update({ where: { id }, data: { endedAt: new Date(), endedById: req.user!.id, endReason: reason } });
    enqueueAudit({ actorUserId: req.user!.id, action: 'time.punch_photo.rule_ended', entityType: 'PunchPhotoRule', entityId: id, metadata: { scope: rule.scope, reason } }, 'punchPhotos');
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/** The person, if the caller may set their rule: manage:time everywhere they reach; a supervisor for their own people. */
async function personInReach(req: { user?: Express.Request['user']; params: { id?: string } }) {
  const id = z.string().uuid().parse(req.params.id);
  const user = req.user!;
  if (user.role === 'CLIENT_PORTAL') throw new HttpError(403, 'forbidden', 'Not available here.');
  const person = await prisma.associate.findFirst({
    where: { id, tenantId: tenantIdForWrite(), deletedAt: null, AND: [scopeAssociates(user)] },
    select: { id: true, firstName: true, lastName: true, assignments: { where: { endedAt: null }, orderBy: { startedAt: 'desc' }, take: 1, select: { locationId: true, location: { select: { clientId: true, name: true } } } } },
  });
  if (!person) throw new HttpError(404, 'associate_not_found', 'Person not found.');
  return person;
}

punchPhotosRouter.get('/associates/:id', PERSON, async (req, res, next) => {
  try {
    const person = await personInReach(req);
    const tenantId = tenantIdForWrite();
    const placement = person.assignments[0] ?? null;
    const policy = await photoPolicyFor(prisma, { associateId: person.id, siteId: placement?.locationId ?? null, clientId: placement?.location.clientId ?? null });
    const own = await prisma.punchPhotoRule.findMany({ where: { tenantId, scope: 'ASSOCIATE', associateId: person.id }, orderBy: { createdAt: 'desc' }, take: 20 });
    const shapedOwn = await shape(own);
    const [winning] = policy.rule ? await shape([await prisma.punchPhotoRule.findUniqueOrThrow({ where: { id: policy.rule.id } })]) : [null];
    const since = new Date(Date.now() - 30 * 86_400_000);
    const recent = await prisma.kioskPunch.findMany({
      where: { tenantId, associateId: person.id, action: { not: 'REJECTED' } },
      orderBy: { createdAt: 'desc' },
      take: 12,
      select: { id: true, action: true, createdAt: true, anomalyKind: true, reviewStatus: true, device: { select: { name: true } } },
    });
    // Which of those carry a photo, without hauling the bytes.
    const withPhoto = new Set(
      (await prisma.kioskPunch.findMany({ where: { id: { in: recent.map((p) => p.id) }, selfie: { not: null } }, select: { id: true } })).map((p) => p.id),
    );
    const [noPhoto30, refused30] = await Promise.all([
      prisma.kioskPunch.count({ where: { tenantId, associateId: person.id, anomalyKind: 'NO_PHOTO', createdAt: { gte: since } } }),
      prisma.kioskPunch.count({ where: { tenantId, associateId: person.id, rejectReason: 'photo_required', createdAt: { gte: since } } }),
    ]);
    res.json({
      associateId: person.id,
      name: `${person.firstName} ${person.lastName}`,
      location: placement?.location.name ?? null,
      required: policy.required,
      decidedBy: winning,
      ownRule: shapedOwn.find((r) => !r.endedAt && (!r.endsOn || r.endsOn >= orgDateKey(new Date()))) ?? null,
      history: shapedOwn,
      recentPunches: recent.map((p) => ({
        id: p.id,
        action: p.action,
        at: p.createdAt.toISOString(),
        kiosk: p.device.name,
        hasPhoto: withPhoto.has(p.id),
        flagged: p.anomalyKind === 'NO_PHOTO',
        reviewStatus: p.reviewStatus,
      })),
      last30Days: { keptWithoutPhoto: noPhoto30, refusedWithoutPhoto: refused30 },
      canSetCompanyRules: can(req.user!, 'manage:time') && !isNarrowedCaller(req.user!),
    });
  } catch (err) {
    next(err);
  }
});

const PersonInput = z
  .object({
    required: z.boolean(),
    reason: z.string().trim().max(500).optional(),
    endsOn: Ymd.nullable().optional(),
  })
  .refine((v) => !v.required || (v.reason ?? '').length >= 5, { message: 'Say why a photo is required for this person — it goes on the record.', path: ['reason'] });

punchPhotosRouter.put('/associates/:id', PERSON, async (req, res, next) => {
  try {
    const person = await personInReach(req);
    const input = PersonInput.parse(req.body);
    const today = orgDateKey(new Date());
    if (input.endsOn && input.endsOn < today) throw new HttpError(400, 'ends_in_past', 'The end date has to be today or later.');
    const tenantId = tenantIdForWrite();
    await endCurrent({ scope: 'ASSOCIATE', associateId: person.id }, req.user!.id, 'Replaced');
    const rule = await prisma.punchPhotoRule.create({
      data: { tenantId, scope: 'ASSOCIATE', associateId: person.id, required: input.required, reason: input.reason || null, startsOn: dateOnly(today), endsOn: input.endsOn ? dateOnly(input.endsOn) : null, createdById: req.user!.id },
    });
    const name = `${person.firstName} ${person.lastName}`;
    enqueueAudit({ actorUserId: req.user!.id, action: 'time.punch_photo.person_set', entityType: 'Associate', entityId: person.id, metadata: { required: rule.required, reason: rule.reason, endsOn: input.endsOn ?? null, summary: ruleLabel(rule, { person: name }) } }, 'punchPhotos');
    // They're told plainly — fairness, and the record that they knew. Never the reason.
    void notifyAssociate(person.id, {
      subject: rule.required ? 'A photo is now taken at your punches' : 'Your punch photo requirement changed',
      body: rule.required
        ? `From today, the kiosk takes a photo each time you clock in or out${input.endsOn ? `, through ${new Date(`${input.endsOn}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}` : ''}. Look at the camera when you punch. Questions go to your supervisor or HR.`
        : 'A photo is no longer required at your punches.',
      category: 'time',
    });
    const [shaped] = await shape([rule]);
    res.json({ rule: shaped });
  } catch (err) {
    next(err);
  }
});

punchPhotosRouter.delete('/associates/:id', PERSON, async (req, res, next) => {
  try {
    const person = await personInReach(req);
    const { reason } = EndInput.parse(req.body ?? {});
    const current = await prisma.punchPhotoRule.findFirst({ where: { tenantId: tenantIdForWrite(), scope: 'ASSOCIATE', associateId: person.id, endedAt: null } });
    if (!current) throw new HttpError(404, 'rule_not_found', 'This person has no rule of their own.');
    await endCurrent({ scope: 'ASSOCIATE', associateId: person.id }, req.user!.id, reason);
    enqueueAudit({ actorUserId: req.user!.id, action: 'time.punch_photo.person_ended', entityType: 'Associate', entityId: person.id, metadata: { reason, wasRequired: current.required } }, 'punchPhotos');
    if (current.required) {
      void notifyAssociate(person.id, { subject: 'Your punch photo requirement ended', body: 'The extra photo requirement at your punches has ended. Your location’s usual rule applies again.', category: 'time' });
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
