import { apiFetch } from './api';

/** The credential wallet (routes/wallet.ts). */

export interface WalletItem {
  kind: 'qualification' | 'training' | 'document';
  id: string;
  title: string;
  issuer: string | null;
  earnedAt: string | null;
  expiresAt: string | null;
  state: 'valid' | 'expiring' | 'expired';
}

export interface Wallet {
  person: { name: string; since: string | null };
  items: WalletItem[];
}

export function getMyWallet(): Promise<Wallet> {
  return apiFetch('/me/wallet');
}

export function shareMyWallet(days: number): Promise<{ token: string; path: string; expiresAt: string }> {
  return apiFetch('/me/wallet/share', { method: 'POST', body: { days } });
}

/** No login: the token is the key. */
export function getPublicWallet(token: string): Promise<Wallet & { expiresAt: string | null }> {
  return apiFetch(`/wallet/public/${encodeURIComponent(token)}`);
}

/* ----- The worker badge (routes/nativeApp.ts) ------------------------------ */

export interface WorkerBadge {
  workerName: string;
  workerNumber: string | null;
  title: string | null;
  siteName: string | null;
  employerName: string;
  /** The value the QR / NFC badge carries — the kiosk accepts it for the number. */
  badgeToken: string;
  badgeVersion: number;
  photoUrl: string | null;
  apple: { available: boolean; missing: string[] };
  google: { available: boolean; missing: string[] };
}

export function getWorkerBadge(): Promise<WorkerBadge> {
  return apiFetch('/me/wallet/badge');
}

/** A five-minute link to the Apple Wallet pass (opened in Safari / the system browser). */
export function getAppleWalletLink(): Promise<{ url: string }> {
  return apiFetch('/me/wallet/badge/apple-link', { method: 'POST' });
}

export function getGoogleWalletLink(): Promise<{ url: string }> {
  return apiFetch('/me/wallet/badge/google');
}
