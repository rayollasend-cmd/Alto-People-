import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { tenantIdForWrite } from './tenant.js';
import type { WaLang } from './whatsappContent.js';

/**
 * The help center, as the assistant reads it (HR pack 2026-10).
 *
 *   Postgres full-text search over the PUBLISHED articles of this tenant
 *   (title weighted above body), company-wide ones and the person's own
 *   client's. The assistant gets the top hits with an excerpt and the link;
 *   the model quotes from them, the rules path hands back the best one.
 *   Nothing here is written: a search is a read of what HR published.
 */

export interface HelpHit {
  id: string;
  slug: string;
  title: string;
  category: string;
  excerpt: string;
  rank: number;
}

const EXCERPT_CHARS = 420;

function excerptFor(body: string, query: string): string {
  const text = body.replace(/\s+/g, ' ').trim();
  const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
  let at = -1;
  for (const w of words) {
    const i = text.toLowerCase().indexOf(w);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  const start = Math.max(0, at - 80);
  const slice = text.slice(start, start + EXCERPT_CHARS);
  return (start > 0 ? '…' : '') + slice + (start + EXCERPT_CHARS < text.length ? '…' : '');
}

export async function searchHelpCenter(
  query: string,
  opts: { clientId?: string | null; limit?: number } = {},
  db: PrismaClient = defaultPrisma,
): Promise<HelpHit[]> {
  const q = query.trim().slice(0, 200);
  if (!q) return [];
  const limit = Math.min(opts.limit ?? 3, 5);
  const tenantId = tenantIdForWrite();
  const clientFilter = opts.clientId ? Prisma.sql`AND ("clientId" IS NULL OR "clientId" = ${opts.clientId}::uuid)` : Prisma.sql`AND "clientId" IS NULL`;
  // Any meaningful word may match (OR), ranked by how many and where: a
  // question's "how/what/do I" must not be required of the article.
  // Letters and digits only, so the tsquery can never be malformed.
  const terms = [...new Set((q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 2))].slice(0, 12);
  if (terms.length === 0) return [];
  const tsq = terms.join(' | ');
  const doc = Prisma.sql`(setweight(to_tsvector('english', title), 'A') || setweight(to_tsvector('english', body), 'B'))`;
  const rows = await db.$queryRaw<Array<{ id: string; slug: string; title: string; category: string; body: string; rank: number }>>(Prisma.sql`
    SELECT id, slug, title, category, body, ts_rank(${doc}, to_tsquery('english', ${tsq})) AS rank
    FROM "KbArticle"
    WHERE status = 'PUBLISHED'
      AND "tenantId" = ${tenantId}::uuid
      ${clientFilter}
      AND ${doc} @@ to_tsquery('english', ${tsq})
    ORDER BY rank DESC, views DESC
    LIMIT ${limit}
  `);
  return rows.map((r) => ({ id: r.id, slug: r.slug, title: r.title, category: r.category, excerpt: excerptFor(r.body, q), rank: Number(r.rank) }));
}

/** The help center's answer in the person's language: the best article, quoted, with the link. */
export function helpCenterReply(lang: WaLang, hits: HelpHit[]): { reply: string; linkUrl: string | null } {
  if (hits.length === 0) {
    return {
      reply:
        lang === 'es'
          ? 'No encontré nada sobre eso en el centro de ayuda.'
          : lang === 'tr'
            ? 'Yardım merkezinde bununla ilgili bir şey bulamadım.'
            : "I couldn't find anything about that in the help center.",
      linkUrl: null,
    };
  }
  const top = hits[0]!;
  const lead = lang === 'es' ? `Según «${top.title}»:` : lang === 'tr' ? `«${top.title}» şöyle diyor:` : `From "${top.title}":`;
  const more = hits.length > 1 ? (lang === 'es' ? ` También: ${hits.slice(1).map((h) => h.title).join(', ')}.` : lang === 'tr' ? ` Ayrıca: ${hits.slice(1).map((h) => h.title).join(', ')}.` : ` See also: ${hits.slice(1).map((h) => h.title).join(', ')}.`) : '';
  return { reply: `${lead} ${top.excerpt}${more}`, linkUrl: `/help-center?article=${top.slug}` };
}

/** What the model reads: every hit with its excerpt and link, or a plain "nothing". */
export function helpCenterToolText(hits: HelpHit[]): string {
  if (hits.length === 0) return 'No published help-center article matches. Say so; do not guess a policy.';
  return hits.map((h, i) => `${i + 1}. "${h.title}" (${h.category}) — link /help-center?article=${h.slug}\n${h.excerpt}`).join('\n\n');
}
