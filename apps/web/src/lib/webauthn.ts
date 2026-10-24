// The ceremony library loads when a passkey is used, not with the sign-in
// page every visitor opens.
import type { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import type { AuthUser } from '@alto-people/shared';
import { apiFetch } from './api';

/**
 * Passkey (WebAuthn) client — Face ID / Touch ID / Windows Hello.
 *
 * Registration: authed user in Settings → server mints options + a
 * one-shot challenge id → authenticator ceremony → server verifies and
 * stores the public key.
 *
 * Sign-in: email → server returns assertion options (a real challenge
 * even for unknown emails, so nothing enumerates) → authenticator signs
 * → server verifies and mints the session cookie. Passkeys satisfy MFA
 * on their own (possession + biometric), so there's no TOTP leg.
 */

export interface PasskeySummary {
  id: string;
  deviceName: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export function passkeysSupported(): boolean {
  // What @simplewebauthn's browserSupportsWebAuthn() checks.
  return typeof window !== 'undefined' && typeof window.PublicKeyCredential === 'function';
}

export async function listPasskeys(): Promise<PasskeySummary[]> {
  const res = await apiFetch<{ credentials: PasskeySummary[] }>(
    '/auth/webauthn/credentials',
  );
  return res.credentials;
}

export async function removePasskey(id: string): Promise<void> {
  await apiFetch<void>(`/auth/webauthn/credentials/${id}`, { method: 'DELETE' });
}

/** Full registration ceremony. Throws on user-cancel or server rejection. */
export async function registerPasskey(deviceName?: string): Promise<PasskeySummary> {
  const { challengeId, options } = await apiFetch<{
    challengeId: string;
    options: Parameters<typeof startRegistration>[0]['optionsJSON'];
  }>('/auth/webauthn/register/options', { method: 'POST', body: {} });
  const { startRegistration: register } = await import('@simplewebauthn/browser');
  const response = await register({ optionsJSON: options });
  return apiFetch<PasskeySummary>('/auth/webauthn/register/verify', {
    method: 'POST',
    body: { challengeId, response, ...(deviceName ? { deviceName } : {}) },
  });
}

/** Full sign-in ceremony. Resolves with the signed-in user (session cookie set). */
export async function signInWithPasskey(email: string): Promise<AuthUser> {
  const { challengeId, options } = await apiFetch<{
    challengeId: string;
    options: Parameters<typeof startAuthentication>[0]['optionsJSON'];
  }>('/auth/webauthn/login/options', { method: 'POST', body: { email } });
  const { startAuthentication: authenticate } = await import('@simplewebauthn/browser');
  const response = await authenticate({ optionsJSON: options });
  const res = await apiFetch<{ user: AuthUser }>('/auth/webauthn/login/verify', {
    method: 'POST',
    body: { challengeId, response },
  });
  return res.user;
}
