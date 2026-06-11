import { apiFetch } from './api';

// Kiosk-specific request budget. apiFetch's default 90s ceiling exists for
// admin pages that can afford to wait out a cold backend; a kiosk has a
// line of associates behind it. Past ~8s we'd rather fail fast and let
// the offline punch queue take over (idempotencyKey makes the eventual
// replay safe) than freeze the keypad.
const KIOSK_TIMEOUT_MS = 8_000;

// ----- Admin ------------------------------------------------------------

export interface KioskDevice {
  id: string;
  clientId: string;
  clientName: string;
  /** Phase 131 — physical site under the client. Null on devices
   *  registered before the Location model existed. */
  locationId: string | null;
  locationName: string | null;
  name: string;
  isActive: boolean;
  lastSeenAt: string | null;
  /** ISO timestamp the device token expires. Null = no expiry (legacy
   *  / opt-out devices). After this date punches return 401
   *  device_token_expired and the tablet auto-clears its token. */
  tokenExpiresAt: string | null;
  punchCount: number;
  createdAt: string;
}

export interface KioskPin {
  id: string;
  associateId: string;
  associateName: string;
  associateEmail: string;
  clientId: string;
  clientName: string;
  /** Associate's current worksite (open assignment's Location), or null. */
  locationId: string | null;
  locationName: string | null;
  /** 4-digit number, decrypted server-side. Null on legacy pre-encryption rows. */
  employeeNumber: string | null;
  /** Face-verification consent: null = the kiosk hasn't asked yet. */
  faceConsentStatus: FaceConsentStatus | null;
  createdAt: string;
}

/** Admin consent actions. RESET clears the decision so the kiosk re-asks
 *  at the next punch (the path back in for a changed mind); DECLINE
 *  records a decline and scrubs stored biometrics. There is no admin
 *  GRANT — affirmative consent must come from the associate at the kiosk. */
export const setKioskPinFaceConsent = (id: string, action: 'RESET' | 'DECLINE') =>
  apiFetch<{ ok: true; faceConsentStatus: FaceConsentStatus | null }>(
    `/kiosk-pins/${id}/face-consent`,
    { method: 'POST', body: { action } },
  );

export type KioskPunchReviewStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export type KioskAnomalyKind =
  | 'FACE_MISMATCH'
  | 'IMPOSSIBLE_TRAVEL'
  | 'GEOFENCE'
  | 'FACE_ENROLLMENT';

export interface KioskPunchSummary {
  id: string;
  kioskDeviceId: string;
  deviceName: string;
  associateId: string | null;
  associateName: string | null;
  timeEntryId: string | null;
  action: 'CLOCK_IN' | 'CLOCK_OUT' | 'REJECTED' | 'BREAK_START' | 'BREAK_END';
  hasSelfie: boolean;
  rejectReason: string | null;
  distanceMeters: number | null;
  faceDistance: number | null;
  faceMismatch: boolean | null;
  anomalyKind: KioskAnomalyKind | null;
  anomalyDetail: string | null;
  reviewStatus: KioskPunchReviewStatus | null;
  reviewedAt: string | null;
  reviewedByEmail: string | null;
  reviewNotes: string | null;
  createdAt: string;
}

export interface KioskFaceReferenceSummary {
  id: string;
  associateId: string;
  associateName: string;
  associateEmail: string;
  enrolledByPunchId: string | null;
  enrolledAt: string;
  updatedAt: string;
}

export const listKioskDevices = (clientId?: string) =>
  apiFetch<{ devices: KioskDevice[] }>(
    clientId ? `/kiosk-devices?clientId=${clientId}` : '/kiosk-devices',
  );

export const createKioskDevice = (input: {
  clientId?: string;
  locationId?: string;
  name: string;
}) =>
  apiFetch<{ id: string; deviceToken: string; tokenExpiresAt: string | null }>(
    '/kiosk-devices',
    { method: 'POST', body: input },
  );

/** Rotate the device token. Returns the new plaintext (shown once)
 *  and the new expiry — the previous token stops working immediately. */
export const rotateKioskDevice = (id: string) =>
  apiFetch<{ id: string; deviceToken: string; tokenExpiresAt: string | null }>(
    `/kiosk-devices/${id}/rotate`,
    { method: 'POST', body: {} },
  );

/** Per-device boot config. The tablet fetches this once when it has a
 *  token so it knows whether to bother spinning up geolocation at all —
 *  a kiosk with no geofence skips GPS entirely. The geofence itself is
 *  advisory: punches always succeed; out-of-fence ones are flagged for
 *  admin review server-side. */
export const kioskConfig = (deviceToken: string) =>
  apiFetch<{ geofenceRequired: boolean; tokenExpiresAt: string | null }>(
    '/kiosk/config',
    { method: 'POST', body: { deviceToken } },
  );

/** Attach the deferred selfie + face descriptor to an already-recorded
 *  punch. Called by the tablet in the background after the punch succeeds,
 *  so neither the large selfie upload nor the CPU-heavy descriptor
 *  extraction blocks the associate. Best-effort — both are audit/flag-only
 *  on the server. */
export const kioskAttachFace = (payload: {
  deviceToken: string;
  punchId: string;
  selfie?: string | null;
  faceDescriptor?: number[] | null;
}) =>
  apiFetch<{ ok: true }>(`/kiosk/punch/${payload.punchId}/face`, {
    method: 'POST',
    body: {
      deviceToken: payload.deviceToken,
      selfie: payload.selfie ?? null,
      faceDescriptor: payload.faceDescriptor ?? null,
    },
  });

/** Preflight PIN check. The tablet calls this right after the 4th
 *  digit is entered, BEFORE opening the camera. Throws on invalid
 *  device / token expiry / wrong PIN / break-without-clock-in so the
 *  kiosk doesn't waste the user's time (and doesn't show them
 *  themselves on camera) for a punch that can't succeed. Returns the
 *  associate's first name and the action the punch is predicted to
 *  take, so the camera screen can say "Clocking you in, Maria". */
export type FaceConsentStatus = 'GRANTED' | 'DECLINED';

export const kioskVerifyPin = (payload: {
  deviceToken: string;
  pin: string;
  latitude: number | null;
  longitude: number | null;
  intent?: 'BREAK' | null;
}) =>
  apiFetch<{
    ok: true;
    associateFirstName: string;
    predictedAction: 'CLOCK_IN' | 'CLOCK_OUT' | 'BREAK_START' | 'BREAK_END';
    /** null = never asked → the kiosk shows the one-time consent screen. */
    faceConsent: FaceConsentStatus | null;
  }>('/kiosk/verify-pin', {
    method: 'POST',
    body: payload,
    timeoutMs: KIOSK_TIMEOUT_MS,
  });

/** Record the associate's one-time face-verification consent decision.
 *  Requires a valid PIN (it's their decision, asserted at the keypad). */
export const kioskFaceConsent = (payload: {
  deviceToken: string;
  pin: string;
  consent: boolean;
}) =>
  apiFetch<{ ok: true; status: FaceConsentStatus }>('/kiosk/face-consent', {
    method: 'POST',
    body: payload,
    timeoutMs: KIOSK_TIMEOUT_MS,
  });

export const revokeKioskDevice = (id: string) =>
  apiFetch<{ ok: true }>(`/kiosk-devices/${id}/revoke`, {
    method: 'POST',
    body: {},
  });

export const deleteKioskDevice = (id: string) =>
  apiFetch<void>(`/kiosk-devices/${id}`, { method: 'DELETE' });

/** List employee numbers. Pass a clientId to scope to one client, or omit
 *  it for the cross-client "All clients" view. */
export const listKioskPins = (clientId?: string) =>
  apiFetch<{ pins: KioskPin[] }>(
    clientId ? `/kiosk-pins?clientId=${clientId}` : '/kiosk-pins',
  );

export interface KioskPinHealth {
  total: number;
  healthy: number;
  /** Can't decrypt → PAYOUT_ENCRYPTION_KEY changed. */
  unreadable: number;
  /** Decrypts, but the stored hash ≠ current KIOSK_PIN_SECRET → won't match. */
  wontClockIn: number;
  /** Pre-encryption rows with no plaintext to verify. */
  legacy: number;
  truncated: boolean;
}

/** Health check across kiosk codes — flags codes that won't clock in (PIN
 *  secret drifted) or can't be displayed (encryption key drifted). */
export const kioskPinsHealth = (clientId?: string) =>
  apiFetch<KioskPinHealth>(
    clientId ? `/kiosk-pins/health?clientId=${clientId}` : '/kiosk-pins/health',
  );

export const assignKioskPin = (input: {
  associateId: string;
  clientId: string;
  pin?: string;
}) => apiFetch<{ id: string; employeeNumber: string }>('/kiosk-pins', {
  method: 'POST',
  body: input,
});

export const deleteKioskPin = (id: string) =>
  apiFetch<void>(`/kiosk-pins/${id}`, { method: 'DELETE' });

/** Email an associate their kiosk employee number. */
export const emailKioskPin = (id: string) =>
  apiFetch<{ ok: true; email: string }>(`/kiosk-pins/${id}/email`, {
    method: 'POST',
    body: {},
  });

/** Bulk-email selected associates their employee numbers. Returns how many
 *  were queued and how many were skipped (no address / legacy number). */
export const emailKioskPinsBulk = (ids: string[]) =>
  apiFetch<{ queued: number; skipped: number }>('/kiosk-pins/email', {
    method: 'POST',
    body: { ids },
  });

export interface KioskPinDiagnosis {
  employeeNumber: string;
  matchedPin: {
    id: string;
    pinClientId: string;
    pinClientName: string | null;
    associateId: string;
    associateName: string | null;
    associateEmail: string | null;
    currentEmployeeNumber: string | null;
  } | null;
  currentAssignment: {
    clientId: string;
    clientName: string;
    locationId: string;
    locationName: string | null;
  } | null;
  openTimeEntry: {
    id: string;
    clockInAt: string;
    clientId: string | null;
    locationId: string | null;
  } | null;
  clientsMatch?: boolean;
  devicesAtPinClient?: {
    id: string;
    name: string;
    locationId: string | null;
    lastSeenAt: string | null;
  }[];
  candidates?: {
    associateId: string;
    associateName: string;
    associateEmail: string;
  }[];
  diagnosis: string;
}

export const diagnoseKioskPin = (params: {
  employeeNumber?: string;
  associate?: string;
}) => {
  const q = new URLSearchParams();
  if (params.employeeNumber) q.set('employeeNumber', params.employeeNumber);
  if (params.associate) q.set('associate', params.associate);
  return apiFetch<KioskPinDiagnosis>(
    `/kiosk-pins/diagnose?${q.toString()}`,
  );
};

export const listKioskPunches = (params?: {
  associateId?: string;
  deviceId?: string;
  reviewStatus?: KioskPunchReviewStatus;
  action?: KioskPunchSummary['action'];
  anomaliesOnly?: boolean;
  /** ISO timestamps bounding createdAt. */
  from?: string;
  to?: string;
  sort?: 'newest' | 'oldest';
  /** Id of the previous page's last row, for cursor pagination. */
  cursor?: string;
  limit?: number;
}) => {
  const q = new URLSearchParams();
  if (params?.associateId) q.set('associateId', params.associateId);
  if (params?.deviceId) q.set('deviceId', params.deviceId);
  if (params?.reviewStatus) q.set('reviewStatus', params.reviewStatus);
  if (params?.action) q.set('action', params.action);
  if (params?.anomaliesOnly) q.set('anomaliesOnly', 'true');
  if (params?.from) q.set('from', params.from);
  if (params?.to) q.set('to', params.to);
  if (params?.sort) q.set('sort', params.sort);
  if (params?.cursor) q.set('cursor', params.cursor);
  if (params?.limit != null) q.set('limit', String(params.limit));
  const suffix = q.toString() ? `?${q.toString()}` : '';
  return apiFetch<{ punches: KioskPunchSummary[]; nextCursor: string | null }>(
    `/kiosk-punches${suffix}`,
  );
};

export const reviewKioskPunch = (
  id: string,
  decision: 'APPROVED' | 'REJECTED',
  notes?: string,
) =>
  apiFetch<{ ok: true }>(`/kiosk-punches/${id}/review`, {
    method: 'POST',
    body: { decision, notes },
  });

export const reviewKioskPunchesBulk = (
  ids: string[],
  decision: 'APPROVED' | 'REJECTED',
  notes?: string,
) =>
  apiFetch<{
    reviewed: number;
    skipped: { id: string; reason: 'not_found' | 'not_pending' }[];
  }>('/kiosk-punches/review', {
    method: 'POST',
    body: { ids, decision, notes },
  });

// ----- Face references (Phase 101) ---------------------------------------

export const listKioskFaceReferences = () =>
  apiFetch<{ references: KioskFaceReferenceSummary[] }>(
    '/kiosk-face-references',
  );

export const resetKioskFaceReference = (associateId: string) =>
  apiFetch<void>(`/kiosk-face-references/${associateId}`, { method: 'DELETE' });

// ----- Public kiosk endpoint ---------------------------------------------

export type KioskPunchAction =
  | 'CLOCK_IN'
  | 'CLOCK_OUT'
  | 'BREAK_START'
  | 'BREAK_END';

export interface KioskPunchResult {
  action: KioskPunchAction;
  associateName: string;
  at: string;
  punchId: string;
}

export const kioskPunch = (input: {
  deviceToken: string;
  pin: string;
  selfie: string | null;
  latitude?: number | null;
  longitude?: number | null;
  faceDescriptor?: number[] | null;
  idempotencyKey?: string | null;
  clientPunchedAt?: string | null;
  intent?: 'BREAK' | null;
}) =>
  apiFetch<KioskPunchResult>('/kiosk/punch', {
    method: 'POST',
    body: input,
    timeoutMs: KIOSK_TIMEOUT_MS,
    // The public kiosk endpoint doesn't need cookies and we don't want
    // to send any session that might be lurking on the kiosk's browser.
    // apiFetch's `credentials: 'include'` default is fine here — the
    // server doesn't read cookies on this route.
  });
