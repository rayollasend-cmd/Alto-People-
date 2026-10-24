import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { AuthUser } from '@alto-people/shared';

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), loading: vi.fn(), dismiss: vi.fn() }),
}));

import { ApiError, NetworkError, TimeoutError } from '@/lib/api';
import { resetSessionEventsForTest } from '@/lib/sessionEvents';
import { saveOfflineSession, readOfflineSession } from '@/lib/offlineSession';
import { AuthProvider, PROBE_RETRY, PROBE_SPLASH_ATTEMPTS, RequireAuth, isServerSilence, probeRetryDelayMs, useAuth } from '@/lib/auth';

/**
 * A brief server error during the session check is not a logout.
 *
 * Any 5xx on /auth/me — a deploy, a gateway blip, a crashed process — used
 * to fall to the "else" branch that cleared the user and showed /login to
 * every tablet that reloaded (role walk floor 2, ops 3, HR 24). Only a
 * 401 ends a session; silence keeps it, shows "reconnecting", and retries.
 */

const dana: AuthUser = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'dana@altohr.com',
  role: 'SHIFT_SUPERVISOR',
  status: 'ACTIVE',
  clientId: 'c1',
  clientName: 'Coastal',
  associateId: null,
  firstName: 'Dana',
  lastName: 'Reyes',
  photoUrl: null,
  timezone: null,
  mfaEnabled: false,
};

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let meScript: Array<() => Response | Promise<Response>>;
let meCalls = 0;

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/auth/me') {
        meCalls += 1;
        const handler = meScript.length > 1 ? meScript.shift()! : meScript[0];
        return handler();
      }
      return jsonResponse(404, {});
    }),
  );
}

function Probe() {
  const { user, isOffline } = useAuth();
  return (
    <div>
      <div data-testid="email">{user?.email ?? 'none'}</div>
      <div data-testid="offline">{isOffline ? 'offline' : 'online'}</div>
    </div>
  );
}

function renderApp() {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={['/today']}>
        {/* Outside the gate, so the session is readable whichever page is up. */}
        <Probe />
        <Routes>
          <Route path="/login" element={<div data-testid="login">login</div>} />
          <Route
            path="*"
            element={
              <RequireAuth>
                <div data-testid="inside">inside</div>
              </RequireAuth>
            }
          />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

beforeEach(() => {
  resetSessionEventsForTest();
  vi.clearAllMocks();
  localStorage.clear();
  meCalls = 0;
  // The real schedule is 2s/4s/8s…; run it in milliseconds here.
  PROBE_RETRY.baseMs = 5;
  PROBE_RETRY.maxMs = 20;
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  PROBE_RETRY.baseMs = 2_000;
  PROBE_RETRY.maxMs = 30_000;
});

describe('isServerSilence', () => {
  it('is a 5xx, a timeout or no network — never a 401 or another 4xx', () => {
    expect(isServerSilence(new ApiError(502, 'bad_gateway', 'Bad gateway'))).toBe(true);
    expect(isServerSilence(new ApiError(503, 'unavailable', 'Unavailable'))).toBe(true);
    expect(isServerSilence(new ApiError(500, 'internal', 'Boom'))).toBe(true);
    expect(isServerSilence(new NetworkError(new Error('offline')))).toBe(true);
    expect(isServerSilence(new TimeoutError())).toBe(true);
    expect(isServerSilence(new ApiError(401, 'unauthenticated', 'Session expired'))).toBe(false);
    expect(isServerSilence(new ApiError(403, 'forbidden', 'No'))).toBe(false);
    expect(isServerSilence(new Error('other'))).toBe(false);
  });

  it('backs off 2s, 4s, 8s, 16s and then holds at 30s', () => {
    PROBE_RETRY.baseMs = 2_000;
    PROBE_RETRY.maxMs = 30_000;
    expect([1, 2, 3, 4, 5, 9].map(probeRetryDelayMs)).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
  });
});

describe('AuthProvider when the server does not answer /auth/me', () => {
  it('a 503 keeps the remembered session, shows reconnecting, and a later 200 brings the session back online', async () => {
    saveOfflineSession(dana);
    // The server comes back only when the test says so: with the retries in
    // milliseconds, a busy CI runner otherwise reached the 200 before the
    // "reconnecting" state below was read (it read "online").
    let serverBack!: () => void;
    const back = new Promise<void>((resolve) => {
      serverBack = resolve;
    });
    meScript = [
      () => jsonResponse(503, { error: { code: 'unavailable', message: 'Service Unavailable' } }),
      () => jsonResponse(502, { error: { code: 'bad_gateway', message: 'Bad Gateway' } }),
      () => back.then(() => jsonResponse(200, { user: dana })),
    ];
    renderApp();

    // Still signed in — the floor tablet never saw /login.
    await waitFor(() => expect(screen.getByTestId('email')).toHaveTextContent('dana@altohr.com'));
    expect(await screen.findByTestId('inside')).toBeInTheDocument();
    expect(screen.getByTestId('offline')).toHaveTextContent('offline');
    expect(screen.queryByTestId('login')).not.toBeInTheDocument();

    // The probe retried on its own until the server answered.
    await waitFor(() => expect(meCalls).toBeGreaterThanOrEqual(3), { timeout: 4_000 });
    expect(screen.getByTestId('offline')).toHaveTextContent('offline');
    serverBack();
    await waitFor(() => expect(screen.getByTestId('offline')).toHaveTextContent('online'));
    expect(screen.getByTestId('email')).toHaveTextContent('dana@altohr.com');
    expect(screen.queryByTestId('login')).not.toBeInTheDocument();
  });

  it('a 500 with nothing remembered holds the splash through the first retries, then shows sign-in; a later 200 still lands the session', async () => {
    meScript = [
      ...Array.from({ length: PROBE_SPLASH_ATTEMPTS + 2 }, () => () => jsonResponse(500, { error: { code: 'internal', message: 'Boom' } })),
      () => jsonResponse(200, { user: dana }),
    ];
    renderApp();

    // Splash, not /login, while the server is silent.
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    expect(screen.queryByTestId('login')).not.toBeInTheDocument();

    // After the held attempts the honest screen is sign-in…
    expect(await screen.findByTestId('login', undefined, { timeout: 4_000 })).toBeInTheDocument();
    // …and the retries keep going: when the server comes back, so does the session.
    await waitFor(() => expect(screen.getByTestId('email')).toHaveTextContent('dana@altohr.com'), { timeout: 4_000 });
  });

  it('a 401 is the one answer that signs out — and clears the remembered identity', async () => {
    saveOfflineSession(dana);
    meScript = [() => jsonResponse(401, { error: { code: 'unauthenticated', message: 'Session expired' } })];
    renderApp();

    expect(await screen.findByTestId('login')).toBeInTheDocument();
    expect(readOfflineSession()).toBeNull();
    expect(meCalls).toBe(1);
  });

  it('a network failure behaves like a 5xx: the session stays and the probe retries', async () => {
    saveOfflineSession(dana);
    meScript = [
      () => {
        throw new TypeError('Failed to fetch');
      },
      () => jsonResponse(200, { user: dana }),
    ];
    renderApp();

    await waitFor(() => expect(screen.getByTestId('email')).toHaveTextContent('dana@altohr.com'));
    expect(await screen.findByTestId('inside')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('offline')).toHaveTextContent('online'), { timeout: 4_000 });
    expect(screen.queryByTestId('login')).not.toBeInTheDocument();
  });
});
