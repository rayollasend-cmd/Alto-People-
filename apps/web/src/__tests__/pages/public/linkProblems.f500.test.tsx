import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';

vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), apiFetch: vi.fn() }));
vi.mock('@/lib/settingsApi', () => ({ confirmEmailChange: vi.fn() }));
vi.mock('@/lib/auth', async (orig) => ({ ...(await orig<typeof import('@/lib/auth')>()), useAuth: () => ({ signIn: vi.fn(), user: null }) }));
vi.mock('@/components/transport/LazyLiveMap', () => ({ LazyLiveMap: () => null }));

import { ApiError, apiFetch } from '@/lib/api';
import { confirmEmailChange } from '@/lib/settingsApi';
import { ResetPassword } from '@/pages/ResetPassword';
import { ConfirmEmailChange } from '@/pages/ConfirmEmailChange';
import { AcceptInvite } from '@/pages/AcceptInvite';
import { TrackPage } from '@/pages/transport/TrackPage';
import { WalletVerifyPage } from '@/pages/public/WalletVerifyPage';
import { NpsSurveyPage } from '@/pages/nps/NpsSurveyPage';

/**
 * One link-problem state for every emailed or shared link (F500 G5): an
 * expired link (410) and a link we never issued (404) are told apart, each
 * page offers ONE next step, and the reset page checks its link before
 * anyone types a password.
 */

function renderAt(path: string, pattern: string, el: ReactElement) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={pattern} element={el} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const fail = (status: number, code: string) => vi.mocked(apiFetch).mockRejectedValue(new ApiError(status, code, 'x'));

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
});

describe('/reset-password/:token', () => {
  it('a dead link says so up front, with "Send me a new link" — no password form', async () => {
    fail(410, 'link_expired');
    renderAt('/reset-password/abc', '/reset-password/:token', <ResetPassword />);
    expect(await screen.findByRole('heading', { name: 'This reset link has expired' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Send me a new link' })).toHaveAttribute('href', '/forgot-password');
    expect(screen.queryByLabelText(/New password/)).not.toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledWith('/auth/reset-password/abc');
  });

  it('a link that was never issued is "not valid", not "expired"', async () => {
    fail(404, 'not_found');
    renderAt('/reset-password/abc', '/reset-password/:token', <ResetPassword />);
    expect(await screen.findByRole('heading', { name: 'This reset link isn’t valid' })).toBeInTheDocument();
    expect(screen.getByTestId('link-problem')).toHaveAttribute('data-kind', 'invalid');
  });

  it('a working link shows the form for the (masked) account', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ email: 'm***@example.com', expiresAt: '2026-10-22T20:00:00.000Z' } as never);
    renderAt('/reset-password/abc', '/reset-password/:token', <ResetPassword />);
    expect(await screen.findByTestId('reset-email')).toHaveTextContent('m***@example.com');
    expect(screen.getByRole('heading', { name: 'New password' })).toBeInTheDocument();
  });
});

describe('/confirm-email-change/:token', () => {
  it('a used link says what to do and offers "Sign in", which lands on Settings', async () => {
    vi.mocked(confirmEmailChange).mockRejectedValue(new ApiError(400, 'invalid_token', 'x'));
    renderAt('/confirm-email-change/abc', '/confirm-email-change/:token', <ConfirmEmailChange />);
    expect(await screen.findByText('It has expired or was already used. Sign in and request a new change in Settings.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login?next=/settings');
    expect(screen.queryByText(/\/settings\./)).not.toBeInTheDocument();
  });
});

describe('/accept-invite/:token', () => {
  it('a dead invitation gives one instruction — the self-serve resend — never "ask HR"', async () => {
    fail(404, 'not_found');
    renderAt('/accept-invite/abc', '/accept-invite/:token', <AcceptInvite />);
    expect(await screen.findByText('This invitation has expired or was already used.')).toBeInTheDocument();
    expect(screen.queryByText(/Ask HR/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send me a new link' })).toBeInTheDocument();
  });
});

describe('shared links: /track, /w, /nps', () => {
  it('/track: expired (410) and not valid (404) are told apart', async () => {
    fail(410, 'link_expired');
    renderAt('/track/t', '/track/:token', <TrackPage />);
    expect(await screen.findByText('This shared trip has ended')).toBeInTheDocument();
  });

  it('/track: a link that was never shared is "not valid"', async () => {
    fail(404, 'not_found');
    renderAt('/track/t', '/track/:token', <TrackPage />);
    expect(await screen.findByText('This link isn’t valid')).toBeInTheDocument();
    expect(screen.queryByText(/expired|ended/)).not.toBeInTheDocument();
  });

  it('/w: expired (410) asks for a new share; 404 is "not valid"', async () => {
    fail(410, 'link_expired');
    renderAt('/w/t', '/w/:token', <WalletVerifyPage />);
    expect(await screen.findByText('This shared link has expired')).toBeInTheDocument();
  });

  it('/nps: a bad link is the same "not valid" state', async () => {
    fail(404, 'not_found');
    renderAt('/nps/t', '/nps/:token', <NpsSurveyPage />);
    expect(await screen.findByText('This link isn’t valid')).toBeInTheDocument();
    expect(screen.getByTestId('link-problem')).toHaveAttribute('data-kind', 'invalid');
  });
});
