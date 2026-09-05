import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { AuthUser } from '@alto-people/shared';

// Mock BEFORE importing auth.tsx (which imports { toast } from 'sonner').
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    error: vi.fn(),
    success: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  }),
}));

import { toast } from 'sonner';
import { apiFetch } from '@/lib/api';
import {
  emitApiConnectivity,
  resetSessionEventsForTest,
} from '@/lib/sessionEvents';
import { AuthProvider, OFFLINE_GRACE_MS, RequireAuth, useAuth } from '@/lib/auth';

const adminUser: AuthUser = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'admin@altohr.com',
  role: 'HR_ADMINISTRATOR',
  status: 'ACTIVE',
  clientId: null,
  clientName: null,
  associateId: null,
  firstName: 'Ada',
  lastName: 'Admin',
  photoUrl: null,
  timezone: null,
  mfaEnabled: false,
};

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const unauthorizedBody = {
  error: { code: 'unauthenticated', message: 'Session expired' },
};

/**
 * Scripted /auth/me responses: the first render consumes one (the initial
 * probe), each session-death re-probe consumes the next. The last entry
 * repeats once the script runs out.
 */
let meScript: Array<() => Response>;

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/auth/me') {
        const handler = meScript.length > 1 ? meScript.shift()! : meScript[0];
        return handler();
      }
      // Any non-auth business endpoint: the session is dead server-side.
      return jsonResponse(401, unauthorizedBody);
    }),
  );
}

function SessionProbe() {
  const { user, role, isOffline, can } = useAuth();
  return (
    <div>
      <div data-testid="email">{user?.email ?? 'none'}</div>
      <div data-testid="role">{role ?? 'none'}</div>
      <div data-testid="offline">{isOffline ? 'offline' : 'online'}</div>
      <div data-testid="can-payroll">{can('process:payroll') ? 'yes' : 'no'}</div>
    </div>
  );
}

function LoginProbe() {
  const location = useLocation();
  const state = location.state as { from?: string } | null;
  return <div data-testid="login">next={state?.from ?? 'none'}</div>;
}

function renderApp(initialPath = '/payroll') {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/login" element={<LoginProbe />} />
          <Route
            path="*"
            element={
              <RequireAuth>
                <SessionProbe />
              </RequireAuth>
            }
          />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

/** Fire a business request whose 401 emits the app-wide authFailure. */
async function failBusinessRequest(path = '/payroll/runs') {
  await act(async () => {
    await apiFetch(path).catch(() => {});
  });
}

beforeEach(() => {
  // Reset the bus BEFORE render so each test's provider subscribes fresh.
  resetSessionEventsForTest();
  vi.clearAllMocks();
  meScript = [() => jsonResponse(200, { user: adminUser })];
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AuthProvider session death', () => {
  it('clears the user after a double 401 and redirects to /login preserving next', async () => {
    meScript = [
      () => jsonResponse(200, { user: adminUser }),
      () => jsonResponse(401, unauthorizedBody), // the confirming re-probe
    ];
    renderApp('/payroll');

    expect(await screen.findByTestId('email')).toHaveTextContent(
      'admin@altohr.com',
    );

    await failBusinessRequest('/payroll/runs');

    // RequireAuth bounced to /login with the prior location in state.from.
    // Generous timeout: the 401 → confirming re-probe → state update →
    // redirect chain is eventually-consistent by design. 12s inside the
    // 15s budget — the earlier 5s inner window still expired on loaded CI
    // runners (2026-09-05: chain took >5s under parallel suite load).
    expect(
      await screen.findByTestId('login', undefined, { timeout: 12_000 }),
    ).toHaveTextContent('next=/payroll');
    // The 15s third arg raises the per-test budget above the inner wait —
    // vitest's default 5s outer timeout used to fire first and mask the
    // real assertion.
  }, 15_000);

  it('shows the session-ended toast exactly once, not once per failed request', async () => {
    meScript = [
      () => jsonResponse(200, { user: adminUser }),
      () => jsonResponse(401, unauthorizedBody),
    ];
    renderApp();

    await screen.findByTestId('email');

    // A page's worth of parallel queries all 401ing.
    await failBusinessRequest('/payroll/runs');
    await failBusinessRequest('/time/entries');
    await failBusinessRequest('/scheduling/shifts');

    await screen.findByTestId('login', undefined, { timeout: 12_000 });
    expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.error).mock.calls[0][0]).toMatch(
      /session ended/i,
    );
    // Same inner-vs-outer timeout headroom as the redirect test above.
  }, 15_000);

  it('keeps the session when the re-probe succeeds (one-off 401)', async () => {
    meScript = [
      () => jsonResponse(200, { user: adminUser }),
      () => jsonResponse(200, { user: adminUser }), // re-probe: still alive
    ];
    renderApp();

    await screen.findByTestId('email');
    await failBusinessRequest('/payroll/runs');

    // Still signed in, no toast, no redirect.
    await waitFor(() =>
      expect(screen.getByTestId('email')).toHaveTextContent('admin@altohr.com'),
    );
    expect(screen.queryByTestId('login')).not.toBeInTheDocument();
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
  });

  it('updates role/capabilities in place when the re-probe returns a changed role', async () => {
    meScript = [
      () => jsonResponse(200, { user: adminUser }),
      () =>
        jsonResponse(200, {
          user: { ...adminUser, role: 'ASSOCIATE' }, // admin demoted the account
        }),
    ];
    renderApp();

    await screen.findByTestId('email');
    expect(screen.getByTestId('role')).toHaveTextContent('HR_ADMINISTRATOR');
    expect(screen.getByTestId('can-payroll')).toHaveTextContent('yes');

    await failBusinessRequest('/payroll/runs');

    await waitFor(() =>
      expect(screen.getByTestId('role')).toHaveTextContent('ASSOCIATE'),
    );
    expect(screen.getByTestId('can-payroll')).toHaveTextContent('no');
    // Session survived — no logout, no toast.
    expect(screen.queryByTestId('login')).not.toBeInTheDocument();
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
  });
});

describe('AuthProvider connectivity', () => {
  it('drives isOffline from mid-session connectivity events, debounced', async () => {
    renderApp();
    await screen.findByTestId('email');
    expect(screen.getByTestId('offline')).toHaveTextContent('online');

    act(() => {
      emitApiConnectivity('offline');
    });
    // Debounced: does NOT flip immediately…
    expect(screen.getByTestId('offline')).toHaveTextContent('online');

    // …only after the grace window with no success in between.
    await act(async () => {
      await new Promise((r) => setTimeout(r, OFFLINE_GRACE_MS + 100));
    });
    expect(screen.getByTestId('offline')).toHaveTextContent('offline');

    // A success clears it immediately.
    act(() => {
      emitApiConnectivity('online');
    });
    expect(screen.getByTestId('offline')).toHaveTextContent('online');
  });

  it('never shows the pill for a blip that recovers within the grace window', async () => {
    renderApp();
    await screen.findByTestId('email');

    act(() => {
      emitApiConnectivity('offline');
    });
    act(() => {
      emitApiConnectivity('online'); // success lands before the timer fires
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, OFFLINE_GRACE_MS + 100));
    });
    expect(screen.getByTestId('offline')).toHaveTextContent('online');
  });
});
