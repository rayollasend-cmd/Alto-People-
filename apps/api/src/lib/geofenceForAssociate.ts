import type { PrismaClient } from '@prisma/client';
import type { GeofenceConfig } from './geo.js';

/**
 * Resolve the geofence that should govern an associate's clock-in /
 * clock-out. Phase 131 — prefers the open AssociateAssignment's
 * Location (each physical site has its own geofence) and falls back
 * to the legacy Client geofence for associates not yet placed at a
 * Location. Returns the resolved clientId + locationId alongside the
 * geofence so callers can stamp them onto TimeEntry rows for history.
 */
export async function resolveAssociateGeofence(
  prisma: PrismaClient,
  associateId: string,
  clientIdFallback: string | null,
): Promise<{
  geofence: GeofenceConfig;
  clientId: string | null;
  locationId: string | null;
}> {
  const assignment = await prisma.associateAssignment.findFirst({
    where: { associateId, endedAt: null },
    select: {
      locationId: true,
      location: {
        select: {
          clientId: true,
          latitude: true,
          longitude: true,
          geofenceRadiusMeters: true,
        },
      },
    },
  });
  if (assignment) {
    return {
      geofence: {
        latitude: assignment.location.latitude
          ? Number(assignment.location.latitude)
          : null,
        longitude: assignment.location.longitude
          ? Number(assignment.location.longitude)
          : null,
        radiusMeters: assignment.location.geofenceRadiusMeters,
      },
      clientId: assignment.location.clientId,
      locationId: assignment.locationId,
    };
  }
  if (!clientIdFallback) {
    return {
      geofence: { latitude: null, longitude: null, radiusMeters: null },
      clientId: null,
      locationId: null,
    };
  }
  // Phase 131 — Client.geofence was dropped. Use the first active
  // Location under the client as the fallback; this matches the
  // pre-drop behavior because the schema migration backfilled each
  // Client's old geofence into a default Location 1:1. If no Location
  // exists (or none has a geofence set), enforcement falls back to
  // "no fence" — same as the old all-NULL Client state.
  const fallback = await prisma.location.findFirst({
    where: { clientId: clientIdFallback, deletedAt: null, isActive: true },
    orderBy: { createdAt: 'asc' },
    select: { id: true, latitude: true, longitude: true, geofenceRadiusMeters: true },
  });
  return {
    geofence: {
      latitude: fallback?.latitude ? Number(fallback.latitude) : null,
      longitude: fallback?.longitude ? Number(fallback.longitude) : null,
      radiusMeters: fallback?.geofenceRadiusMeters ?? null,
    },
    clientId: clientIdFallback,
    locationId: fallback?.id ?? null,
  };
}
