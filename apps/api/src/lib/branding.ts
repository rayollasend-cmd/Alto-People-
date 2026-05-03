import type { PrismaClient } from '@prisma/client';

/**
 * Org-wide branding cache (Phase: settings audit row #8).
 *
 * The OrgSetting row is read once on first access, refreshed every 5 min,
 * and re-read on demand after a PATCH so HR sees their change immediately.
 * Templates read synchronously via `getBrandingSync()` because the email
 * templates themselves are sync — async loading would cascade into every
 * caller. Until the first load resolves, callers see the hard defaults
 * (`DEFAULT_BRANDING`), which match what the codebase has always used.
 */

export interface BrandingSnapshot {
  orgName: string;
  senderName: string | null;
  supportEmail: string | null;
  primaryColor: string | null;
  hasLogo: boolean;
  logoContentType: string | null;
  logoUpdatedAt: Date | null;
  // Embedded data: URI for inline use in HTML emails. Built once on load
  // so the per-email render path doesn't have to re-base64 the bytes.
  logoDataUri: string | null;
  updatedAt: Date | null;
}

export const DEFAULT_BRANDING: BrandingSnapshot = {
  orgName: 'Alto HR',
  senderName: null,
  supportEmail: null,
  primaryColor: null,
  hasLogo: false,
  logoContentType: null,
  logoUpdatedAt: null,
  logoDataUri: null,
  updatedAt: null,
};

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

let cached: BrandingSnapshot = DEFAULT_BRANDING;
let lastLoadedAt = 0;
let inflight: Promise<BrandingSnapshot> | null = null;

export function getBrandingSync(): BrandingSnapshot {
  return cached;
}

export async function refreshBranding(prisma: PrismaClient): Promise<BrandingSnapshot> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const row = await prisma.orgSetting.findUnique({ where: { id: 'singleton' } });
      if (!row) {
        cached = DEFAULT_BRANDING;
      } else {
        const logoDataUri =
          row.logoBytes && row.logoContentType
            ? `data:${row.logoContentType};base64,${Buffer.from(row.logoBytes).toString('base64')}`
            : null;
        cached = {
          orgName: row.orgName,
          senderName: row.senderName,
          supportEmail: row.supportEmail,
          primaryColor: row.primaryColor,
          hasLogo: !!row.logoBytes,
          logoContentType: row.logoContentType,
          logoUpdatedAt: row.logoUpdatedAt,
          logoDataUri,
          updatedAt: row.updatedAt,
        };
      }
      lastLoadedAt = Date.now();
      return cached;
    } catch (err) {
      console.warn('[branding] refresh failed, keeping previous cache', err);
      return cached;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export async function ensureBrandingLoaded(prisma: PrismaClient): Promise<BrandingSnapshot> {
  if (lastLoadedAt > 0 && Date.now() - lastLoadedAt < REFRESH_INTERVAL_MS) {
    return cached;
  }
  return refreshBranding(prisma);
}

// Test-only — wipes the cache so a fresh row is read on next call. The
// integration tests truncate OrgSetting between cases and need this to
// avoid stale data leaking between tests.
export function __resetBrandingCacheForTests(): void {
  cached = DEFAULT_BRANDING;
  lastLoadedAt = 0;
  inflight = null;
}
