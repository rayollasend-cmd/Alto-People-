import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderAs } from './hrPack/harness';

const getMyWallet = vi.fn();
const getWorkerBadge = vi.fn();
vi.mock('@/lib/walletApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/walletApi')>()),
  getMyWallet: (...a: unknown[]) => getMyWallet(...a),
  getWorkerBadge: (...a: unknown[]) => getWorkerBadge(...a),
  shareMyWallet: vi.fn(),
}));
// The worker badge (another card on the page) is covered by its own tests.
vi.mock('@/pages/me/WorkerBadgeCard', () => ({ WorkerBadgeCard: () => null }));
const getMyCredentials = vi.fn();
const createCredentialOffer = vi.fn();
const saveCredentialFile = vi.fn();
vi.mock('@/lib/credentialsApi', () => ({
  getMyCredentials: (...a: unknown[]) => getMyCredentials(...a),
  createCredentialOffer: (...a: unknown[]) => createCredentialOffer(...a),
  saveCredentialFile: (...a: unknown[]) => saveCredentialFile(...a),
}));
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,QR') } }));

import { MyWallet } from '@/pages/me/MyWallet';

const VC = { type: ['VerifiableCredential', 'OpenBadgeCredential'], name: 'Forklift operator' };

beforeEach(() => {
  vi.clearAllMocks();
  getWorkerBadge.mockRejectedValue(new Error('no badge in this test'));
  getMyWallet.mockResolvedValue({
    person: { name: 'Ana Lopez', since: null },
    items: [
      { kind: 'qualification', id: 'q1', title: 'Forklift operator', issuer: null, earnedAt: '2026-01-10T00:00:00Z', expiresAt: '2028-01-10T00:00:00Z', state: 'valid' },
      { kind: 'document', id: 'd1', title: 'Government ID', issuer: 'Verified by HR', earnedAt: null, expiresAt: null, state: 'valid' },
    ],
  });
  getMyCredentials.mockResolvedValue({ credentials: [{ subjectType: 'qualification', subjectId: 'q1', title: 'Forklift operator', credential: VC }] });
  createCredentialOffer.mockResolvedValue({ url: 'https://app.example/api/credentials/offer/t', expiresAt: '2026-10-17T12:15:00Z' });
});

describe('the wallet’s signed credentials', () => {
  it('downloads a qualification as a signed credential; a document has no download', async () => {
    renderAs('ASSOCIATE', <MyWallet />, '/me/wallet', { associateId: 'a1' });
    const btn = await screen.findByRole('button', { name: 'Download Forklift operator as a signed credential' });
    expect(screen.queryByRole('button', { name: /download government id/i })).toBeNull();
    await userEvent.click(btn);
    await waitFor(() => expect(saveCredentialFile).toHaveBeenCalledWith('Forklift operator', VC));
  });

  it('“Share as a digital credential” (beside the list — "wallet" is only the Apple/Google pass) shows a QR for a 15-minute link, and can save them all', async () => {
    renderAs('ASSOCIATE', <MyWallet />, '/me/wallet', { associateId: 'a1' });
    expect(screen.queryByRole('button', { name: 'Add to a wallet app' })).toBeNull();
    await userEvent.click(await screen.findByRole('button', { name: 'Share as a digital credential' }));
    expect(await screen.findByRole('img', { name: 'QR code linking to your signed credentials' })).toHaveAttribute('src', 'data:image/png;base64,QR');
    expect(screen.getByText(/This code works for 15 minutes/)).toBeInTheDocument();
    expect(screen.getByText(/Anyone can check them at .*\/verify/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Download all' }));
    expect(saveCredentialFile).toHaveBeenCalledWith('credentials', [VC]);
  });

  it('the badge is the page’s primary action ("Show badge"); "Share a link" sits with the credentials (F500 G5)', async () => {
    getWorkerBadge.mockResolvedValue({ workerName: 'Ana Lopez' });
    renderAs('ASSOCIATE', <MyWallet />, '/me/wallet', { associateId: 'a1' });
    expect(await screen.findByTestId('wallet-show-badge')).toHaveTextContent('Show badge');
    expect(screen.getByRole('heading', { name: 'Credentials' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Share a link' })).toBeInTheDocument();
  });
});
