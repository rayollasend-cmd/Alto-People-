/**
 * Service providers Alto connects to on a tenant's behalf: E-Verify,
 * background checks, drug tests, tax filing and payouts.
 *
 * Each entry says what the provider does, which credentials a live
 * connection needs, the non-secret settings, how its webhooks are signed,
 * and the steps to set it up in plain words. `confidence` is honest about
 * how the request shapes were sourced:
 *
 *   documented  the vendor's public API reference was read (2026-10-17)
 *   partner     the vendor's API is gated behind a partner agreement; the
 *               shapes here are the published method names with fields we
 *               could not confirm, marked "confirm with vendor" in code
 */

export type ProviderKindName = 'EVERIFY' | 'BACKGROUND_CHECK' | 'DRUG_TEST' | 'TAX_FILING' | 'PAYOUT';

export type ProviderId =
  | 'DHS_EVERIFY'
  | 'EVERIFY_AGENT'
  | 'CHECKR'
  | 'GENERIC_SCREENING'
  | 'ESCREEN'
  | 'QUEST_ESP'
  | 'TAXBANDITS'
  | 'WISE';

export interface ProviderField {
  key: string;
  label: string;
  secret: boolean;
  /** Plain-words help shown under the field. */
  hint?: string;
  optional?: boolean;
}

export interface ProviderInfo {
  id: ProviderId;
  kind: ProviderKindName;
  label: string;
  /** One sentence: what connecting it does. */
  what: string;
  credentialFields: ProviderField[];
  settingFields: ProviderField[];
  /** How the provider proves a webhook is theirs, in plain words. */
  webhook: { supported: boolean; how: string };
  /** Setup steps, in order, in plain words. */
  steps: string[];
  confidence: 'documented' | 'partner';
  baseUrls: { SANDBOX: string; PRODUCTION: string };
}

export const PROVIDER_KIND_LABEL: Record<ProviderKindName, string> = {
  EVERIFY: 'E-Verify',
  BACKGROUND_CHECK: 'Background checks',
  DRUG_TEST: 'Drug tests',
  TAX_FILING: 'Tax filing',
  PAYOUT: 'Payouts',
};

export const PROVIDERS: readonly ProviderInfo[] = [
  {
    id: 'DHS_EVERIFY',
    kind: 'EVERIFY',
    label: 'E-Verify (DHS web services)',
    what: 'Opens E-Verify cases straight from the I-9 and reads the result back — no retyping into the government site.',
    credentialFields: [
      { key: 'clientId', label: 'Web services user ID', secret: false, hint: 'Issued by E-Verify when your web services account is approved.' },
      { key: 'clientSecret', label: 'Web services password', secret: true },
      { key: 'companyId', label: 'E-Verify company ID', secret: false },
    ],
    settingFields: [],
    webhook: { supported: false, how: 'E-Verify does not call back. Each open case is checked for a new result.' },
    steps: [
      'Sign the E-Verify web services agreement (MOU) with DHS and complete interface certification.',
      'Enter the user ID, password and company ID DHS issued you.',
      'Test the connection in the sandbox, then switch to production.',
    ],
    confidence: 'partner',
    baseUrls: { SANDBOX: 'https://stage-everify.uscis.gov/api/v31', PRODUCTION: 'https://everify.uscis.gov/api/v31' },
  },
  {
    id: 'EVERIFY_AGENT',
    kind: 'EVERIFY',
    label: 'E-Verify employer agent',
    what: 'Sends cases through an E-Verify employer agent (an I-9 vendor) that holds the DHS connection for you.',
    credentialFields: [
      { key: 'baseUrl', label: 'Agent API address', secret: false, hint: 'The web address your agent gave you, ending before /cases.' },
      { key: 'apiKey', label: 'API key', secret: true },
      { key: 'companyId', label: 'Your E-Verify company ID', secret: false },
    ],
    settingFields: [],
    webhook: { supported: true, how: 'The agent signs each update with a shared secret (HMAC-SHA256 in the X-Signature header).' },
    steps: [
      'Ask your E-Verify employer agent for API access and a webhook secret.',
      'Enter the API address, key and your company ID.',
      'Paste the webhook address below into the agent’s settings.',
    ],
    confidence: 'partner',
    baseUrls: { SANDBOX: '', PRODUCTION: '' },
  },
  {
    id: 'CHECKR',
    kind: 'BACKGROUND_CHECK',
    label: 'Checkr',
    what: 'Invites the person to Checkr, follows the report, and runs the FCRA notices if a report needs a decision.',
    credentialFields: [{ key: 'apiKey', label: 'Checkr API key', secret: true, hint: 'Checkr dashboard → Account settings → Developer settings.' }],
    settingFields: [
      { key: 'defaultPackage', label: 'Default package', secret: false, hint: 'The Checkr package slug, e.g. tasker_standard.' },
    ],
    webhook: { supported: true, how: 'Checkr signs each webhook with your API key (HMAC-SHA256 in X-Checkr-Signature).' },
    steps: [
      'Copy your API key from the Checkr dashboard (use the test key for the sandbox).',
      'Choose the default package, and any package per client or position.',
      'In Checkr, add the webhook address below for report and invitation events.',
    ],
    confidence: 'documented',
    baseUrls: { SANDBOX: 'https://api.checkr-staging.com/v1', PRODUCTION: 'https://api.checkr.com/v1' },
  },
  {
    id: 'GENERIC_SCREENING',
    kind: 'BACKGROUND_CHECK',
    label: 'Other screening provider (Sterling, First Advantage…)',
    what: 'Orders checks through any screening provider that offers an order-and-status API.',
    credentialFields: [
      { key: 'baseUrl', label: 'Provider API address', secret: false },
      { key: 'apiKey', label: 'API key', secret: true },
    ],
    settingFields: [{ key: 'defaultPackage', label: 'Default package', secret: false }],
    webhook: { supported: true, how: 'The provider signs each update with a shared secret (HMAC-SHA256 in X-Signature).' },
    steps: [
      'Ask your provider for API access, the package codes, and a webhook secret.',
      'Enter the API address and key, and the default package.',
      'Paste the webhook address below into the provider’s settings.',
    ],
    confidence: 'partner',
    baseUrls: { SANDBOX: '', PRODUCTION: '' },
  },
  {
    id: 'ESCREEN',
    kind: 'DRUG_TEST',
    label: 'eScreen (Abbott)',
    what: 'Orders the test, emails the person a donor pass with the nearest collection site, and records the MRO-verified result.',
    credentialFields: [
      { key: 'baseUrl', label: 'eScreen API address', secret: false, hint: 'Given to you by eScreen or your integration partner.' },
      { key: 'apiKey', label: 'API key', secret: true },
      { key: 'accountId', label: 'eScreen account number', secret: false },
    ],
    settingFields: [{ key: 'defaultPanel', label: 'Default panel', secret: false, hint: 'e.g. 5-panel urine.' }],
    webhook: { supported: true, how: 'Status and results arrive signed with a shared secret (HMAC-SHA256 in X-Signature).' },
    steps: [
      'Ask eScreen for API access, your account number and a webhook secret.',
      'Choose the default panel.',
      'Paste the webhook address below into the eScreen settings.',
    ],
    confidence: 'partner',
    baseUrls: { SANDBOX: '', PRODUCTION: '' },
  },
  {
    id: 'QUEST_ESP',
    kind: 'DRUG_TEST',
    label: 'Quest Diagnostics (Employer Solutions Portal)',
    what: 'Creates Quest orders (CreateOrder) and receives order status and MRO results (OrderStatus, OrderResult).',
    credentialFields: [
      { key: 'baseUrl', label: 'ESP web service address', secret: false },
      { key: 'username', label: 'ESP user', secret: false },
      { key: 'password', label: 'ESP password', secret: true },
      { key: 'accountNumber', label: 'Quest account number', secret: false },
    ],
    settingFields: [{ key: 'defaultPanel', label: 'Default unit code', secret: false, hint: 'The Quest unit code for your usual panel.' }],
    webhook: { supported: true, how: 'Quest posts OrderStatus and OrderResult here with a shared secret (HMAC-SHA256 in X-Signature).' },
    steps: [
      'Ask the ESP support team (ESP@questdiagnostics.com) to enable web services for your account.',
      'Enter the ESP address, user, password and account number.',
      'Give Quest the webhook address below for OrderStatus and OrderResult.',
    ],
    confidence: 'partner',
    baseUrls: { SANDBOX: '', PRODUCTION: '' },
  },
  {
    id: 'TAXBANDITS',
    kind: 'TAX_FILING',
    label: 'TaxBandits',
    what: 'E-files the 941, 940, W-2, W-3, 1099 and 1095-C forms prepared here, and records the agency’s acceptance.',
    credentialFields: [
      { key: 'clientId', label: 'Client ID', secret: false, hint: 'TaxBandits console → Settings → API credentials.' },
      { key: 'clientSecret', label: 'Client secret', secret: true },
      { key: 'userToken', label: 'User token', secret: true },
    ],
    settingFields: [{ key: 'businessId', label: 'TaxBandits business ID', secret: false, hint: 'Created once for your EIN; made on the first filing if left blank.', optional: true }],
    webhook: { supported: true, how: 'TaxBandits signs each status update with your client secret (HMAC-SHA256 of client ID and timestamp).' },
    steps: [
      'Create API credentials in the TaxBandits console (sandbox first).',
      'Enter the client ID, client secret and user token.',
      'In the console, add the webhook address below for "E-file status change".',
    ],
    confidence: 'documented',
    baseUrls: { SANDBOX: 'https://testapi.taxbandits.com/v1.7.3', PRODUCTION: 'https://api.taxbandits.com/v1.7.3' },
  },
  {
    id: 'WISE',
    kind: 'PAYOUT',
    label: 'Wise',
    what: 'Pays direct deposits from your Wise balance and follows each transfer until the bank has it — or sends it back.',
    credentialFields: [
      { key: 'apiKey', label: 'API token', secret: true, hint: 'Wise → Settings → API tokens (full access).' },
      { key: 'profileId', label: 'Business profile ID', secret: false },
    ],
    settingFields: [
      { key: 'webhookPublicKey', label: 'Wise webhook public key', secret: false, hint: 'Paste the PEM public key from the Wise webhook docs for this environment.', optional: true },
    ],
    webhook: { supported: true, how: 'Wise signs each transfer update with its private key (RSA-SHA256 in X-Signature-SHA256); each one is checked with Wise’s public key.' },
    steps: [
      'Create an API token for your Wise business profile.',
      'Enter the token and the profile ID.',
      'In Wise, subscribe the webhook address below to transfer state changes, and paste Wise’s public key.',
    ],
    confidence: 'documented',
    baseUrls: { SANDBOX: 'https://api.sandbox.transferwise.tech', PRODUCTION: 'https://api.wise.com' },
  },
];

export function providerInfo(id: string): ProviderInfo | undefined {
  return PROVIDERS.find((p) => p.id === id);
}
