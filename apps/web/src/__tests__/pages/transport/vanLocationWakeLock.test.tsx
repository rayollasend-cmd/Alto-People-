import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

vi.mock('@/lib/transportApi', () => ({ sendVanLocation: vi.fn(() => Promise.resolve()) }));
vi.mock('@/lib/driverPosition', () => ({ rememberDriverFix: vi.fn() }));

import { useShareVanLocation } from '@/pages/transport/driver/vanLocation';

/**
 * CODE-29 (deep audit 2026-10-29): the screen wake lock is requested when the
 * run goes on the road. A lock that arrives after the driver has left the
 * screen (the run ended, the page unmounted) was never released, so the
 * phone stayed awake with nobody holding it.
 */

const nav = navigator as Navigator & { wakeLock?: unknown; geolocation?: unknown };
const original = { wakeLock: nav.wakeLock, geolocation: nav.geolocation };

afterEach(() => {
  Object.defineProperty(navigator, 'wakeLock', { value: original.wakeLock, configurable: true });
  Object.defineProperty(navigator, 'geolocation', { value: original.geolocation, configurable: true });
});

function fakeDevice() {
  let grant: ((l: { release: () => Promise<void> }) => void) | null = null;
  const release = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, 'wakeLock', {
    value: { request: vi.fn(() => new Promise((res) => (grant = res))) },
    configurable: true,
  });
  Object.defineProperty(navigator, 'geolocation', {
    value: { watchPosition: vi.fn(() => 7), clearWatch: vi.fn() },
    configurable: true,
  });
  return { release, grant: () => grant!({ release }) };
}

describe('useShareVanLocation — the screen lock', () => {
  it('releases a lock that arrives after the screen was left', async () => {
    const device = fakeDevice();
    const { unmount } = renderHook(() => useShareVanLocation('run-1', true));
    unmount();
    device.grant();
    await Promise.resolve();
    await Promise.resolve();
    expect(device.release).toHaveBeenCalledTimes(1);
  });

  it('holds a lock while on the road and releases it on leaving', async () => {
    const device = fakeDevice();
    const { unmount } = renderHook(() => useShareVanLocation('run-1', true));
    device.grant();
    await Promise.resolve();
    await Promise.resolve();
    expect(device.release).not.toHaveBeenCalled();
    unmount();
    expect(device.release).toHaveBeenCalledTimes(1);
  });
});
