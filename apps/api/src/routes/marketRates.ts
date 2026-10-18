import { Router } from 'express';
import PDFDocument from 'pdfkit';
import { z } from 'zod';
import { prisma } from '../db.js';
import { env } from '../config/env.js';
import { HttpError } from '../middleware/error.js';
import { requireAnyCapability } from '../middleware/auth.js';
import { enqueueAudit } from '../lib/audit.js';
import { getBrandingSync } from '../lib/branding.js';
import { internalSites, scopeWhere } from '../lib/scope.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { CBSA_CATALOG, SOC_CATALOG, cbsaByCode, positionKey, socByCode, suggestArea, suggestSoc } from '../lib/marketCatalog.js';
import { marketRows, parseOewsCsv, refreshTenantWages, tenantPairs, upsertWages, type MarketRow } from '../lib/marketWages.js';
import type { Prisma } from '@prisma/client';

/**
 * The market rates desk.
 *
 *   GET  /market-rates                        every store-role priced against its metro, with a recommendation
 *   GET  /market-rates/mapping                stores → metro and roles → occupation, with suggestions
 *   PUT  /market-rates/site-area              { siteId, areaCode | null }
 *   PUT  /market-rates/position-soc           { position, socCode | null }
 *   PUT  /market-rates/client-margin          { clientId, targetMarginPct | null }
 *   GET  /market-rates/data                   how fresh the wage data is
 *   POST /market-rates/refresh                fetch from BLS now
 *   POST /market-rates/import                 { year, csv } the published OEWS table
 *   GET  /market-rates/clients/:id/brief.pdf  the negotiation brief for one client
 *
 * Reading needs view:clients (bill rates and margins are money); changing
 * a mapping, a margin or the data needs manage:clients or process:payroll.
 * Every read is the caller's tenant and the stores in their reach. A rate
 * itself is never changed here — the desk proposes, the dated rate card
 * and its approval decide.
 */
export const marketRatesRouter = Router();

const VIEW = requireAnyCapability('view:clients');
const MANAGE = requireAnyCapability('manage:clients', 'process:payroll');

const Filters = z.object({
  clientId: z.string().uuid().optional(),
  siteId: z.string().uuid().optional(),
  position: z.string().trim().max(120).optional(),
});

marketRatesRouter.get('/market-rates', VIEW, async (req, res, next) => {
  try {
    const f = Filters.parse(req.query);
    const out = await marketRows(req.user!, { clientId: f.clientId ?? null, siteId: f.siteId ?? null, position: f.position ?? null });
    const priced = out.rows.filter((r) => r.market?.median != null);
    const below = priced.filter((r) => (r.gapToMedian ?? 0) > 0.25);
    res.json({
      ...out,
      summary: {
        rows: out.rows.length,
        priced: priced.length,
        unmapped: out.rows.length - priced.length,
        belowMedian: below.length,
        // Average distance from the metro median, weighted equally per store-role.
        avgRatioToMedian: priced.length ? Math.round((priced.reduce((t, r) => t + r.payRate / r.market!.median!, 0) / priced.length) * 1000) / 1000 : null,
        lowestFill: priced
          .filter((r) => r.fill.fillRate !== null && r.fill.shifts >= 10)
          .sort((a, b) => a.fill.fillRate! - b.fill.fillRate!)[0]?.key ?? null,
      },
    });
  } catch (err) {
    next(err);
  }
});

/* ----- Mapping -------------------------------------------------------------- */

marketRatesRouter.get('/market-rates/mapping', VIEW, async (req, res, next) => {
  try {
    const tenantId = tenantIdForWrite();
    const reach = internalSites(req.user!);
    const [sites, positions, profiles, cards, maps] = await Promise.all([
      prisma.site.findMany({
        where: scopeWhere<Prisma.SiteWhereInput>({ tenantId, deletedAt: null, isActive: true }, reach ?? undefined),
        orderBy: { name: 'asc' },
        take: 1000,
        select: { id: true, name: true, zip: true, city: true, state: true, marketAreaCode: true, marketAreaName: true, client: { select: { name: true } } },
      }),
      prisma.shiftPosition.findMany({ where: { tenantId, deletedAt: null }, select: { name: true }, take: 2000 }),
      prisma.jobProfile.findMany({ where: { tenantId, deletedAt: null }, select: { title: true }, take: 2000 }),
      prisma.shiftRateDefault.findMany({ where: { tenantId, effectiveTo: null }, select: { position: true }, distinct: ['position'], take: 2000 }),
      prisma.positionSocMap.findMany({ where: { tenantId }, select: { positionKey: true, position: true, socCode: true, socTitle: true } }),
    ]);
    const mapped = new Map(maps.map((m) => [m.positionKey, m]));
    const names = new Map<string, string>();
    for (const n of [...cards.map((c) => c.position), ...positions.map((p) => p.name), ...profiles.map((p) => p.title), ...maps.map((m) => m.position)]) {
      const k = positionKey(n);
      if (k && !names.has(k)) names.set(k, n.trim());
    }
    res.json({
      sites: sites.map((s) => {
        const suggestion = s.marketAreaCode ? null : suggestArea(s);
        return {
          id: s.id,
          name: s.name,
          clientName: s.client?.name ?? null,
          place: [s.city, s.state].filter(Boolean).join(', ') || null,
          zip: s.zip,
          area: s.marketAreaCode ? { code: s.marketAreaCode, name: s.marketAreaName ?? cbsaByCode(s.marketAreaCode)?.name ?? s.marketAreaCode } : null,
          suggestion: suggestion ? { code: suggestion.value.code, name: suggestion.value.name, reason: suggestion.reason } : null,
        };
      }),
      positions: [...names.entries()]
        .map(([key, name]) => {
          const m = mapped.get(key);
          const suggestion = m ? null : suggestSoc(name);
          return {
            key,
            name,
            soc: m ? { code: m.socCode, title: m.socTitle } : null,
            suggestion: suggestion ? { code: suggestion.value.code, title: suggestion.value.title, reason: suggestion.reason } : null,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name)),
      catalog: { areas: CBSA_CATALOG.map(({ code, name, state }) => ({ code, name, state })), occupations: SOC_CATALOG.map(({ code, title }) => ({ code, title })) },
    });
  } catch (err) {
    next(err);
  }
});

const SiteArea = z.object({
  siteId: z.string().uuid(),
  areaCode: z.string().regex(/^\d{5}$/, 'A metro area code is five digits.').nullable(),
  areaName: z.string().trim().min(2).max(160).optional(),
});

marketRatesRouter.put('/market-rates/site-area', MANAGE, async (req, res, next) => {
  try {
    const input = SiteArea.parse(req.body ?? {});
    const reach = internalSites(req.user!);
    const site = await prisma.site.findFirst({
      where: scopeWhere<Prisma.SiteWhereInput>({ id: input.siteId, tenantId: tenantIdForWrite(), deletedAt: null }, reach ?? undefined),
      select: { id: true, marketAreaCode: true },
    });
    if (!site) throw new HttpError(404, 'site_not_found', 'No such store in your reach.');
    const known = input.areaCode ? cbsaByCode(input.areaCode) : null;
    if (input.areaCode && !known && !input.areaName) {
      throw new HttpError(400, 'area_name_required', 'That metro isn’t in the list — give its name too.');
    }
    const areaName = input.areaCode ? (known?.name ?? input.areaName!) : null;
    await prisma.site.update({ where: { id: site.id }, data: { marketAreaCode: input.areaCode, marketAreaName: areaName } });
    enqueueAudit(
      { actorUserId: req.user!.id, action: 'market.site_area_set', entityType: 'Site', entityId: site.id, metadata: { from: site.marketAreaCode, to: input.areaCode } },
      'market.mapping',
    );
    res.json({ ok: true, area: input.areaCode ? { code: input.areaCode, name: areaName } : null });
  } catch (err) {
    next(err);
  }
});

const PositionSoc = z.object({
  position: z.string().trim().min(1).max(120),
  socCode: z.string().regex(/^\d{2}-\d{4}$/, 'An occupation code looks like 53-7065.').nullable(),
  socTitle: z.string().trim().min(2).max(200).optional(),
});

marketRatesRouter.put('/market-rates/position-soc', MANAGE, async (req, res, next) => {
  try {
    const input = PositionSoc.parse(req.body ?? {});
    const tenantId = tenantIdForWrite();
    const key = positionKey(input.position);
    const before = await prisma.positionSocMap.findFirst({ where: { tenantId, positionKey: key }, select: { id: true, socCode: true } });
    if (!input.socCode) {
      if (before) await prisma.positionSocMap.delete({ where: { id: before.id } });
    } else {
      const known = socByCode(input.socCode);
      if (!known && !input.socTitle) throw new HttpError(400, 'soc_title_required', 'That occupation isn’t in the list — give its title too.');
      const socTitle = known?.title ?? input.socTitle!;
      if (before) await prisma.positionSocMap.update({ where: { id: before.id }, data: { socCode: input.socCode, socTitle, position: input.position, updatedById: req.user!.id } });
      else await prisma.positionSocMap.create({ data: { tenantId, positionKey: key, position: input.position, socCode: input.socCode, socTitle, updatedById: req.user!.id } });
    }
    enqueueAudit(
      { actorUserId: req.user!.id, action: 'market.position_soc_set', entityType: 'PositionSocMap', entityId: before?.id ?? key, metadata: { position: input.position, from: before?.socCode ?? null, to: input.socCode } },
      'market.mapping',
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

const ClientMargin = z.object({ clientId: z.string().uuid(), targetMarginPct: z.number().min(0).max(90).nullable() });

marketRatesRouter.put('/market-rates/client-margin', MANAGE, async (req, res, next) => {
  try {
    const input = ClientMargin.parse(req.body ?? {});
    const client = await prisma.client.findFirst({ where: { id: input.clientId, tenantId: tenantIdForWrite(), deletedAt: null }, select: { id: true, targetMarginPct: true } });
    if (!client) throw new HttpError(404, 'client_not_found', 'Client not found.');
    // A site-bound account sets a margin only for a client whose stores are all theirs.
    const reach = internalSites(req.user!);
    if (reach) {
      const outside = await prisma.site.count({ where: { AND: [{ clientId: client.id, deletedAt: null, isActive: true }, { NOT: reach }] } });
      if (outside > 0) throw new HttpError(403, 'scope_too_narrow', 'This client has stores outside your reach.');
    }
    await prisma.client.update({ where: { id: client.id }, data: { targetMarginPct: input.targetMarginPct } });
    enqueueAudit(
      {
        actorUserId: req.user!.id,
        action: 'market.client_margin_set',
        entityType: 'Client',
        entityId: client.id,
        metadata: { from: client.targetMarginPct === null ? null : Number(client.targetMarginPct), to: input.targetMarginPct },
      },
      'market.margin',
    );
    res.json({ ok: true, targetMarginPct: input.targetMarginPct });
  } catch (err) {
    next(err);
  }
});

/* ----- The data -------------------------------------------------------------- */

marketRatesRouter.get('/market-rates/data', VIEW, async (_req, res, next) => {
  try {
    const pairs = await tenantPairs();
    const rows = pairs.length
      ? await prisma.marketWage.findMany({
          where: { OR: pairs.map((p) => ({ areaCode: p.areaCode, socCode: p.socCode })) },
          select: { areaCode: true, socCode: true, year: true, fetchedAt: true, source: true },
        })
      : [];
    const have = new Set(rows.map((r) => `${r.areaCode}|${r.socCode}`));
    const latest = rows.reduce<Date | null>((m, r) => (!m || r.fetchedAt > m ? r.fetchedAt : m), null);
    res.json({
      pairs: pairs.length,
      covered: pairs.filter((p) => have.has(`${p.areaCode}|${p.socCode}`)).length,
      missing: pairs.filter((p) => !have.has(`${p.areaCode}|${p.socCode}`)).slice(0, 50).map((p) => ({ areaCode: p.areaCode, areaName: cbsaByCode(p.areaCode)?.name ?? p.areaCode, socCode: p.socCode, socTitle: socByCode(p.socCode)?.title ?? p.socCode })),
      latestYear: rows.reduce<number | null>((m, r) => (m === null || r.year > m ? r.year : m), null),
      lastFetchedAt: latest?.toISOString() ?? null,
      sources: [...new Set(rows.map((r) => r.source))],
      apiKeyConfigured: !!env.BLS_API_KEY,
      refreshEveryHours: env.MARKET_WAGE_REFRESH_HOURS,
    });
  } catch (err) {
    next(err);
  }
});

marketRatesRouter.post('/market-rates/refresh', MANAGE, async (req, res, next) => {
  try {
    let result;
    try {
      result = await refreshTenantWages(prisma, { force: req.body?.force === true });
    } catch (err) {
      throw new HttpError(502, 'bls_unreachable', `The wage data service couldn’t be reached (${err instanceof Error ? err.message : 'unknown error'}). Try again, or import the OEWS table.`);
    }
    enqueueAudit({ actorUserId: req.user!.id, action: 'market.wages_refreshed', entityType: 'MarketWage', entityId: tenantIdForWrite(), metadata: { ...result } }, 'market.data');
    res.json(result);
  } catch (err) {
    next(err);
  }
});

const ImportBody = z.object({ year: z.number().int().min(2015).max(2100), csv: z.string().min(10).max(25_000_000) });

marketRatesRouter.post('/market-rates/import', MANAGE, async (req, res, next) => {
  try {
    const input = ImportBody.parse(req.body ?? {});
    let parsed;
    try {
      parsed = parseOewsCsv(input.csv, input.year);
    } catch (err) {
      throw new HttpError(400, 'bad_file', err instanceof Error ? err.message : 'That file couldn’t be read.');
    }
    const saved = await upsertWages(prisma, parsed.rows, 'OEWS_IMPORT');
    enqueueAudit({ actorUserId: req.user!.id, action: 'market.wages_imported', entityType: 'MarketWage', entityId: tenantIdForWrite(), metadata: { year: input.year, rows: parsed.rows.length, saved, skipped: parsed.skipped } }, 'market.data');
    res.json({ rows: parsed.rows.length, saved, skipped: parsed.skipped });
  } catch (err) {
    next(err);
  }
});

/* ----- The negotiation brief -------------------------------------------------- */

const money = (x: number | null | undefined) => (x === null || x === undefined ? '—' : `$${x.toFixed(2)}`);

export async function renderMarketBrief(input: { orgName: string; clientName: string; rows: MarketRow[]; at: Date }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', layout: 'landscape', margin: 44, info: { Title: `${input.clientName} — market rates`, Author: input.orgName, CreationDate: input.at } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.font('Helvetica-Bold').fontSize(18).fillColor('#111').text(`${input.clientName}: pay against the local market`);
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(9).fillColor('#555').text(`${input.orgName} · ${input.at.toISOString().slice(0, 10)} · Market figures: U.S. Bureau of Labor Statistics, Occupational Employment and Wage Statistics (hourly, by metro area).`);
    doc.moveDown(1);

    const cols = [
      { h: 'Store', w: 130 },
      { h: 'Role', w: 110 },
      { h: 'Metro', w: 130 },
      { h: 'Pay now', w: 55 },
      { h: '25th', w: 45 },
      { h: 'Median', w: 50 },
      { h: '75th', w: 45 },
      { h: 'Fill (90 days)', w: 65 },
      { h: 'Suggested pay', w: 65 },
      { h: 'Bill to match', w: 65 },
    ];
    const header = () => {
      let x = doc.page.margins.left;
      const y = doc.y;
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#333');
      for (const c of cols) {
        doc.text(c.h, x, y, { width: c.w - 6 });
        x += c.w;
      }
      doc.moveTo(doc.page.margins.left, doc.y + 3).lineTo(doc.page.width - doc.page.margins.right, doc.y + 3).strokeColor('#ccc').stroke();
      doc.moveDown(0.6);
    };
    header();
    doc.font('Helvetica').fontSize(8).fillColor('#111');
    for (const r of input.rows) {
      if (doc.y > doc.page.height - doc.page.margins.bottom - 40) {
        doc.addPage();
        header();
        doc.font('Helvetica').fontSize(8).fillColor('#111');
      }
      const cells = [
        r.siteName,
        r.position,
        r.area?.name ?? 'Metro not set',
        money(r.payRate),
        money(r.market?.p25),
        money(r.market?.median),
        money(r.market?.p75),
        r.fill.fillRate === null ? '—' : `${Math.round(r.fill.fillRate * 100)}%`,
        money(r.recommendation?.payRate),
        money(r.recommendation?.billRate),
      ];
      let x = doc.page.margins.left;
      const y = doc.y;
      let maxY = y;
      cells.forEach((cell, i) => {
        doc.text(cell, x, y, { width: cols[i]!.w - 6 });
        maxY = Math.max(maxY, doc.y);
        x += cols[i]!.w;
      });
      doc.y = maxY + 4;
    }
    doc.moveDown(1);
    doc.font('Helvetica').fontSize(8).fillColor('#555').text('“Bill to match” keeps the margin at the suggested pay. Fill is the share of this store’s scheduled shifts for the role that had someone on them over the last 90 days.', doc.page.margins.left, doc.y, { width: doc.page.width - doc.page.margins.left - doc.page.margins.right });
    doc.end();
  });
}

marketRatesRouter.get('/market-rates/clients/:clientId/brief.pdf', VIEW, async (req, res, next) => {
  try {
    const clientId = z.string().uuid().parse(req.params.clientId);
    const client = await prisma.client.findFirst({ where: { id: clientId, tenantId: tenantIdForWrite(), deletedAt: null }, select: { name: true } });
    if (!client) throw new HttpError(404, 'client_not_found', 'Client not found.');
    const { rows } = await marketRows(req.user!, { clientId });
    const pdf = await renderMarketBrief({ orgName: getBrandingSync().orgName, clientName: client.name, rows, at: new Date() });
    enqueueAudit({ actorUserId: req.user!.id, action: 'market.brief_downloaded', entityType: 'Client', entityId: clientId, metadata: { rows: rows.length } }, 'market.brief');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="market-rates-${client.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.pdf"`);
    res.send(pdf);
  } catch (err) {
    next(err);
  }
});
