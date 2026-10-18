import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign as edSign, verify as edVerify, type KeyObject } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { Prisma, PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';
import { decryptBytes, encryptBytes } from './crypto.js';
import { ALTO_TENANT_ID } from './tenant.js';

/**
 * Standards-based credentials: what a worker has earned, signed so anyone
 * can check it without calling us.
 *
 *   format     W3C Verifiable Credentials Data Model 2.0 (JSON-LD). A
 *              qualification, certification or completed training is an
 *              Open Badges 3.0 `OpenBadgeCredential`.
 *   proof      W3C Data Integrity, cryptosuite `eddsa-jcs-2022`: the
 *              credential and the proof options are canonicalized with the
 *              JSON Canonicalization Scheme (RFC 8785), hashed (SHA-256),
 *              and signed with Ed25519. Chosen over `eddsa-rdfc-2022`
 *              because JCS needs no RDF processing to verify, so any
 *              verifier — ours included — checks it with a few lines of
 *              standard crypto; it is a W3C Recommendation suite all the
 *              same.
 *   issuer     `did:web` — the platform's host for the first tenant
 *              (resolves at /.well-known/did.json), `did:web:host:issuers:<slug>`
 *              for every other (resolves at /issuers/<slug>/did.json). The
 *              key is a per-tenant Ed25519 pair, its private half encrypted
 *              with the field keyring, published as a Multikey.
 *   status     W3C Bitstring Status List. Every credential has a slot; the
 *              list is built from the records live, so deleting a
 *              qualification, revoking it, or its record expiring early
 *              flips its bit with no job to run.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export const VC_CONTEXT = 'https://www.w3.org/ns/credentials/v2';
export const OB_CONTEXT = 'https://purl.imsglobal.org/spec/ob/v3p0/context-3.0.3.json';
export const CRYPTOSUITE = 'eddsa-jcs-2022' as const;
/** Bitstring Status List's minimum length: 16KB of bits, so one slot can't be singled out. */
export const STATUS_LIST_BITS = 131_072;

/* ----- Encodings ---------------------------------------------------------------- */

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58btc(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)]! + out;
    n /= 58n;
  }
  return '1'.repeat(zeros) + out;
}

export function fromBase58btc(s: string): Uint8Array {
  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros++;
  let n = 0n;
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) throw new Error('Not base58.');
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  return Uint8Array.from([...new Array(zeros).fill(0), ...bytes]);
}

/**
 * RFC 8785 JSON Canonicalization Scheme: keys sorted by UTF-16 code unit
 * (JavaScript's default string order), no whitespace, numbers and strings
 * in their ECMAScript serialization (what JSON.stringify produces).
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('JCS cannot encode a non-finite number.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalize(v))).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
}

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest();

/** Ed25519 Multikey: 'z' + base58btc(0xed01 ‖ 32-byte public key). */
export function multikey(publicKey: Uint8Array): string {
  return `z${base58btc(Uint8Array.from([0xed, 0x01, ...publicKey]))}`;
}

function publicKeyFromMultikey(mk: string): KeyObject {
  if (!mk.startsWith('z')) throw new Error('Unsupported multibase.');
  const bytes = fromBase58btc(mk.slice(1));
  if (bytes.length !== 34 || bytes[0] !== 0xed || bytes[1] !== 0x01) throw new Error('Not an Ed25519 Multikey.');
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(bytes.slice(2)).toString('base64url') }, format: 'jwk' });
}

/* ----- The issuer -------------------------------------------------------------- */

/** The platform host as did:web spells it (a port's colon is percent-encoded). */
export function didHost(): string {
  return new URL(env.APP_BASE_URL).host.replace(':', '%3A');
}

export function issuerDid(tenant: { id: string; slug: string }): string {
  return tenant.id === ALTO_TENANT_ID ? `did:web:${didHost()}` : `did:web:${didHost()}:issuers:${tenant.slug}`;
}

/** Which tenant a DID of ours names, or null when it isn't ours. */
export function tenantSlugFromDid(did: string): { ours: boolean; slug: string | null } {
  const base = `did:web:${didHost()}`;
  if (did === base) return { ours: true, slug: null };
  const prefix = `${base}:issuers:`;
  if (did.startsWith(prefix)) return { ours: true, slug: did.slice(prefix.length) };
  return { ours: false, slug: null };
}

export function statusListUrl(tenant: { slug: string }): string {
  return `${env.APP_BASE_URL.replace(/\/$/, '')}/credentials/status/${tenant.slug}`;
}

interface IssuerKey {
  keyId: string;
  publicKey: Uint8Array;
  privateKey: KeyObject;
}

/** The tenant's signing key, made the first time it's needed. */
export async function issuerKey(db: Db, tenantId: string): Promise<IssuerKey> {
  const existing = await db.credentialIssuerKey.findUnique({ where: { tenantId } });
  if (existing) {
    return {
      keyId: existing.keyId,
      publicKey: new Uint8Array(existing.publicKey),
      privateKey: createPrivateKey({ key: decryptBytes(existing.privateKeyEnc), format: 'der', type: 'pkcs8' }),
    };
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
  const der = privateKey.export({ format: 'der', type: 'pkcs8' });
  try {
    await db.credentialIssuerKey.create({ data: { tenantId, keyId: 'key-1', publicKey: raw, privateKeyEnc: encryptBytes(der) } });
  } catch {
    // Two first requests at once: the other one won; use its key.
    return issuerKey(db, tenantId);
  }
  return { keyId: 'key-1', publicKey: raw, privateKey };
}

export async function didDocument(db: Db, tenant: { id: string; slug: string }): Promise<Record<string, unknown>> {
  const key = await issuerKey(db, tenant.id);
  const did = issuerDid(tenant);
  const vm = `${did}#${key.keyId}`;
  return {
    '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'],
    id: did,
    verificationMethod: [{ id: vm, type: 'Multikey', controller: did, publicKeyMultibase: multikey(key.publicKey) }],
    assertionMethod: [vm],
    authentication: [vm],
  };
}

/* ----- Signing and checking a proof ------------------------------------------------ */

export interface DataIntegrityProof {
  type: 'DataIntegrityProof';
  cryptosuite: typeof CRYPTOSUITE;
  created: string;
  verificationMethod: string;
  proofPurpose: 'assertionMethod';
  proofValue: string;
}

function hashData(document: Record<string, unknown>, proofOptions: Record<string, unknown>): Buffer {
  const { proof: _proof, ...unsecured } = document;
  const options = { ...proofOptions, '@context': unsecured['@context'] };
  delete (options as Record<string, unknown>).proofValue;
  return Buffer.concat([sha256(canonicalize(options)), sha256(canonicalize(unsecured))]);
}

export function signDocument<T extends Record<string, unknown>>(document: T, key: { privateKey: KeyObject; verificationMethod: string }, created = new Date()): T & { proof: DataIntegrityProof } {
  const options = {
    type: 'DataIntegrityProof' as const,
    cryptosuite: CRYPTOSUITE as typeof CRYPTOSUITE,
    created: created.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    verificationMethod: key.verificationMethod,
    proofPurpose: 'assertionMethod' as const,
  };
  const signature = edSign(null, hashData(document, options), key.privateKey);
  return { ...document, proof: { ...options, proofValue: `z${base58btc(signature)}` } };
}

/** True when the proof was made by this public key over exactly this document. */
export function checkProof(document: Record<string, unknown>, publicKeyMultibase: string): boolean {
  const proof = document.proof as Partial<DataIntegrityProof> | undefined;
  if (!proof || proof.type !== 'DataIntegrityProof' || proof.cryptosuite !== CRYPTOSUITE || typeof proof.proofValue !== 'string' || !proof.proofValue.startsWith('z')) return false;
  try {
    const { proofValue, ...options } = proof;
    const sig = fromBase58btc(proofValue.slice(1));
    return edVerify(null, hashData(document, options), publicKeyFromMultikey(publicKeyMultibase), sig);
  } catch {
    return false;
  }
}

/* ----- The status list --------------------------------------------------------------- */

export function encodeBitstring(setIndexes: Iterable<number>, bits = STATUS_LIST_BITS): string {
  const bytes = Buffer.alloc(Math.ceil(bits / 8));
  for (const i of setIndexes) {
    if (i < 0 || i >= bits) continue;
    bytes[i >> 3]! |= 0x80 >> (i & 7);
  }
  return `u${gzipSync(bytes).toString('base64url')}`;
}

export function bitAt(encodedList: string, index: number): boolean {
  if (!encodedList.startsWith('u')) throw new Error('Unsupported multibase.');
  const bytes = gunzipSync(Buffer.from(encodedList.slice(1), 'base64url'));
  if (index < 0 || index >= bytes.length * 8) throw new Error('Index outside the list.');
  return (bytes[index >> 3]! & (0x80 >> (index & 7))) !== 0;
}

export type SubjectType = 'qualification' | 'training';

/** The slot for a credential, allocated once. */
export async function statusEntryFor(db: Db, tenantId: string, subjectType: SubjectType, subjectId: string, associateId: string): Promise<{ id: string; listIndex: number }> {
  const found = await db.credentialStatusEntry.findUnique({ where: { subjectType_subjectId: { subjectType, subjectId } }, select: { id: true, listIndex: true } });
  if (found) return found;
  for (let attempt = 0; attempt < 5; attempt++) {
    const max = await db.credentialStatusEntry.aggregate({ where: { tenantId }, _max: { listIndex: true } });
    const listIndex = (max._max.listIndex ?? -1) + 1;
    if (listIndex >= STATUS_LIST_BITS) throw new Error('This organization has used every credential slot in its status list.');
    try {
      return await db.credentialStatusEntry.create({ data: { tenantId, subjectType, subjectId, associateId, listIndex }, select: { id: true, listIndex: true } });
    } catch {
      // Raced with another issue: someone took that index (or this subject); look again.
      const again = await db.credentialStatusEntry.findUnique({ where: { subjectType_subjectId: { subjectType, subjectId } }, select: { id: true, listIndex: true } });
      if (again) return again;
    }
  }
  throw new Error('Could not allocate a status slot.');
}

/** Which slots are revoked now: revoked by hand, the record gone, or the record saying it has lapsed. */
export async function revokedIndexes(db: Db, tenantId: string, now = new Date()): Promise<number[]> {
  const entries = await db.credentialStatusEntry.findMany({ where: { tenantId }, select: { listIndex: true, subjectType: true, subjectId: true, revokedAt: true } });
  const qualIds = entries.filter((e) => e.subjectType === 'qualification').map((e) => e.subjectId);
  const trainIds = entries.filter((e) => e.subjectType === 'training').map((e) => e.subjectId);
  const [quals, trainings] = await Promise.all([
    qualIds.length ? db.associateQualification.findMany({ where: { id: { in: qualIds } }, select: { id: true, deletedAt: true, expiresAt: true, qualification: { select: { deletedAt: true } } } }) : [],
    trainIds.length ? db.courseEnrollment.findMany({ where: { id: { in: trainIds } }, select: { id: true, status: true, expiresAt: true } }) : [],
  ]);
  const qualOk = new Map(quals.map((q) => [q.id, !q.deletedAt && !q.qualification.deletedAt && !(q.expiresAt && q.expiresAt < now)]));
  const trainOk = new Map(trainings.map((t) => [t.id, t.status === 'COMPLETED' && !(t.expiresAt && t.expiresAt < now)]));
  return entries
    .filter((e) => e.revokedAt || !(e.subjectType === 'qualification' ? qualOk.get(e.subjectId) : trainOk.get(e.subjectId)))
    .map((e) => e.listIndex);
}

export async function statusListCredential(db: Db, tenant: { id: string; slug: string }, now = new Date()): Promise<Record<string, unknown>> {
  const key = await issuerKey(db, tenant.id);
  const url = statusListUrl(tenant);
  const did = issuerDid(tenant);
  const doc = {
    '@context': [VC_CONTEXT],
    id: url,
    type: ['VerifiableCredential', 'BitstringStatusListCredential'],
    issuer: did,
    validFrom: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    credentialSubject: { id: `${url}#list`, type: 'BitstringStatusList', statusPurpose: 'revocation', encodedList: encodeBitstring(await revokedIndexes(db, tenant.id, now)) },
  };
  return signDocument(doc, { privateKey: key.privateKey, verificationMethod: `${did}#${key.keyId}` }, now);
}

/* ----- Issuing ---------------------------------------------------------------------------- */

export interface CredentialSource {
  subjectType: SubjectType;
  subjectId: string;
  associateId: string;
  personName: string;
  title: string;
  description: string;
  issuedBy: string | null;
  earnedAt: Date | null;
  expiresAt: Date | null;
}

const isoZ = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
/** "Nov 15, 2027" — credential dates are calendar days at midnight UTC. */
const day = (d: Date) => d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });

export async function issueCredential(db: Db, tenant: { id: string; slug: string; name: string }, src: CredentialSource, now = new Date()): Promise<Record<string, unknown>> {
  const key = await issuerKey(db, tenant.id);
  const did = issuerDid(tenant);
  const entry = await statusEntryFor(db, tenant.id, src.subjectType, src.subjectId, src.associateId);
  const statusUrl = statusListUrl(tenant);
  const credential: Record<string, unknown> = {
    '@context': [VC_CONTEXT, OB_CONTEXT],
    id: `urn:uuid:${entry.id}`,
    type: ['VerifiableCredential', 'OpenBadgeCredential'],
    issuer: { id: did, type: ['Profile'], name: tenant.name },
    validFrom: isoZ(src.earnedAt ?? now),
    ...(src.expiresAt ? { validUntil: isoZ(src.expiresAt) } : {}),
    name: src.title,
    credentialSubject: {
      type: ['AchievementSubject'],
      name: src.personName,
      achievement: {
        id: `urn:uuid:${src.subjectId}`,
        type: ['Achievement'],
        achievementType: src.subjectType === 'training' ? 'Course' : 'Certificate',
        name: src.title,
        description: src.description,
        criteria: { narrative: src.subjectType === 'training' ? `Completed the course “${src.title}”.` : `Holds the credential “${src.title}”${src.issuedBy ? `, as required by ${src.issuedBy}` : ''}, verified by ${tenant.name}.` },
      },
    },
    credentialStatus: {
      id: `${statusUrl}#${entry.listIndex}`,
      type: 'BitstringStatusListEntry',
      statusPurpose: 'revocation',
      statusListIndex: String(entry.listIndex),
      statusListCredential: statusUrl,
    },
  };
  return signDocument(credential, { privateKey: key.privateKey, verificationMethod: `${did}#${key.keyId}` }, now);
}

/** A person's credentials as signable sources — only what the wallet shows as theirs and in force. */
export async function credentialSources(db: Db, associateId: string): Promise<CredentialSource[]> {
  const [person, quals, trainings] = await Promise.all([
    db.associate.findFirst({ where: { id: associateId, deletedAt: null }, select: { firstName: true, lastName: true } }),
    db.associateQualification.findMany({
      where: { associateId, deletedAt: null, qualification: { deletedAt: null } },
      select: { id: true, acquiredAt: true, expiresAt: true, qualification: { select: { name: true, isCert: true, client: { select: { name: true } } } } },
      take: 200,
    }),
    db.courseEnrollment.findMany({ where: { associateId, status: 'COMPLETED' }, select: { id: true, completedAt: true, expiresAt: true, course: { select: { title: true, description: true } } }, take: 200 }),
  ]);
  if (!person) return [];
  const personName = `${person.firstName} ${person.lastName}`.trim();
  return [
    ...quals.map((q) => ({
      subjectType: 'qualification' as const,
      subjectId: q.id,
      associateId,
      personName,
      title: q.qualification.name,
      description: q.qualification.isCert ? 'A certification held and verified on file.' : 'A qualification held and verified on file.',
      issuedBy: q.qualification.client?.name ?? null,
      earnedAt: q.acquiredAt,
      expiresAt: q.expiresAt,
    })),
    ...trainings.map((t) => ({
      subjectType: 'training' as const,
      subjectId: t.id,
      associateId,
      personName,
      title: t.course.title,
      description: t.course.description?.slice(0, 500) || 'A completed training course.',
      issuedBy: null,
      earnedAt: t.completedAt,
      expiresAt: t.expiresAt,
    })),
  ];
}

/* ----- Verifying ----------------------------------------------------------------------------- */

export type CheckState = 'pass' | 'fail' | 'warn';
export interface VerifyResult {
  verdict: 'valid' | 'revoked' | 'expired' | 'not_yet_valid' | 'invalid' | 'unknown_issuer';
  checks: Array<{ key: 'format' | 'issuer' | 'signature' | 'status' | 'dates'; state: CheckState; label: string }>;
  credential: { title: string | null; holder: string | null; issuer: string | null; issuedAt: string | null; expiresAt: string | null; kind: string | null } | null;
}

/**
 * Check a credential issued here: format, issuer, signature, revocation
 * and dates. A credential from another issuer is reported as such rather
 * than fetched — this page vouches only for what this platform signed.
 */
export async function verifyCredential(db: Db, input: unknown, now = new Date()): Promise<VerifyResult> {
  const checks: VerifyResult['checks'] = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { verdict: 'invalid', checks: [{ key: 'format', state: 'fail', label: 'This isn’t a credential — expected a JSON object.' }], credential: null };
  }
  const vc = input as Record<string, unknown>;
  const types = Array.isArray(vc.type) ? (vc.type as unknown[]) : [];
  const contexts = Array.isArray(vc['@context']) ? (vc['@context'] as unknown[]) : [];
  const subject = (vc.credentialSubject ?? {}) as Record<string, unknown>;
  const achievement = (subject.achievement ?? {}) as Record<string, unknown>;
  const issuerObj = vc.issuer;
  const issuerId = typeof issuerObj === 'string' ? issuerObj : typeof issuerObj === 'object' && issuerObj ? String((issuerObj as Record<string, unknown>).id ?? '') : '';
  const issuerName = typeof issuerObj === 'object' && issuerObj ? ((issuerObj as Record<string, unknown>).name as string | undefined) ?? null : null;
  const summary = {
    title: (vc.name as string) ?? (achievement.name as string) ?? null,
    holder: (subject.name as string) ?? null,
    issuer: issuerName ?? issuerId ?? null,
    issuedAt: (vc.validFrom as string) ?? null,
    expiresAt: (vc.validUntil as string) ?? null,
    kind: (achievement.achievementType as string) ?? null,
  };
  if (contexts[0] !== VC_CONTEXT || !types.includes('VerifiableCredential')) {
    return { verdict: 'invalid', checks: [{ key: 'format', state: 'fail', label: 'Not a W3C Verifiable Credential (version 2.0).' }], credential: summary };
  }
  checks.push({ key: 'format', state: 'pass', label: types.includes('OpenBadgeCredential') ? 'Open Badges 3.0 credential' : 'W3C Verifiable Credential' });

  const proof = (vc.proof ?? {}) as Partial<DataIntegrityProof>;
  const vm = typeof proof.verificationMethod === 'string' ? proof.verificationMethod : '';
  const vmDid = vm.split('#')[0] ?? '';
  const owner = tenantSlugFromDid(issuerId);
  if (!owner.ours || vmDid !== issuerId) {
    checks.push({ key: 'issuer', state: 'fail', label: 'Issued by another organization — this page checks credentials issued here.' });
    return { verdict: 'unknown_issuer', checks, credential: summary };
  }
  const tenant = owner.slug
    ? await db.tenant.findUnique({ where: { slug: owner.slug }, select: { id: true, slug: true, name: true } })
    : await db.tenant.findUnique({ where: { id: ALTO_TENANT_ID }, select: { id: true, slug: true, name: true } });
  if (!tenant) {
    checks.push({ key: 'issuer', state: 'fail', label: 'The issuer named in it doesn’t exist here.' });
    return { verdict: 'unknown_issuer', checks, credential: summary };
  }
  checks.push({ key: 'issuer', state: 'pass', label: `Issued by ${issuerName ?? tenant.name}` });

  const key = await db.credentialIssuerKey.findUnique({ where: { tenantId: tenant.id }, select: { keyId: true, publicKey: true } });
  const signed = !!key && vm === `${issuerId}#${key.keyId}` && checkProof(vc, multikey(new Uint8Array(key.publicKey)));
  checks.push({ key: 'signature', state: signed ? 'pass' : 'fail', label: signed ? 'Signature checks out — nothing in it has been changed' : 'The signature doesn’t match — it was altered or not signed by this issuer' });
  if (!signed) return { verdict: 'invalid', checks, credential: summary };

  let revoked = false;
  const status = vc.credentialStatus as Record<string, unknown> | undefined;
  if (status && status.type === 'BitstringStatusListEntry') {
    const idx = Number(status.statusListIndex);
    const listUrl = String(status.statusListCredential ?? '');
    if (listUrl !== statusListUrl(tenant) || !Number.isInteger(idx)) {
      checks.push({ key: 'status', state: 'fail', label: 'Its revocation entry doesn’t point at this issuer’s list.' });
      return { verdict: 'invalid', checks, credential: summary };
    }
    revoked = (await revokedIndexes(db, tenant.id, now)).includes(idx);
    checks.push({ key: 'status', state: revoked ? 'fail' : 'pass', label: revoked ? 'Revoked by the issuer' : 'Not revoked' });
  } else {
    checks.push({ key: 'status', state: 'warn', label: 'No revocation entry — can’t confirm it’s still in force' });
  }

  const from = summary.issuedAt ? new Date(summary.issuedAt) : null;
  const until = summary.expiresAt ? new Date(summary.expiresAt) : null;
  const expired = !!until && until < now;
  const early = !!from && from > now;
  checks.push({
    key: 'dates',
    state: expired || early ? 'fail' : 'pass',
    label: expired ? `Expired ${day(until!)}` : early ? `Not valid until ${day(from!)}` : until ? `Valid until ${day(until)}` : 'Doesn’t expire',
  });
  // A lapsed credential reads as expired even though its lapsing also sets its bit.
  return { verdict: expired ? 'expired' : revoked ? 'revoked' : early ? 'not_yet_valid' : 'valid', checks, credential: summary };
}

/** A fresh credential id for tests and for the offer token. */
export const newId = () => randomUUID();
