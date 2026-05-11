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
  const client = await prisma.client.findUnique({
    where: { id: clientIdFallback },
    select: { latitude: true, longitude: true, geofenceRadiusMeters: true },
  });
  return {
    geofence: {
      latitude: client?.latitude ? Number(client.latitude) : null,
      longitude: client?.longitude ? Number(client.longitude) : null,
      radiusMeters: client?.geofenceRadiusMeters ?? null,
    },
    clientId: clientIdFallback,
    locationId: null,
  };
}
