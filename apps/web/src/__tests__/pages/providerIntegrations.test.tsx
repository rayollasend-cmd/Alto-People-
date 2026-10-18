import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ProviderConnection, ProviderKindSummary } from '@/lib/providersApi';
import { renderAs } from './hrPack/harness';

const api = vi.hoisted(() => ({
  listProviderConnections: vi.fn(),
  providerCatalog: vi.fn(),
  createProviderConnection: vi.fn(),
  testProviderConnection: vi.fn(),
  patchProviderConnection: vi.fn(),
  rotateProviderSecret: vi.fn(),
  deleteProviderConnection: vi.fn(),
  providerEvents: vi.fn(),
  providerSummary: vi.fn(),
  everifyProviderView: vi.fn(),
  submitEVerify: vi.fn(),
  refreshEVerify: vi.fn(),
  recordEVerifyDecision: vi.fn(),
  closeEVerify: vi.fn(),
  backgroundProviderView: vi.fn(),
  orderBackground: vi.fn(),
  refreshBackground: vi.fn(),
  startPreAdverse: vi.fn(),
  sendFinalAdverse: vi.fn(),
  withdrawAdverse: vi.fn(),
  drugProviderView: vi.fn(),
  orderDrug: vi.fn(),
  refreshDrug: vi.fn(),
  efileForm: vi.fn(),
  refreshEfile: vi.fn(),
}));
vi.mock('@/lib/providersApi', () => api);

import { ProvidersSection } from '@/pages/integrations/providers/ProvidersSection';
import { EVerifyProviderPanel } from '@/pages/compliance/providers/EVerifyProviderPanel';
import { BackgroundProviderPanel } from '@/pages/compliance/providers/BackgroundProviderPanel';
import { DrugProviderPanel } from '@/pages/compliance/providers/DrugProviderPanel';
import { EfileAction } from '@/pages/payrollTax/EfileAction';

const conn = (o: Partial<ProviderConnection>): ProviderConnection => ({
  id: 'c1',
  kind: 'BACKGROUND_CHECK',
  provider: 'CHECKR',
  providerLabel: 'Checkr',
  name: 'Checkr',
  environment: 'SANDBOX',
  active: true,
  health: 'healthy',
  lastSuccessAt: new Date(Date.now() - 120_000).toISOString(),
  lastErrorAt: null,
  lastError: null,
  lastTestAt: null,
  lastTestOk: null,
  credentialsSet: { apiKey: true },
  credentialValues: {},
  settings: {},
  webhookUrl: 'https://app.example.com/api/webhooks/providers/c1',
  webhookSecretSet: false,
  createdAt: new Date().toISOString(),
  ...o,
});

const kinds = (overrides: Partial<Record<string, ProviderConnection | null>> = {}): { kinds: ProviderKindSummary[] } => ({
  kinds: (['EVERIFY', 'BACKGROUND_CHECK', 'DRUG_TEST', 'TAX_FILING', 'PAYOUT'] as const).map((k) => {
    const a = overrides[k] ?? null;
    return { kind: k, label: k, active: a, connections: a ? [a] : [] };
  }),
});

const CATALOG = {
  providers: [
    {
      id: 'CHECKR',
      kind: 'BACKGROUND_CHECK',
      label: 'Checkr',
      what: 'Invites the person to Checkr.',
      credentialFields: [{ key: 'apiKey', label: 'Checkr API key', secret: true }],
      settingFields: [{ key: 'defaultPackage', label: 'Default package', secret: false }],
      webhook: { supported: true, how: 'Signed with your API key.' },
      steps: ['Copy your API key.'],
      confidence: 'documented',
    },
    {
      id: 'GENERIC_SCREENING',
      kind: 'BACKGROUND_CHECK',
      label: 'Other screening provider',
      what: 'Any provider with an API.',
      credentialFields: [
        { key: 'baseUrl', label: 'Provider API address', secret: false },
        { key: 'apiKey', label: 'API key', secret: true },
      ],
      settingFields: [],
      webhook: { supported: true, how: 'Shared secret.' },
      steps: ['Ask for API access.'],
      confidence: 'partner',
    },
  ],
};

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset();
  api.providerCatalog.mockResolvedValue(CATALOG);
  api.providerEvents.mockResolvedValue({ events: [] });
  api.providerSummary.mockResolvedValue({ connected: {}, canManageIntegrations: true });
});

describe('Integrations → Screening, filing and payouts', () => {
  it('says what happens today when nothing is connected, and how a failing connection is doing', async () => {
    api.listProviderConnections.mockResolvedValue(
      kinds({ PAYOUT: conn({ id: 'w', kind: 'PAYOUT', provider: 'WISE', providerLabel: 'Wise', environment: 'PRODUCTION', health: 'failing', lastErrorAt: '2026-10-17T14:14:00Z', lastError: 'Bad token' }) }),
    );
    renderAs('HR_ADMINISTRATOR', <ProvidersSection canManage />, '/integrations');
    const list = await screen.findByRole('list', { name: 'Provider kinds' });
    expect(within(list).getByText(/opened on the government site/)).toBeInTheDocument();
    expect(within(list).getByRole('button', { name: 'Set up e-verify' })).toBeInTheDocument();
    expect(within(list).getByText('Wise · Live')).toBeInTheDocument();
    expect(within(list).getByText('Needs attention')).toBeInTheDocument();
    expect(within(list).getByText(/Failing since .*: Bad token/)).toBeInTheDocument();
  });

  it('a non-admin sees the state but not the setup', async () => {
    api.listProviderConnections.mockResolvedValue(kinds());
    renderAs('HR_ADMINISTRATOR', <ProvidersSection canManage={false} />, '/integrations');
    await screen.findByRole('list', { name: 'Provider kinds' });
    expect(screen.queryByRole('button', { name: /Set up/ })).toBeNull();
    expect(screen.getAllByText('An integrations admin can connect this.').length).toBe(5);
  });

  it('sets up a provider: choose, follow the steps, connect and test, and see the secret once', async () => {
    api.listProviderConnections.mockResolvedValue(kinds());
    api.createProviderConnection.mockResolvedValue({ connection: conn({ id: 'g', provider: 'GENERIC_SCREENING', providerLabel: 'Other screening provider' }), webhookSecret: 'f'.repeat(64) });
    api.testProviderConnection.mockResolvedValue({ ok: false, message: 'The provider did not answer in time.' });
    renderAs('HR_ADMINISTRATOR', <ProvidersSection canManage />, '/integrations');
    await userEvent.click(await screen.findByRole('button', { name: 'Set up background checks' }));
    const drawer = await screen.findByRole('dialog');
    await userEvent.click(within(drawer).getByLabelText(/Other screening provider/));
    expect(within(drawer).getByText('Needs a partner agreement')).toBeInTheDocument();
    expect(within(drawer).getByText('Ask for API access.')).toBeInTheDocument();
    const go = within(drawer).getByRole('button', { name: 'Connect and test' });
    expect(go).toBeDisabled();
    await userEvent.type(within(drawer).getByLabelText(/Provider API address/), 'https://screen.example.com');
    await userEvent.type(within(drawer).getByLabelText(/^API key/), 'k');
    await userEvent.click(go);
    expect(await within(drawer).findByText('Saved, but the test didn’t pass.')).toBeInTheDocument();
    expect(within(drawer).getByText(/did not answer in time/)).toBeInTheDocument();
    expect(within(drawer).getByText('f'.repeat(64))).toBeInTheDocument();
    expect(within(drawer).getByText(/won’t be shown again/)).toBeInTheDocument();
    expect(api.createProviderConnection).toHaveBeenCalledWith(expect.objectContaining({ kind: 'BACKGROUND_CHECK', provider: 'GENERIC_SCREENING', environment: 'SANDBOX' }));
  });
});

describe('E-Verify mismatch', () => {
  it('walks the notice and the choice, then shows the referral deadline', async () => {
    api.providerSummary.mockResolvedValue({ connected: { EVERIFY: { provider: 'EVERIFY_AGENT', label: 'E-Verify employer agent', environment: 'PRODUCTION', failing: false } }, canManageIntegrations: true });
    const base = {
      connected: { provider: 'EVERIFY_AGENT', label: 'E-Verify employer agent', environment: 'PRODUCTION' },
      sentThroughProvider: true,
      caseNumber: '2026291000001AB',
      status: 'TENTATIVE_NONCONFIRMATION' as const,
      rawStatus: 'TENTATIVE_NONCONFIRMATION',
      openedAt: '2026-10-13T15:00:00Z',
      closedAt: null,
      dueBy: '2026-10-15',
      section2Done: true,
      tnc: { notifiedAt: null, decision: null, referredAt: null, referralDeadline: null },
      closureReason: null,
      lastSyncAt: null,
      lastError: null,
    };
    api.everifyProviderView.mockResolvedValue(base);
    api.recordEVerifyDecision.mockResolvedValue({ ...base, tnc: { notifiedAt: '2026-10-17T15:00:00Z', decision: 'CONTEST', referredAt: '2026-10-17T15:00:00Z', referralDeadline: '2026-10-29' } });
    renderAs('HR_ADMINISTRATOR', <EVerifyProviderPanel associateId="a1" personName="Ben Ortiz" canManage onChanged={() => undefined} />, '/compliance');
    expect(await screen.findByText('E-Verify found a mismatch for Ben Ortiz.')).toBeInTheDocument();
    expect(screen.getByText(/Further Action Notice in private/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'They’ll take action' }));
    expect(await screen.findByText(/8 federal working days/)).toBeInTheDocument();
    expect(screen.getByText(/Thu, Oct 29/)).toBeInTheDocument();
    expect(api.recordEVerifyDecision).toHaveBeenCalledWith('a1', 'CONTEST');
  });
});

describe('background check adverse action', () => {
  it('holds the final notice until the waiting period ends, and names the date', async () => {
    api.providerSummary.mockResolvedValue({ connected: { BACKGROUND_CHECK: { provider: 'CHECKR', label: 'Checkr', environment: 'PRODUCTION', failing: false } }, canManageIntegrations: true });
    api.backgroundProviderView.mockResolvedValue({
      id: 'b1',
      connected: { provider: 'CHECKR', label: 'Checkr', environment: 'PRODUCTION' },
      ordered: true,
      provider: 'CHECKR',
      packageCode: 'tasker_standard',
      invitationUrl: null,
      status: 'NEEDS_REVIEW',
      rawStatus: 'complete',
      result: 'consider',
      adjudication: 'PRE_ADVERSE',
      preAdverseSentAt: '2026-10-17T15:00:00Z',
      adverseWaitUntil: '2026-10-24T15:00:00Z',
      canSendFinal: false,
      adverseSentAt: null,
      lastSyncAt: null,
      lastError: null,
    });
    renderAs('HR_ADMINISTRATOR', <BackgroundProviderPanel checkId="b1" personName="Ana Lopez" canManage onCleared={() => undefined} onChanged={() => undefined} />, '/compliance');
    expect(await screen.findByText(/has until/)).toBeInTheDocument();
    const final = screen.getByRole('button', { name: /Final notice from/ });
    expect(final).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Withdraw — clear them' })).toBeEnabled();
  });
});

describe('drug test result', () => {
  it('a positive waits for the Medical Review Officer instead of reading as failed', async () => {
    api.providerSummary.mockResolvedValue({ connected: { DRUG_TEST: { provider: 'ESCREEN', label: 'eScreen (Abbott)', environment: 'PRODUCTION', failing: false } }, canManageIntegrations: true });
    api.drugProviderView.mockResolvedValue({
      id: 'd1',
      connected: { provider: 'ESCREEN', label: 'eScreen (Abbott)', environment: 'PRODUCTION' },
      ordered: true,
      provider: 'ESCREEN',
      panelCode: '5-panel',
      reason: 'PRE_EMPLOYMENT',
      donorPassUrl: 'https://pass.example.com/1',
      donorPassExpiresAt: '2026-10-24T23:59:00Z',
      collectionSite: 'Concentra, 12 Main St',
      status: 'NEEDS_REVIEW',
      rawStatus: 'lab',
      resultCode: 'POSITIVE',
      mroVerifiedAt: null,
      lastSyncAt: null,
      lastError: null,
    });
    renderAs('HR_ADMINISTRATOR', <DrugProviderPanel testId="d1" personName="Ana Lopez" canManage onChanged={() => undefined} />, '/compliance');
    expect(await screen.findByText('Not negative — waiting for the Medical Review Officer')).toBeInTheDocument();
    expect(screen.getByText(/Don’t act on this result until it’s verified/)).toBeInTheDocument();
    expect(screen.getByText('Before they start')).toBeInTheDocument();
  });
});

describe('e-file', () => {
  it('shows nothing without a filing partner, and offers e-file with one', async () => {
    const { unmount } = renderAs('HR_ADMINISTRATOR', <EfileAction formId="f1" formLabel="Form 941" status="DRAFT" efileStatus={null} onChanged={() => undefined} />, '/payroll/tax');
    await waitFor(() => expect(api.providerSummary).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'E-file' })).toBeNull();
    unmount();
    api.providerSummary.mockResolvedValue({ connected: { TAX_FILING: { provider: 'TAXBANDITS', label: 'TaxBandits', environment: 'SANDBOX', failing: false } }, canManageIntegrations: true });
    renderAs('HR_ADMINISTRATOR', <EfileAction formId="f1" formLabel="Form 941" status="DRAFT" efileStatus="REJECTED" onChanged={() => undefined} />, '/payroll/tax');
    expect(await screen.findByRole('button', { name: 'File again' })).toBeInTheDocument();
  });
});
