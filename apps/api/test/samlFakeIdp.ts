import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignedXml } from 'xml-crypto';
import type { IdentityConnection } from '@prisma/client';
import { acsUrl, spEntityId } from '../src/lib/saml.js';

/**
 * Brief 2-3 step 5 — a fake SAML IdP for tests: a real RSA key and X.509
 * certificate (openssl), and signed responses shaped like Okta's.
 */

export function fakeIdpKeys() {
  const dir = mkdtempSync(join(tmpdir(), 'alto-saml-'));
  const make = (name: string, cn: string) => execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, `${name}-key.pem`), '-out', join(dir, `${name}-cert.pem`), '-days', '2', '-subj', `/CN=${cn}`], { stdio: 'ignore' });
  make('idp', 'fake-idp');
  make('other', 'someone-else');
  const out = {
    KEY: readFileSync(join(dir, 'idp-key.pem'), 'utf8'),
    CERT: readFileSync(join(dir, 'idp-cert.pem'), 'utf8'),
    OTHER_KEY: readFileSync(join(dir, 'other-key.pem'), 'utf8'),
  };
  rmSync(dir, { recursive: true, force: true });
  return out;
}

const iso = (ms: number) => new Date(Date.now() + ms).toISOString();

export interface FakeResponseOpts {
  idp: string;
  key: string;
  inResponseTo?: string | null;
  audience?: string;
  notOnOrAfter?: number;
  assertionId?: string;
  nameId?: string;
  email?: string;
  sign?: boolean;
  relayState?: string;
}

/** A SAMLResponse form body for this connection, signed on the assertion unless sign is false. */
export function fakeSamlResponse(conn: Pick<IdentityConnection, 'id'>, opts: FakeResponseOpts): Record<string, string> {
  const irt = opts.inResponseTo ? ` InResponseTo="${opts.inResponseTo}"` : '';
  const assertionId = opts.assertionId ?? `_a${Math.random().toString(36).slice(2)}`;
  const xml =
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${Math.random().toString(36).slice(2)}" Version="2.0" IssueInstant="${iso(0)}" Destination="${acsUrl(conn)}"${irt}>` +
    `<saml:Issuer>${opts.idp}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    `<saml:Assertion ID="${assertionId}" Version="2.0" IssueInstant="${iso(0)}">` +
    `<saml:Issuer>${opts.idp}</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:2.0:nameid-format:persistent">${opts.nameId ?? '00u-ana'}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData${irt} NotOnOrAfter="${iso(opts.notOnOrAfter ?? 300_000)}" Recipient="${acsUrl(conn)}"/></saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${iso(-60_000)}" NotOnOrAfter="${iso(opts.notOnOrAfter ?? 300_000)}"><saml:AudienceRestriction><saml:Audience>${opts.audience ?? spEntityId(conn)}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${iso(0)}" SessionIndex="_s1"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
    `<saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>${opts.email ?? 'Ana@Acme.test'}</saml:AttributeValue></saml:Attribute></saml:AttributeStatement>` +
    `</saml:Assertion></samlp:Response>`;
  const relay: Record<string, string> = opts.relayState !== undefined ? { RelayState: opts.relayState } : {};
  if (opts.sign === false) return { SAMLResponse: Buffer.from(xml).toString('base64'), ...relay };
  const sig = new SignedXml({
    privateKey: opts.key,
    canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
    signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
  });
  sig.addReference({
    xpath: "//*[local-name(.)='Assertion']",
    transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'],
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
  });
  sig.computeSignature(xml, { location: { reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", action: 'after' } });
  return { SAMLResponse: Buffer.from(sig.getSignedXml()).toString('base64'), ...relay };
}
