import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

/**
 * Google Wallet worker badge — a Generic pass delivered as a signed
 * "Save to Google Wallet" link. The JWT carries both the class (the badge
 * design, shared) and the object (this worker's badge); Google creates or
 * updates them when the link is opened. No API call from our side.
 *
 * Same design as the Apple pass: brand navy, the emblem, name as the
 * header, role / site / clock-in number as rows, and the badge credential
 * as the QR the kiosk reads.
 */

export const GOOGLE_BACKGROUND = '#0f1827';

export interface GoogleBadgeInput {
  objectSuffix: string;
  workerName: string;
  workerNumber: string | null;
  title: string | null;
  siteName: string | null;
  employerName: string;
  badgeToken: string;
  logoUrl: string;
  origins: string[];
}

export function googleWalletConfigured(): boolean {
  return Boolean(env.GOOGLE_WALLET_ISSUER_ID && env.GOOGLE_WALLET_CLIENT_EMAIL && env.GOOGLE_WALLET_PRIVATE_KEY);
}

export function googleWalletMissing(): string[] {
  return (['GOOGLE_WALLET_ISSUER_ID', 'GOOGLE_WALLET_CLIENT_EMAIL', 'GOOGLE_WALLET_PRIVATE_KEY'] as const).filter((k) => !env[k]);
}

const text = (value: string) => ({ defaultValue: { language: 'en-US', value } });

/** The JWT claims (exported for tests). */
export function googleBadgeClaims(input: GoogleBadgeInput) {
  const issuer = env.GOOGLE_WALLET_ISSUER_ID!;
  const classId = `${issuer}.alto_worker_badge_v1`;
  // Object ids: issuer + a suffix of letters, digits, '.', '_' or '-'.
  const objectId = `${issuer}.${input.objectSuffix.replace(/[^\w.-]/g, '_')}`;
  return {
    iss: env.GOOGLE_WALLET_CLIENT_EMAIL,
    aud: 'google',
    typ: 'savetowallet',
    origins: input.origins,
    payload: {
      genericClasses: [{ id: classId }],
      genericObjects: [
        {
          id: objectId,
          classId,
          state: 'ACTIVE',
          hexBackgroundColor: GOOGLE_BACKGROUND,
          logo: { sourceUri: { uri: input.logoUrl }, contentDescription: text(`${input.employerName} logo`) },
          cardTitle: text(input.employerName),
          subheader: text(input.title ?? 'Worker'),
          header: text(input.workerName),
          textModulesData: [
            ...(input.siteName ? [{ id: 'site', header: 'Site', body: input.siteName }] : []),
            ...(input.workerNumber ? [{ id: 'number', header: 'Clock-in number', body: input.workerNumber }] : []),
          ],
          barcode: {
            type: 'QR_CODE',
            value: input.badgeToken,
            alternateText: input.workerNumber ? `Clock-in number ${input.workerNumber}` : 'Show at the kiosk',
          },
        },
      ],
    },
  };
}

/** "Save to Google Wallet" URL. Throws when unconfigured — check googleWalletConfigured() first. */
export function googleSaveUrl(input: GoogleBadgeInput): string {
  if (!googleWalletConfigured()) throw new Error('wallet_not_configured');
  const token = jwt.sign(googleBadgeClaims(input), env.GOOGLE_WALLET_PRIVATE_KEY!.replace(/\\n/g, '\n'), { algorithm: 'RS256' });
  return `https://pay.google.com/gp/v/save/${token}`;
}
