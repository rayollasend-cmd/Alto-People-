import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, NetworkError, TimeoutError, apiFetch } from '@/lib/api';
import {
  emitApiConnectivity,
  isAuthFlowPath,
  onApiAuthFailure,
  onApiConnectivity,
  resetSessionEventsForTest,
} from '@/lib/sessionEvents';

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const unauthorizedBody = {
  error: { code: 'unauthenticated', message: 'Session expired' },
};

beforeEach(() => {
  resetSessionEventsForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('apiFetch → session events', () => {
  it('emits authFailure with the request path on a 401 from a non-auth endpoint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(401, unauthorizedBody)),
    );
    const onFailure = vi.fn();
    onApiAuthFailure(onFailure);

    await expect(apiFetch('/payroll/runs')).rejects.toBeInstanceOf(ApiError);

    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith('/payroll/runs');
  });

  it('does NOT emit authFailure for auth-flow endpoints (401 = wrong credentials)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(401, unauthorizedBody)),
    );
    const onFailure = vi.fn();
    onApiAuthFailure(onFailure);

    for (const path of [
      '/auth/login',
      '/auth/mfa-challenge',
      '/auth/reset-password',
      '/auth/accept-invite',
      '/auth/invite/renew',
      '/auth/webauthn/login/verify',
      '/auth/oidc/config',
      '/auth/logout',
    ]) {
      await expect(apiFetch(path, { method: 'POST' })).rejects.toBeInstanceOf(
        ApiError,
      );
    }

    expect(onFailure).not.toHaveBeenCalled();
  });

  it('does not emit authFailure on non-401 errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(403, { error: { code: 'forbidden' } })),
    );
    const onFailure = vi.fn();
    onApiAuthFailure(onFailure);

    await expect(apiFetch('/payroll/runs')).rejects.toBeInstanceOf(ApiError);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('emits offline on NetworkError, then online on the next successful response', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const onConnectivity = vi.fn();
    onApiConnectivity(onConnectivity);

    await expect(apiFetch('/time/entries')).rejects.toBeInstanceOf(NetworkError);
    expect(onConnectivity).toHaveBeenCalledWith('offline');

    await apiFetch('/time/entries');
    expect(onConnectivity).toHaveBeenLastCalledWith('online');
    expect(onConnectivity).toHaveBeenCalledTimes(2);
  });

  it('dedupes repeated transitions — two failures emit a single offline event', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
    );
    const onConnectivity = vi.fn();
    onApiConnectivity(onConnectivity);

    await expect(apiFetch('/a')).rejects.toBeInstanceOf(NetworkError);
    await expect(apiFetch('/b')).rejects.toBeInstanceOf(NetworkError);

    expect(onConnectivity).toHaveBeenCalledTimes(1);
    expect(onConnectivity).toHaveBeenCalledWith('offline');
  });

  it('a 401 (any received response) also counts as online again', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(jsonResponse(401, unauthorizedBody));
    vi.stubGlobal('fetch', fetchMock);
    const onConnectivity = vi.fn();
    onApiConnectivity(onConnectivity);

    await expect(apiFetch('/a')).rejects.toBeInstanceOf(NetworkError);
    await expect(apiFetch('/auth/login', { method: 'POST' })).rejects.toBeInstanceOf(
      ApiError,
    );

    expect(onConnectivity).toHaveBeenNthCalledWith(1, 'offline');
    expect(onConnectivity).toHaveBeenNthCalledWith(2, 'online');
  });

  it('emits offline on our own timeout (TimeoutError)', async () => {
    // Never resolves; rejects only when the request's own timeout aborts it.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            );
          }),
      ),
    );
    const onConnectivity = vi.fn();
    onApiConnectivity(onConnectivity);

    await expect(apiFetch('/slow', { timeoutMs: 10 })).rejects.toBeInstanceOf(
      TimeoutError,
    );
    expect(onConnectivity).toHaveBeenCalledWith('offline');
  });

  it('does NOT emit offline when the CALLER aborts (unmount/superseded query)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            );
          }),
      ),
    );
    const onConnectivity = vi.fn();
    onApiConnectivity(onConnectivity);

    const ac = new AbortController();
    const pending = apiFetch('/list', { signal: ac.signal });
    ac.abort();
    await expect(pending).rejects.toBeInstanceOf(NetworkError);

    expect(onConnectivity).not.toHaveBeenCalled();
  });

  it('unsubscribe stops delivery; emit helper respects it', () => {
    const cb = vi.fn();
    const unsubscribe = onApiConnectivity(cb);
    emitApiConnectivity('offline');
    expect(cb).toHaveBeenCalledTimes(1);
    unsubscribe();
    emitApiConnectivity('online');
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('isAuthFlowPath', () => {
  it('classifies the derived auth-flow list and nothing else', () => {
    expect(isAuthFlowPath('/auth/login')).toBe(true);
    expect(isAuthFlowPath('auth/login')).toBe(true); // no-leading-slash form
    expect(isAuthFlowPath('/auth/forgot-password')).toBe(true);
    expect(isAuthFlowPath('/auth/email-change/confirm')).toBe(true);
    // Session-backed endpoints must stay eligible for authFailure:
    expect(isAuthFlowPath('/auth/me')).toBe(false);
    expect(isAuthFlowPath('/auth/me/profile')).toBe(false);
    expect(isAuthFlowPath('/auth/change-password')).toBe(false);
    expect(isAuthFlowPath('/auth/me/mfa/enroll/start')).toBe(false);
    expect(isAuthFlowPath('/payroll/runs')).toBe(false);
  });
});
