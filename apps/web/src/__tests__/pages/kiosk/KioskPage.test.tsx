import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// The page polls /health/version through apiFetch — keep ApiError real
// (the error handlers branch on instanceof) but stub the fetch itself.
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, apiFetch: vi.fn().mockResolvedValue({ version: 'test' }) };
});

vi.mock('@/lib/kiosk99Api', () => ({
  kioskConfig: vi.fn().mockResolvedValue({ geofenceRequired: false, tokenExpiresAt: null }),
  kioskVerifyPin: vi.fn(),
  kioskPunch: vi.fn(),
  kioskFaceConsent: vi.fn().mockResolvedValue({ ok: true, status: 'GRANTED' }),
  kioskAttachFace: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock('@/lib/faceMatch', () => ({
  loadFaceModels: vi.fn().mockResolvedValue(undefined),
  getFaceModelsState: vi.fn(() => 'ready'),
  onFaceModelsStateChange: vi.fn(() => () => {}),
  extractDescriptor: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/kioskQueue', () => ({
  drainQueue: vi.fn().mockResolvedValue({ synced: 0, remaining: 0, errors: 0 }),
  enqueuePunch: vi.fn(),
  newIdempotencyKey: vi.fn(() => 'test-key'),
  queueSize: vi.fn(() => 0),
}));

vi.mock('@/lib/confirm', () => ({
  useConfirm: () => vi.fn(async () => true),
  usePrompt: () => vi.fn(async () => ''),
}));

import { ApiError } from '@/lib/api';
import { kioskVerifyPin, kioskPunch, kioskFaceConsent } from '@/lib/kiosk99Api';
import { enqueuePunch } from '@/lib/kioskQueue';
import { KioskPage } from '@/pages/kiosk/KioskPage';

const VERIFY_OK = {
  ok: true as const,
  associateFirstName: 'Maria',
  predictedAction: 'CLOCK_IN' as const,
  faceConsent: 'DECLINED' as const, // PIN-only path: no camera in jsdom
};

const PUNCH_OK = {
  action: 'CLOCK_IN' as const,
  associateName: 'Maria Lopez',
  at: '2026-06-11T12:00:00.000Z',
  punchId: 'p1',
};

async function typePin(user: ReturnType<typeof userEvent.setup>) {
  // Idle → keypad → 4 digits (auto-advances 150ms after the 4th).
  await user.click(await screen.findByRole('button', { name: /tap to clock/i }));
  for (const d of ['1', '2', '3', '4']) {
    await user.click(screen.getByRole('button', { name: d }));
  }
}

beforeEach(() => {
  vi.mocked(kioskVerifyPin).mockReset();
  vi.mocked(kioskPunch).mockReset();
  vi.mocked(kioskFaceConsent).mockClear();
  vi.mocked(enqueuePunch).mockClear();
  window.localStorage.setItem('alto.kiosk.deviceToken', 'altokiosk_testtoken');
  window.localStorage.removeItem('alto.kiosk.lang');
});

describe('<KioskPage> punch flow', () => {
  it('happy path: PIN → verify → punch → personalized result', async () => {
    vi.mocked(kioskVerifyPin).mockResolvedValue(VERIFY_OK);
    vi.mocked(kioskPunch).mockResolvedValue(PUNCH_OK);

    const user = userEvent.setup();
    render(<KioskPage />);
    await typePin(user);

    expect(await screen.findByText('Clocked in')).toBeInTheDocument();
    expect(screen.getByText(/Welcome, Maria/)).toBeInTheDocument();
    expect(kioskVerifyPin).toHaveBeenCalledTimes(1);
    expect(kioskPunch).toHaveBeenCalledTimes(1);
    // DECLINED consent → PIN-only punch, never a selfie payload.
    expect(vi.mocked(kioskPunch).mock.calls[0]![0]).toMatchObject({
      pin: '1234',
      selfie: null,
    });
  });

  it('REGRESSION: an error that keeps the PIN does not auto-resubmit (no verify loop)', async () => {
    // The not_clocked_in path keeps the typed PIN on screen. The
    // auto-advance effect used to re-arm on every render and hammer
    // verify-pin 1-2×/sec forever.
    vi.mocked(kioskVerifyPin).mockRejectedValue(
      new ApiError(409, 'not_clocked_in', 'You need to clock in before starting a break.'),
    );

    const user = userEvent.setup();
    render(<KioskPage />);
    await typePin(user);

    expect(
      await screen.findByText(/turn off break to clock in/i),
    ).toBeInTheDocument();
    expect(kioskVerifyPin).toHaveBeenCalledTimes(1);

    // Give a would-be loop generous time to betray itself.
    await new Promise((r) => setTimeout(r, 600));
    expect(kioskVerifyPin).toHaveBeenCalledTimes(1);

    // The kept PIN retries through the explicit button only.
    await user.click(screen.getByRole('button', { name: /try again/i }));
    await waitFor(() => expect(kioskVerifyPin).toHaveBeenCalledTimes(2));
  });

  it('wrong PIN clears the dots and a fresh PIN auto-submits again', async () => {
    vi.mocked(kioskVerifyPin)
      .mockRejectedValueOnce(new ApiError(401, 'invalid_pin', 'Wrong PIN.'))
      .mockResolvedValue(VERIFY_OK);
    vi.mocked(kioskPunch).mockResolvedValue(PUNCH_OK);

    const user = userEvent.setup();
    render(<KioskPage />);
    await typePin(user);

    expect(await screen.findByText(/wrong pin/i)).toBeInTheDocument();

    // PIN was cleared — typing 4 fresh digits auto-advances again.
    for (const d of ['5', '6', '7', '8']) {
      await user.click(screen.getByRole('button', { name: d }));
    }
    expect(await screen.findByText('Clocked in')).toBeInTheDocument();
    expect(kioskVerifyPin).toHaveBeenCalledTimes(2);
  });

  it('first punch asks for consent; declining records it and punches PIN-only', async () => {
    vi.mocked(kioskVerifyPin).mockResolvedValue({
      ...VERIFY_OK,
      faceConsent: null, // never asked
    });
    vi.mocked(kioskPunch).mockResolvedValue(PUNCH_OK);

    const user = userEvent.setup();
    render(<KioskPage />);
    await typePin(user);

    expect(await screen.findByText(/quick question/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /no thanks/i }));

    expect(await screen.findByText('Clocked in')).toBeInTheDocument();
    expect(kioskFaceConsent).toHaveBeenCalledWith(
      expect.objectContaining({ consent: false, pin: '1234' }),
    );
    expect(kioskPunch).toHaveBeenCalledTimes(1);
  });

  it('agreeing to consent opens the camera path; jsdom has no camera → skip still punches', async () => {
    vi.mocked(kioskVerifyPin).mockResolvedValue({
      ...VERIFY_OK,
      faceConsent: null,
    });
    vi.mocked(kioskPunch).mockResolvedValue(PUNCH_OK);

    const user = userEvent.setup();
    render(<KioskPage />);
    await typePin(user);

    await user.click(
      await screen.findByRole('button', { name: /use photo verification/i }),
    );
    // No mediaDevices in jsdom → "Camera unavailable" fallback.
    await user.click(
      await screen.findByRole('button', { name: /continue without selfie/i }),
    );
    expect(await screen.findByText('Clocked in')).toBeInTheDocument();
  });

  it('network failure on verify AND punch lands in the offline queue', async () => {
    vi.mocked(kioskVerifyPin).mockRejectedValue(new Error('network down'));
    vi.mocked(kioskPunch).mockRejectedValue(new Error('network down'));

    const user = userEvent.setup();
    render(<KioskPage />);
    await typePin(user);

    // Verify failed (non-ApiError) → camera fallback → skip → punch
    // fails too → queued.
    await user.click(
      await screen.findByRole('button', { name: /continue without selfie/i }),
    );
    expect(await screen.findByText(/saved offline/i)).toBeInTheDocument();
    expect(enqueuePunch).toHaveBeenCalledTimes(1);
  });

  it('language toggle switches the kiosk to Spanish and persists', async () => {
    const user = userEvent.setup();
    render(<KioskPage />);

    await user.click(await screen.findByRole('button', { name: 'Español' }));
    expect(
      await screen.findByText(/toca para marcar entrada/i),
    ).toBeInTheDocument();
    expect(window.localStorage.getItem('alto.kiosk.lang')).toBe('es');
  });
});
