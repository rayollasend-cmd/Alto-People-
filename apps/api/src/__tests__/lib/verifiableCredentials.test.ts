import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import {
  base58btc,
  bitAt,
  canonicalize,
  checkProof,
  encodeBitstring,
  fromBase58btc,
  multikey,
  signDocument,
  STATUS_LIST_BITS,
} from '../../lib/verifiableCredentials.js';

/** The pieces a verifier anywhere relies on: JCS, base58btc, the Data Integrity proof, the status bitstring. */

describe('JSON Canonicalization Scheme (RFC 8785)', () => {
  it('matches the RFC’s own example', () => {
    const input = JSON.parse(
      '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/","literals":[null,true,false]}',
    );
    expect(canonicalize(input)).toBe('{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}');
  });
  it('sorts keys at every depth and drops undefined', () => {
    expect(canonicalize({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[3,{"y":2,"z":1}]},"b":1}');
  });
});

describe('base58btc', () => {
  it('round-trips, keeping leading zero bytes', () => {
    const bytes = Uint8Array.from([0, 0, 1, 2, 250, 255]);
    expect(Array.from(fromBase58btc(base58btc(bytes)))).toEqual(Array.from(bytes));
    expect(base58btc(new TextEncoder().encode('hello world'))).toBe('StV1DL6CwTryKyV');
  });
});

describe('the eddsa-jcs-2022 proof', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
  const mk = multikey(raw);
  const doc = { '@context': ['https://www.w3.org/ns/credentials/v2'], type: ['VerifiableCredential'], issuer: 'did:web:example.com', credentialSubject: { name: 'Ana Lopez' } };

  it('a Multikey is z6Mk… (the Ed25519 multicodec prefix)', () => {
    expect(mk.startsWith('z6Mk')).toBe(true);
  });

  it('verifies what it signed, and nothing else', () => {
    const signed = signDocument(doc, { privateKey, verificationMethod: 'did:web:example.com#key-1' });
    expect(signed.proof).toMatchObject({ type: 'DataIntegrityProof', cryptosuite: 'eddsa-jcs-2022', proofPurpose: 'assertionMethod' });
    expect(checkProof(signed, mk)).toBe(true);
    // Key order doesn't matter (JCS); content does.
    const reordered = JSON.parse(JSON.stringify({ credentialSubject: signed.credentialSubject, proof: signed.proof, issuer: signed.issuer, type: signed.type, '@context': signed['@context'] }));
    expect(checkProof(reordered, mk)).toBe(true);
    expect(checkProof({ ...signed, credentialSubject: { name: 'Someone Else' } }, mk)).toBe(false);
    expect(checkProof({ ...signed, proof: { ...signed.proof, created: '2020-01-01T00:00:00Z' } }, mk)).toBe(false);
    const other = generateKeyPairSync('ed25519').publicKey;
    expect(checkProof(signed, multikey(Buffer.from(other.export({ format: 'jwk' }).x!, 'base64url')))).toBe(false);
  });
});

describe('the Bitstring Status List', () => {
  it('sets exactly the slots asked for, most significant bit first', () => {
    const list = encodeBitstring([0, 9, STATUS_LIST_BITS - 1]);
    expect(list.startsWith('u')).toBe(true);
    expect(bitAt(list, 0)).toBe(true);
    expect(bitAt(list, 1)).toBe(false);
    expect(bitAt(list, 9)).toBe(true);
    expect(bitAt(list, STATUS_LIST_BITS - 1)).toBe(true);
    expect(bitAt(list, 100)).toBe(false);
  });
});
