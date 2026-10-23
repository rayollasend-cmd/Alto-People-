import { Router, type Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { tenantRateKey } from '../middleware/rateLimit.js';
import { addressTypeahead, searchAddresses, type GeoPoint } from '../lib/geocode.js';

/**
 * Address suggestions for every address form in the app — a home address
 * on the profile and the onboarding task, a store or site, a client's
 * billing address, an employer, a vendor, a W-9.
 *
 *   GET /geo/address-suggest?q=<what they've typed>&near=<lat>,<lng>
 *
 * Signed-in staff and associates. A client-portal account is the
 * customer's, not ours, and has no address form to fill; a system
 * integration isn't a person typing.
 *
 * Tenant-neutral: the answer is the provider's, never a row of ours, so
 * there is nothing to scope but the caller — and the caller is held to 60
 * lookups a minute, because each one is a billed Mapbox request and a
 * human typing (debounced) sends a handful per address.
 *
 * Only a provider built for type-ahead is asked (Mapbox, when MAPBOX_TOKEN
 * is set). Without one the answer is { available: false, reason } and the
 * form stays plain fields: Nominatim's usage policy forbids autocomplete,
 * and 'off' (dev without a token, the tests) has nothing to ask.
 *
 * The query text is never logged: it is someone's home address.
 */
export const geoRouter = Router();

const SUGGEST_LIMIT = process.env.NODE_ENV === 'test' ? 100_000 : 60;
let limitForTests: number | null = null;

/** Tests: hold the per-user budget to `n` a minute (null restores it). */
export function setAddressSuggestLimitForTests(n: number | null): void {
  limitForTests = n;
}

const suggestLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: () => limitForTests ?? SUGGEST_LIMIT,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req: Request) => tenantRateKey(req, `geo-suggest:user:${req.user!.id}`),
  message: {
    error: {
      code: 'rate_limited',
      message: 'Too many address lookups in the last minute. Type the address in, or try again shortly.',
    },
  },
});

const NOT_A_TYPIST = new Set(['CLIENT_PORTAL', 'LIVE_ASN']);

function staffOrAssociate(req: Request, _res: unknown, next: (err?: unknown) => void): void {
  if (NOT_A_TYPIST.has(req.user!.role)) {
    next(new HttpError(403, 'forbidden', 'Address suggestions are for staff and associates.'));
    return;
  }
  next();
}

const SuggestQuery = z.object({
  q: z.string().trim().min(1).max(160),
  near: z
    .string()
    .regex(/^-?\d{1,3}(\.\d+)?,-?\d{1,3}(\.\d+)?$/, 'near is "lat,lng"')
    .transform((s) => {
      const [lat, lng] = s.split(',').map(Number) as [number, number];
      return { lat, lng };
    })
    .refine((p) => Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180, 'near is out of range')
    .optional(),
});

/**
 * An associate typing their home address most likely lives near the store
 * they work at: their open assignment's pin, when it has one. Their own
 * record only; staff get no default (their forms pass `near` themselves).
 */
async function homeStore(associateId: string | null): Promise<GeoPoint | null> {
  if (!associateId) return null;
  const a = await prisma.associateAssignment.findFirst({
    where: { associateId, endedAt: null },
    orderBy: { startedAt: 'desc' },
    select: { location: { select: { latitude: true, longitude: true } } },
  });
  const loc = a?.location;
  return loc?.latitude != null && loc.longitude != null ? { lat: Number(loc.latitude), lng: Number(loc.longitude) } : null;
}

geoRouter.get('/address-suggest', staffOrAssociate, suggestLimiter, async (req, res) => {
  const q = SuggestQuery.parse(req.query);
  const typeahead = addressTypeahead();
  if (!typeahead.available) {
    res.json({ available: false, reason: typeahead.reason, results: [] });
    return;
  }
  const near = q.near ?? (await homeStore(req.user!.associateId));
  const found = await searchAddresses(q.q, near, { typeaheadOnly: true });
  res.json({
    available: true,
    provider: typeahead.provider,
    // The provider was down or busy: "no suggestions right now", not "no such address".
    outage: found.unavailable,
    results: found.results.map((r) => ({
      label: r.label,
      // Every suggestion is in the US: the country on the end is noise on a one-line address.
      address: r.address.replace(/,\s*United States( of America)?$/i, ''),
      line1: r.parts.line1,
      line2: r.parts.line2,
      city: r.parts.city,
      state: r.parts.state,
      zip: r.parts.zip,
      county: r.parts.county,
      lat: r.lat,
      lng: r.lng,
      precision: r.precision,
    })),
  });
});
