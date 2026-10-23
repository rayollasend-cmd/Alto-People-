import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { loginIpLimiter } from '../middleware/rateLimit.js';
import { withIdentityScope } from '../lib/tenant.js';

/**
 * GET /auth/org/:slug — the organization a sign-in address belongs to
 * (/login/<slug>), so the page can say "Sign in to Harbor Staffing" with
 * the organization's logo (F500 G5). Public, before any session: the
 * tenant is found by its unique slug in the identity scope, and only its
 * public face comes back — the name and whether a logo is on file. An
 * unknown or inactive address is a 404, said plainly by the page.
 *
 * GET /auth/org/:slug/logo — that organization's logo (a public brand
 * asset, as /admin/org/settings/logo already is for Alto HR's emails).
 */
export const publicOrgRouter = Router();

const Slug = z.string().trim().toLowerCase().regex(/^[a-z0-9-]{1,60}$/);

async function orgBySlug(raw: string) {
  const slug = Slug.safeParse(raw);
  if (!slug.success) return null;
  return withIdentityScope(async () => {
    const tenant = await prisma.tenant.findUnique({ where: { slug: slug.data }, select: { id: true, slug: true, name: true, status: true } });
    if (!tenant || tenant.status !== 'ACTIVE') return null;
    const setting = await prisma.orgSetting.findUnique({ where: { tenantId: tenant.id }, select: { logoUpdatedAt: true, logoContentType: true } });
    return { ...tenant, logoVersion: setting?.logoContentType && setting.logoUpdatedAt ? setting.logoUpdatedAt.getTime() : null };
  });
}

publicOrgRouter.get('/:slug', loginIpLimiter, async (req, res) => {
  const org = await orgBySlug(req.params.slug ?? '');
  if (!org) throw new HttpError(404, 'org_not_found', 'We don’t recognise that sign-in address.');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json({
    org: {
      name: org.name,
      slug: org.slug,
      logoUrl: org.logoVersion !== null ? `/auth/org/${org.slug}/logo?v=${org.logoVersion}` : null,
    },
  });
});

publicOrgRouter.get('/:slug/logo', loginIpLimiter, async (req, res) => {
  const slug = Slug.safeParse(req.params.slug);
  const logo = slug.success
    ? await withIdentityScope(async () => {
        const tenant = await prisma.tenant.findUnique({ where: { slug: slug.data }, select: { id: true, status: true } });
        if (!tenant || tenant.status !== 'ACTIVE') return null;
        return prisma.orgSetting.findUnique({ where: { tenantId: tenant.id }, select: { logoBytes: true, logoContentType: true } });
      })
    : null;
  if (!logo?.logoBytes || !logo.logoContentType) throw new HttpError(404, 'no_logo', 'No logo on file.');
  res.setHeader('Content-Type', logo.logoContentType);
  res.setHeader('Content-Length', String(logo.logoBytes.byteLength));
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.end(Buffer.from(logo.logoBytes));
});
