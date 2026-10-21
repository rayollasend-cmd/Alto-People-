import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

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
  kioskSubmitSop: vi.fn(),
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
  droppedCount: vi.fn(() => 0),
  clearDroppedCount: vi.fn(),
}));

vi.mock('@/lib/confirm', () => ({
  useConfirm: () => vi.fn(async () => true),
  usePrompt: () => vi.fn(async () => ''),
}));

import { ApiError } from '@/lib/api';
import { kioskVerifyPin, kioskPunch, kioskFaceConsent, kioskSubmitSop } from '@/lib/kiosk99Api';
import { enqueuePunch } from '@/lib/kioskQueue';
import { KioskPage } from '@/pages/kiosk/KioskPage';

// The page reads its device config through the query layer.
function renderKiosk() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <KioskPage />
    </QueryClientProvider>,
  );
}

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

/** The who-is-this step: "Maria L. — Clock in?" (it also confirms itself after 3s). */
async function confirmMe(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /yes, that’s me/i }));
}

beforeEach(() => {
  vi.mocked(kioskSubmitSop).mockReset();
  vi.mocked(kioskVerifyPin).mockReset();
  vi.mocked(kioskPunch).mockReset();
  vi.mocked(kioskFaceConsent).mockClear();
  vi.mocked(enqueuePunch).mockClear();
  window.localStorage.setItem('alto.kiosk.deviceToken', 'altokiosk_testtoken');
  window.localStorage.removeItem('alto.kiosk.lang');
  // The offline consent cache persists in localStorage; without this, a
  // consent recorded by one test leaks into the next and silently changes
  // which screen the offline fallback lands on (camera vs PIN-only).
  window.localStorage.removeItem('alto.kiosk.consent.v1');
  window.localStorage.removeItem('alto.kiosk.dropped.v1');
});

describe('<KioskPage> punch flow', () => {
  it('happy path: PIN → verify → punch → personalized result', async () => {
    vi.mocked(kioskVerifyPin).mockResolvedValue(VERIFY_OK);
    vi.mocked(kioskPunch).mockResolvedValue(PUNCH_OK);

    const user = userEvent.setup();
    renderKiosk();
    await typePin(user);
    await confirmMe(user);

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
    renderKiosk();
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
    renderKiosk();
    await typePin(user);

    // The credential is the "clock-in number" everywhere — never "PIN".
    expect(await screen.findByText(/wrong clock-in number/i)).toBeInTheDocument();
    expect(screen.queryByText(/\bPIN\b/)).not.toBeInTheDocument();

    // PIN was cleared — typing 4 fresh digits auto-advances again.
    for (const d of ['5', '6', '7', '8']) {
      await user.click(screen.getByRole('button', { name: d }));
    }
    await confirmMe(user);
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
    renderKiosk();
    await typePin(user);
    await confirmMe(user);

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
    renderKiosk();
    await typePin(user);
    await confirmMe(user);

    await user.click(
      await screen.findByRole('button', { name: /use photo verification/i }),
    );
    // No mediaDevices in jsdom → "Camera unavailable" fallback. Wait for
    // the error state before clicking — the normal camera screen also has
    // a skip button, and clicking it mid-swap hits a detached node.
    expect(await screen.findByText(/camera unavailable/i)).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: /continue without selfie/i }),
    );
    expect(await screen.findByText('Clocked in')).toBeInTheDocument();
  });

  it('a required photo: straight to the camera even after declining face matching, no skip — a dead camera punches flagged', async () => {
    vi.mocked(kioskVerifyPin).mockResolvedValue({
      ...VERIFY_OK,
      faceConsent: 'DECLINED',
      photoRequired: true,
      photoNotice: 'A photo is required at each of your punches.',
    });
    vi.mocked(kioskPunch).mockResolvedValue(PUNCH_OK);

    const user = userEvent.setup();
    renderKiosk();
    await typePin(user);
    await confirmMe(user);

    // Declined face matching used to mean PIN-only; a required photo opens the camera anyway.
    // jsdom has no camera, so this lands on the camera-unavailable screen — whose only way
    // through is a flagged punch, never "continue without selfie".
    expect(await screen.findByText(/camera unavailable/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /continue without selfie/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /punch without a photo — a supervisor will confirm/i }));
    expect(await screen.findByText('Clocked in')).toBeInTheDocument();
    expect(vi.mocked(kioskPunch).mock.calls[0]![0]).toMatchObject({ selfie: null, photoPolicyAware: true, photoUnavailable: true });
  });

  it('without a rule every punch says it knows about required photos, and claims no broken camera', async () => {
    vi.mocked(kioskVerifyPin).mockResolvedValue(VERIFY_OK);
    vi.mocked(kioskPunch).mockResolvedValue(PUNCH_OK);
    const user = userEvent.setup();
    renderKiosk();
    await typePin(user);
    await confirmMe(user);
    expect(await screen.findByText('Clocked in')).toBeInTheDocument();
    expect(vi.mocked(kioskPunch).mock.calls[0]![0]).toMatchObject({ photoPolicyAware: true, photoUnavailable: false });
  });

  it('network failure on verify AND punch lands in the offline queue — no camera without known consent', async () => {
    vi.mocked(kioskVerifyPin).mockRejectedValue(new Error('network down'));
    vi.mocked(kioskPunch).mockRejectedValue(new Error('network down'));

    const user = userEvent.setup();
    renderKiosk();
    await typePin(user);

    // Verify failed (non-ApiError) → offline fallback. The kiosk can't ask
    // the server for consent and has none cached for this PIN, so it must
    // NOT open the camera — capture is the consent-relevant act, and this
    // path used to photograph associates who'd never been shown the
    // consent screen. Straight to a queued PIN-only punch instead.
    expect(await screen.findByText(/saved offline/i)).toBeInTheDocument();
    expect(screen.queryByText(/camera unavailable/i)).not.toBeInTheDocument();
    expect(enqueuePunch).toHaveBeenCalledTimes(1);
    // The queued punch carries no photo.
    expect(vi.mocked(enqueuePunch).mock.calls[0][0].selfie).toBeNull();
  });

  it('offline fallback still offers the camera when this PIN previously consented', async () => {
    // Cache a GRANTED consent the way a prior ONLINE punch would have.
    const { rememberConsent } = await import('@/lib/kioskConsentCache');
    await rememberConsent('1234', 'GRANTED');

    vi.mocked(kioskVerifyPin).mockRejectedValue(new Error('network down'));
    vi.mocked(kioskPunch).mockRejectedValue(new Error('network down'));

    const user = userEvent.setup();
    renderKiosk();
    await typePin(user);

    // Known GRANTED → selfie stage. jsdom has no camera, so the capture
    // screen falls back to the error state. Wait for THAT state before
    // clicking: the normal camera screen also carries a skip button now,
    // and grabbing it mid-swap clicks a node the error-state re-render
    // has already detached — the handler never fires.
    expect(await screen.findByText(/camera unavailable/i)).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: /continue without selfie/i }),
    );
    expect(await screen.findByText(/saved offline/i)).toBeInTheDocument();
    expect(enqueuePunch).toHaveBeenCalledTimes(1);
  });

  it('shows who the punch is for before it happens — "Not me" goes back to the keypad and punches nothing', async () => {
    vi.mocked(kioskVerifyPin).mockResolvedValue({ ...VERIFY_OK, associateLastInitial: 'L' });
    const user = userEvent.setup();
    renderKiosk();
    await typePin(user);

    expect(await screen.findByText('Maria L.')).toBeInTheDocument();
    expect(screen.getByText('Clock in?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /not me/i }));
    expect(await screen.findByText(/type your own clock-in number/i)).toBeInTheDocument();
    expect(kioskPunch).not.toHaveBeenCalled();
  });

  it('the confirm goes through on its own after 3 seconds — the line keeps moving', async () => {
    vi.mocked(kioskVerifyPin).mockResolvedValue(VERIFY_OK);
    vi.mocked(kioskPunch).mockResolvedValue(PUNCH_OK);
    const user = userEvent.setup();
    renderKiosk();
    await typePin(user);
    expect(await screen.findByText(/continuing in 3/i)).toBeInTheDocument();
    expect(await screen.findByText('Clocked in', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(kioskPunch).toHaveBeenCalledTimes(1);
  }, 10_000);

  it('says back the shift, on time or late, the meal break and the hours this week', async () => {
    vi.mocked(kioskVerifyPin).mockResolvedValue(VERIFY_OK);
    vi.mocked(kioskPunch).mockResolvedValue({
      ...PUNCH_OK,
      summary: {
        timezone: 'America/New_York',
        shift: { startsAt: '2026-06-11T12:00:00.000Z', endsAt: '2026-06-11T20:30:00.000Z' },
        lateMinutes: 12,
        mealDueAt: '2026-06-11T17:00:00.000Z',
        weekMinutes: 1110,
      },
    });
    const user = userEvent.setup();
    renderKiosk();
    await typePin(user);
    await confirmMe(user);
    expect(await screen.findByText('Clocked in')).toBeInTheDocument();
    expect(screen.getByText(/Shift 8:00\sAM – 4:30\sPM/)).toBeInTheDocument();
    expect(screen.getByText(/12 min late/)).toBeInTheDocument();
    expect(screen.getByText(/Meal break by 1:00\sPM/)).toBeInTheDocument();
    expect(screen.getByText('18.5 h')).toBeInTheDocument();
  });

  it('switches to the worker’s own language for their punch, and back for the next person', async () => {
    vi.mocked(kioskVerifyPin).mockResolvedValue({ ...VERIFY_OK, language: 'es' });
    const user = userEvent.setup();
    renderKiosk();
    await typePin(user);
    expect(await screen.findByText('¿Marcar entrada?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /no soy yo/i }));
    await user.click(screen.getByRole('button', { name: /cancel/i }));
    // The tablet's own language (English) is back at idle.
    expect(await screen.findByRole('button', { name: /tap to clock/i })).toBeInTheDocument();
  });

  it('a held clock-out gets its own SOP screen: pick why, submit, and the clock-out carries on', async () => {
    vi.mocked(kioskVerifyPin)
      .mockRejectedValueOnce(
        new ApiError(409, 'sop_open', 'Submit your Swing SOP before you clock out.', {
          sopId: 's1',
          label: 'Swing SOP',
          windowLabel: 'Swing',
          dateKey: '2026-06-11',
          requiredOpen: 2,
          sopDone: 5,
          sopTotal: 7,
        }),
      )
      .mockResolvedValue({ ...VERIFY_OK, predictedAction: 'CLOCK_OUT' });
    vi.mocked(kioskSubmitSop).mockResolvedValue({ ok: true, submitted: true, closedIncomplete: true });
    const user = userEvent.setup();
    renderKiosk();
    await typePin(user);

    expect(await screen.findByText('Your SOP is still open')).toBeInTheDocument();
    expect(screen.getByText(/5 of 7 done/)).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: /submit and clock out/i });
    expect(submit).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /family emergency/i }));
    await user.click(submit);
    expect(kioskSubmitSop).toHaveBeenCalledWith(
      expect.objectContaining({ pin: '1234', reason: 'Family emergency — leaving early' }),
    );
    // The preflight runs again and the clock-out goes on: "Done for the day, Maria?"
    expect(await screen.findByText(/done for the day/i)).toBeInTheDocument();
    expect(kioskVerifyPin).toHaveBeenCalledTimes(2);
  });

  it('offline after a good preflight: names the person and what was saved', async () => {
    vi.mocked(kioskVerifyPin).mockResolvedValue(VERIFY_OK);
    vi.mocked(kioskPunch).mockRejectedValue(new Error('network down'));
    const user = userEvent.setup();
    renderKiosk();
    await typePin(user);
    await confirmMe(user);
    expect(await screen.findByText(/Welcome, Maria/)).toBeInTheDocument();
    expect(screen.getByText('Clocked in')).toBeInTheDocument();
    expect(screen.getByText(/will send/)).toBeInTheDocument();
    expect(enqueuePunch).toHaveBeenCalledTimes(1);
  });

  it('language toggle switches the kiosk to Spanish and persists', async () => {
    const user = userEvent.setup();
    renderKiosk();

    await user.click(await screen.findByRole('button', { name: 'Español' }));
    expect(
      await screen.findByText(/toca para marcar entrada/i),
    ).toBeInTheDocument();
    expect(window.localStorage.getItem('alto.kiosk.lang')).toBe('es');
  });
});
