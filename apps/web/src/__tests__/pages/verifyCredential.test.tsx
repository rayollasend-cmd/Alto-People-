import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

const verifyCredential = vi.fn();
vi.mock('@/lib/credentialsApi', () => ({ verifyCredential: (...a: unknown[]) => verifyCredential(...a) }));

import { VerifyCredentialPage } from '@/pages/public/VerifyCredentialPage';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/verify']}>
        <VerifyCredentialPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => verifyCredential.mockReset());

describe('<VerifyCredentialPage>', () => {
  it('checks a pasted credential and says plainly what passed', async () => {
    verifyCredential.mockResolvedValue({
      verdict: 'valid',
      checks: [
        { key: 'format', state: 'pass', label: 'Open Badges 3.0 credential' },
        { key: 'issuer', state: 'pass', label: 'Issued by Alto HR' },
        { key: 'signature', state: 'pass', label: 'Signature checks out — nothing in it has been changed' },
        { key: 'status', state: 'pass', label: 'Not revoked' },
        { key: 'dates', state: 'pass', label: 'Valid until 2028-01-10' },
      ],
      credential: { title: 'Forklift operator', holder: 'Ana Lopez', issuer: 'Alto HR', issuedAt: '2026-01-10T00:00:00Z', expiresAt: '2028-01-10T00:00:00Z', kind: 'Certificate' },
    });
    renderPage();
    expect(screen.getByRole('button', { name: /check it/i })).toBeDisabled();
    await userEvent.click(screen.getByLabelText('The credential'));
    await userEvent.paste('{"@context":["https://www.w3.org/ns/credentials/v2"]}');
    await userEvent.click(screen.getByRole('button', { name: /check it/i }));
    await waitFor(() => expect(verifyCredential).toHaveBeenCalledWith('{"@context":["https://www.w3.org/ns/credentials/v2"]}'));
    expect(await screen.findByText('Valid credential')).toBeInTheDocument();
    expect(screen.getByText('Forklift operator')).toBeInTheDocument();
    expect(screen.getByText('Ana Lopez')).toBeInTheDocument();
    // Each check carries its result in words, not only colour.
    expect(screen.getAllByText('Passed:')).toHaveLength(5);
  });

  it('an altered credential is named untrustworthy, with the failing check', async () => {
    verifyCredential.mockResolvedValue({
      verdict: 'invalid',
      checks: [
        { key: 'format', state: 'pass', label: 'Open Badges 3.0 credential' },
        { key: 'signature', state: 'fail', label: 'The signature doesn’t match — it was altered or not signed by this issuer' },
      ],
      credential: { title: 'Forklift operator', holder: 'Someone Else', issuer: 'Alto HR', issuedAt: null, expiresAt: null, kind: null },
    });
    renderPage();
    await userEvent.click(screen.getByLabelText('The credential'));
    await userEvent.paste('{}');
    await userEvent.click(screen.getByRole('button', { name: /check it/i }));
    expect(await screen.findByText('Can’t be trusted')).toBeInTheDocument();
    expect(screen.getByText('Failed:')).toBeInTheDocument();
  });

  it('opens a file and checks it straight away', async () => {
    verifyCredential.mockResolvedValue({ verdict: 'expired', checks: [{ key: 'dates', state: 'fail', label: 'Expired 2025-06-01' }], credential: null });
    renderPage();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['{"a":1}'], 'forklift.json', { type: 'application/json' });
    await userEvent.upload(input, file);
    await waitFor(() => expect(verifyCredential).toHaveBeenCalledWith('{"a":1}'));
    expect(await screen.findByText('Expired')).toBeInTheDocument();
    expect(screen.getByText('Opened forklift.json.')).toBeInTheDocument();
  });
});
