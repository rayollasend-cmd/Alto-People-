import { apiFetch } from './api';

/** Signed credentials (routes/credentials.ts): W3C Verifiable Credentials, Open Badges 3.0. */

export interface SignedCredential {
  subjectType: 'qualification' | 'training';
  subjectId: string;
  title: string;
  credential: Record<string, unknown>;
}

export function getMyCredentials(): Promise<{ credentials: SignedCredential[] }> {
  return apiFetch('/me/wallet/credentials');
}

export function createCredentialOffer(): Promise<{ url: string; expiresAt: string }> {
  return apiFetch('/me/wallet/credentials/offer', { method: 'POST', body: {} });
}

export type CheckState = 'pass' | 'fail' | 'warn';
export interface VerifyResult {
  verdict: 'valid' | 'revoked' | 'expired' | 'not_yet_valid' | 'invalid' | 'unknown_issuer';
  checks: Array<{ key: 'format' | 'issuer' | 'signature' | 'status' | 'dates'; state: CheckState; label: string }>;
  credential: { title: string | null; holder: string | null; issuer: string | null; issuedAt: string | null; expiresAt: string | null; kind: string | null } | null;
}

/** No login: anyone can check a credential issued here. */
export function verifyCredential(credential: unknown): Promise<VerifyResult> {
  return apiFetch('/credentials/verify', { method: 'POST', body: { credential } });
}

/** Save a credential (or several) as a JSON file. */
export function saveCredentialFile(name: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/vc+ld+json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'credential'}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
