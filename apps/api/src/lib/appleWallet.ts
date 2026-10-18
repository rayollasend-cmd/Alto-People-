import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import forge from 'node-forge';
import { env } from '../config/env.js';
import { storeZip } from './storeZip.js';

/**
 * Apple Wallet worker badge (.pkpass).
 *
 * A pass is a ZIP of pass.json, its images, manifest.json (the SHA-1 of
 * every file) and `signature` — a detached PKCS#7 signature of the manifest
 * made with the Pass Type ID certificate, chained to Apple's WWDR
 * intermediate. Without those certificates configured the route answers
 * 503 wallet_not_configured; nothing here invents a signature.
 *
 * Design: the brand's navy with gold labels and white values, the emblem
 * top-left beside the employer's name, the worker's photo as the thumbnail,
 * name as the primary field, then role and site, worker number and
 * employer. The QR is the badge credential (lib/badgeToken.ts) — the kiosk
 * reads it in place of the clock-in number.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const ASSET_DIR = path.resolve(here, '../../assets/wallet');

/** Brand tokens (apps/web/src/index.css, dark): the emblem's navy, gold, white. */
export const PASS_COLORS = {
  background: 'rgb(15, 24, 39)',
  foreground: 'rgb(255, 255, 255)',
  label: 'rgb(217, 185, 103)',
} as const;

export interface BadgePassInput {
  serial: string;
  workerName: string;
  workerNumber: string | null;
  title: string | null;
  siteName: string | null;
  employerName: string;
  badgeToken: string;
  /** PNG bytes, already square — becomes the thumbnail (@1x 90, @2x 180). */
  photo1x?: Buffer | null;
  photo2x?: Buffer | null;
  issuedAt: Date;
  supportUrl: string;
}

export function appleWalletConfigured(): boolean {
  return Boolean(env.PASS_TYPE_ID && env.PASS_TEAM_ID && env.PASS_CERT_PEM && env.PASS_KEY_PEM && env.PASS_WWDR_PEM);
}

/** The setting names a deployment still needs, for the 503 message. */
export function appleWalletMissing(): string[] {
  return (['PASS_TYPE_ID', 'PASS_TEAM_ID', 'PASS_CERT_PEM', 'PASS_KEY_PEM', 'PASS_WWDR_PEM'] as const).filter((k) => !env[k]);
}

const pem = (v: string | undefined) => (v ? v.replace(/\\n/g, '\n') : '');

export function passJson(input: BadgePassInput, ids: { passTypeIdentifier: string; teamIdentifier: string }) {
  return {
    formatVersion: 1,
    passTypeIdentifier: ids.passTypeIdentifier,
    teamIdentifier: ids.teamIdentifier,
    serialNumber: input.serial,
    organizationName: input.employerName,
    description: `${input.employerName} worker badge`,
    logoText: input.employerName,
    backgroundColor: PASS_COLORS.background,
    foregroundColor: PASS_COLORS.foreground,
    labelColor: PASS_COLORS.label,
    sharingProhibited: true,
    barcodes: [
      {
        format: 'PKBarcodeFormatQR',
        message: input.badgeToken,
        messageEncoding: 'iso-8859-1',
        altText: input.workerNumber ? `Clock-in number ${input.workerNumber}` : 'Show at the kiosk',
      },
    ],
    generic: {
      primaryFields: [{ key: 'name', label: 'WORKER', value: input.workerName }],
      secondaryFields: [
        ...(input.title ? [{ key: 'title', label: 'ROLE', value: input.title }] : []),
        ...(input.siteName ? [{ key: 'site', label: 'SITE', value: input.siteName }] : []),
      ],
      auxiliaryFields: [
        ...(input.workerNumber ? [{ key: 'number', label: 'CLOCK-IN NUMBER', value: input.workerNumber }] : []),
        { key: 'issued', label: 'ISSUED', value: input.issuedAt.toISOString(), dateStyle: 'PKDateStyleMedium', timeStyle: 'PKDateStyleNone' },
      ],
      backFields: [
        {
          key: 'how',
          label: 'Clocking in',
          value: 'At the kiosk, choose "Scan badge" and hold this code to the camera — or tap your badge if the kiosk reads NFC. You can always type your clock-in number instead.',
        },
        {
          key: 'lost',
          label: 'Lost your phone or badge?',
          value: 'Tell your supervisor or HR. They reissue your badge and this pass stops working at once.',
        },
        { key: 'help', label: 'Help', value: input.supportUrl, attributedValue: `<a href="${input.supportUrl}">Get help</a>` },
      ],
    },
  };
}

/** Detached PKCS#7 (CMS SignedData) over the manifest bytes. */
export function signManifest(manifest: Buffer): Buffer {
  const cert = forge.pki.certificateFromPem(pem(env.PASS_CERT_PEM));
  const key = env.PASS_KEY_PASSPHRASE
    ? forge.pki.decryptRsaPrivateKey(pem(env.PASS_KEY_PEM), env.PASS_KEY_PASSPHRASE)
    : forge.pki.privateKeyFromPem(pem(env.PASS_KEY_PEM));
  if (!key) throw new Error('PASS_KEY_PEM could not be read (wrong passphrase?)');
  const wwdr = forge.pki.certificateFromPem(pem(env.PASS_WWDR_PEM));
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(manifest.toString('binary'));
  p7.addCertificate(cert);
  p7.addCertificate(wwdr);
  p7.addSigner({
    key,
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256!,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType!, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest! },
      { type: forge.pki.oids.signingTime!, value: new Date() as unknown as string },
    ],
  });
  p7.sign({ detached: true });
  return Buffer.from(forge.asn1.toDer(p7.toAsn1()).getBytes(), 'binary');
}

const sha1 = (b: Buffer) => createHash('sha1').update(b).digest('hex');

/** The .pkpass bytes. Throws when certificates are missing — check appleWalletConfigured() first. */
export async function buildBadgePass(input: BadgePassInput): Promise<Buffer> {
  if (!appleWalletConfigured()) throw new Error('wallet_not_configured');
  const files: Record<string, Buffer> = {
    'pass.json': Buffer.from(JSON.stringify(passJson(input, { passTypeIdentifier: env.PASS_TYPE_ID!, teamIdentifier: env.PASS_TEAM_ID! }))),
  };
  for (const name of ['icon.png', 'icon@2x.png', 'icon@3x.png', 'logo.png', 'logo@2x.png', 'logo@3x.png']) {
    files[name] = await readFile(path.join(ASSET_DIR, name));
  }
  if (input.photo1x) files['thumbnail.png'] = input.photo1x;
  if (input.photo2x) files['thumbnail@2x.png'] = input.photo2x;
  const manifest = Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, sha1(v)]))));
  const signature = signManifest(manifest);
  return storeZip([...Object.entries(files).map(([name, data]) => ({ name, data })), { name: 'manifest.json', data: manifest }, { name: 'signature', data: signature }]);
}
