import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { ALTO_TENANT_ID, tenantIdForWrite } from './tenant.js';

/**
 * Org branding cache, per tenant (Phase: settings audit row #8; per
 * tenant since the assistant's name became each tenant's own).
 *
 * One OrgSetting row per tenant, keyed by tenantId (unique). Alto HR keeps
 * the historical id 'singleton'; any other tenant's row takes an id
 * derived from its tenant id (orgSettingIdFor). The cache is a map keyed
 * by tenantId: each entry is read on first access, refreshed every 5 min,
 * and re-read on demand after a PATCH so HR sees their change at once.
 *
 * Templates and replies read synchronously via `getBrandingSync()`, which
 * defaults to the tenant in context (request, job or script). Until a
 * tenant's first load resolves, callers see the hard defaults
 * (`DEFAULT_BRANDING`), and the first sight of a tenant starts its load.
 */

export interface BrandingSnapshot {
  orgName: string;
  /** What this tenant's team calls the assistant. */
  assistantName: string;
  /** Brief 1A-2 company settings, cached here with the rest of OrgSetting. */
  activeWindowDays: number;
  weekStartsOn: number;
  timezone: string;
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
  assistantName: 'Hugo',
  activeWindowDays: 14,
  weekStartsOn: 6,
  timezone: 'America/New_York',
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

interface Entry {
  snapshot: BrandingSnapshot;
  lastLoadedAt: number;
  inflight: Promise<BrandingSnapshot> | null;
}

const entries = new Map<string, Entry>();
// Bumped by the test reset: a read that started before a reset is discarded when it lands.
let generation = 0;

function entryFor(tenantId: string): Entry {
  let e = entries.get(tenantId);
  if (!e) {
    e = { snapshot: DEFAULT_BRANDING, lastLoadedAt: 0, inflight: null };
    entries.set(tenantId, e);
  }
  return e;
}

/** The OrgSetting row id for a tenant: Alto HR's historical 'singleton', else 16 characters of the tenant id (the column is VarChar(16)). */
export function orgSettingIdFor(tenantId: string): string {
  return tenantId === ALTO_TENANT_ID ? 'singleton' : tenantId.replace(/-/g, '').slice(0, 16);
}

/** The cached snapshot for the tenant (the one in context by default); the defaults until its first load lands, which this call starts. */
export function getBrandingSync(tenantId: string = tenantIdForWrite()): BrandingSnapshot {
  const e = entries.get(tenantId);
  if (!e) {
    void refreshBranding(defaultPrisma, tenantId);
    return DEFAULT_BRANDING;
  }
  if (!e.inflight && Date.now() - e.lastLoadedAt >= REFRESH_INTERVAL_MS) void refreshBranding(defaultPrisma, tenantId);
  return e.snapshot;
}

/** Re-reads the tenant's row now. A refresh asked for while one is in flight waits for it and reads again, so a write just made is never missed. */
export async function refreshBranding(prisma: PrismaClient, tenantId: string = tenantIdForWrite()): Promise<BrandingSnapshot> {
  const e = entryFor(tenantId);
  if (e.inflight) await e.inflight.catch(() => undefined);
  const gen = generation;
  e.inflight = (async () => {
    try {
      const row = await prisma.orgSetting.findUnique({ where: { tenantId } });
      let snapshot: BrandingSnapshot;
      if (!row) {
        // No row yet: the defaults, under the tenant's own name when it is not Alto HR.
        const tenant = tenantId === ALTO_TENANT_ID ? null : await prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }).catch(() => null);
        snapshot = tenant ? { ...DEFAULT_BRANDING, orgName: tenant.name } : DEFAULT_BRANDING;
      } else {
        const logoDataUri =
          row.logoBytes && row.logoContentType
            ? `data:${row.logoContentType};base64,${Buffer.from(row.logoBytes).toString('base64')}`
            : null;
        snapshot = {
          orgName: row.orgName,
          assistantName: row.assistantName,
          activeWindowDays: row.activeWindowDays,
          weekStartsOn: row.weekStartsOn,
          timezone: row.timezone,
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
      if (gen !== generation) return snapshot;
      const live = entryFor(tenantId);
      live.snapshot = snapshot;
      live.lastLoadedAt = Date.now();
      return snapshot;
    } catch (err) {
      console.warn('[branding] refresh failed, keeping previous cache', err);
      return entryFor(tenantId).snapshot;
    } finally {
      if (gen === generation) entryFor(tenantId).inflight = null;
    }
  })();
  return e.inflight;
}

/** The tenant's snapshot, read now when it was never read or is older than the refresh interval. */
export async function ensureBrandingLoaded(prisma: PrismaClient, tenantId: string = tenantIdForWrite()): Promise<BrandingSnapshot> {
  const e = entries.get(tenantId);
  if (e && e.lastLoadedAt > 0 && Date.now() - e.lastLoadedAt < REFRESH_INTERVAL_MS) return e.snapshot;
  return refreshBranding(prisma, tenantId);
}

/** Forgets one tenant's snapshot (or every tenant's), so the next read goes to the row. */
export function invalidateBranding(tenantId?: string): void {
  if (tenantId) entries.delete(tenantId);
  else entries.clear();
}

// Test-only — wipes the cache so a fresh row is read on next call. The
// integration tests truncate OrgSetting between cases and need this to
// avoid stale data leaking between tests. A read in flight at the reset
// does not land.
export function __resetBrandingCacheForTests(): void {
  generation += 1;
  entries.clear();
}
