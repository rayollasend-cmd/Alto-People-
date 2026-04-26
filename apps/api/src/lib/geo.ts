/**
 * Haversine great-circle distance between two lat/lng points, in meters.
 * Mean Earth radius = 6 371 008.8 m. Accurate to ~0.5 % for distances
 * under a few hundred km — far more than enough for clock-in geofences.
 */
const R_METERS = 6_371_008.8;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function haversineMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h =
    sinDLat * sinDLat +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinDLng * sinDLng;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return R_METERS * c;
}

export interface GeofenceConfig {
  latitude: number | null;
  longitude: number | null;
  radiusMeters: number | null;
}

export interface GeofenceCheck {
  /** null = no geofence configured for this client; the check is a no-op. */
  inside: boolean | null;
  distanceMeters: number | null;
}

export function checkGeofence(
  config: GeofenceConfig,
  point: { lat: number; lng: number } | null
): GeofenceCheck {
  if (
    config.latitude == null ||
    config.longitude == null ||
    config.radiusMeters == null
  ) {
    return { inside: null, distanceMeters: null };
  }
  if (!point) {
    // Geofence enforced but no point provided — treat as a violation.
    return { inside: false, distanceMeters: null };
  }
  const distance = haversineMeters(
    { lat: config.latitude, lng: config.longitude },
    point
  );
  return { inside: distance <= config.radiusMeters, distanceMeters: distance };
}
