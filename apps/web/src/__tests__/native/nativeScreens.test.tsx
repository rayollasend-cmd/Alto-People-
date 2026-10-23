import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderAs } from '../pages/hrPack/harness';
import { ApiError } from '@/lib/api';

/**
 * The native app's screens: the worker badge (and its Wallet buttons), the
 * phones list and this phone's switches, the kiosk badge reader, HR's badge
 * dialog, the lock screen, the notification explainer and the sign-in
 * handoff page — each in its loading, empty, error and working states.
 */

const getWorkerBadge = vi.fn();
const getAppleWalletLink = vi.fn();
const getGoogleWalletLink = vi.fn();
vi.mock('@/lib/walletApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/walletApi')>()),
  getWorkerBadge: () => getWorkerBadge(),
  getAppleWalletLink: () => getAppleWalletLink(),
  getGoogleWalletLink: () => getGoogleWalletLink(),
}));

const apiFetch = vi.fn();
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), apiFetch: (...a: unknown[]) => apiFetch(...a) }));

const getKioskPinBadge = vi.fn();
const reissueKioskPinBadge = vi.fn();
vi.mock('@/lib/kiosk99Api', async (orig) => ({
  ...(await orig<typeof import('@/lib/kiosk99Api')>()),
  getKioskPinBadge: (id: string) => getKioskPinBadge(id),
  reissueKioskPinBadge: (id: string) => reissueKioskPinBadge(id),
}));

const nfc = { availability: 'unsupported' as 'ready' | 'disabled' | 'unsupported', read: vi.fn(), write: vi.fn() };
vi.mock('@/lib/native/nfc', async (orig) => {
  const real = await orig<typeof import('@/lib/native/nfc')>();
  return { ...real, nfcAvailability: async () => nfc.availability, readBadge: () => nfc.read(), writeBadge: (t: string) => nfc.write(t) };
});

const bio = { available: true, pass: true };
vi.mock('@/lib/native/biometric', () => ({
  checkBiometry: async () => ({ available: bio.available, label: 'Face ID', kind: 'face' }),
  authenticateBiometric: async () => bio.pass,
}));

const openInSystemBrowser = vi.fn();
vi.mock('@/lib/native/shell', async (orig) => ({ ...(await orig<typeof import('@/lib/native/shell')>()), openInSystemBrowser: (u: string) => openInSystemBrowser(u) }));

vi.mock('qrcode', () => ({ default: { toDataURL: async () => 'data:image/png;base64,QR' } }));

import { WorkerBadgeCard } from '@/pages/me/WorkerBadgeCard';
import { PhonesCard } from '@/components/settings/PhonesCard';
import { BadgeReader } from '@/pages/kiosk/BadgeReader';
import { BadgeDialog } from '@/pages/kiosk/BadgeDialog';
import { BiometricLock } from '@/components/native/BiometricLock';
import { pushPromptDue } from '@/components/native/PushPermissionSheet';
import { NativeHandoff } from '@/pages/NativeHandoff';

const BADGE = {
  workerName: 'Ana Lopez',
  workerNumber: '4321',
  title: 'Cashier',
  siteName: 'Front Beach 218',
  employerName: 'Alto HR',
  badgeToken: 'altob1.payload.sig',
  badgeVersion: 1,
  photoUrl: null,
  apple: { available: true, missing: [] },
  google: { available: true, missing: [] },
};

function asNative(platform: 'ios' | 'android') {
  (window as unknown as { Capacitor: unknown }).Capacitor = { isNativePlatform: () => true, getPlatform: () => platform };
}

beforeEach(() => {
  vi.clearAllMocks();
  nfc.availability = 'unsupported';
  bio.available = true;
  bio.pass = true;
});
afterEach(() => {
  delete (window as unknown as { Capacitor?: unknown }).Capacitor;
});

describe('<WorkerBadgeCard>', () => {
  it('draws the badge like the pass and offers the phone’s own wallet first', async () => {
    asNative('ios');
    getWorkerBadge.mockResolvedValue(BADGE);
    getAppleWalletLink.mockResolvedValue({ url: 'https://app.altohr.com/api/wallet/badge.pkpass?t=x' });
    renderAs('ASSOCIATE', <WorkerBadgeCard />, '/me/wallet', { associateId: 'a1' });
    const badge = await screen.findByRole('group', { name: /Ana Lopez/ });
    expect(within(badge).getByText('Cashier')).toBeInTheDocument();
    expect(within(badge).getByText('Front Beach 218')).toBeInTheDocument();
    // The clock-in number is masked on the card until asked (F500 G5) — as on Home and My profile.
    expect(within(badge).getByTestId('badge-number')).toHaveTextContent('••••');
    expect(within(badge).queryByText('4321')).toBeNull();
    await userEvent.click(within(badge).getByRole('button', { name: 'Show my clock-in number' }));
    expect(within(badge).getByTestId('badge-number')).toHaveTextContent('4321');
    // iPhone: Apple Wallet only, opened in Safari (the web view can't add passes).
    expect(screen.queryByRole('button', { name: /google wallet/i })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /add to apple wallet/i }));
    await waitFor(() => expect(openInSystemBrowser).toHaveBeenCalledWith('https://app.altohr.com/api/wallet/badge.pkpass?t=x'));
  });

  it('wallets not set up: says so plainly, the badge still works at the kiosk', async () => {
    getWorkerBadge.mockResolvedValue({ ...BADGE, apple: { available: false, missing: ['PASS_TYPE_ID'] }, google: { available: false, missing: [] } });
    renderAs('ASSOCIATE', <WorkerBadgeCard />, '/me/wallet', { associateId: 'a1' });
    expect(await screen.findByText(/aren’t turned on for your organization yet/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /wallet/i })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /show badge/i }));
    expect(await screen.findByRole('dialog')).toHaveTextContent(/kiosk camera/);
  });

  it('no clock-in number yet: explains how to get one', async () => {
    getWorkerBadge.mockRejectedValue(new ApiError(409, 'no_clock_in_number', 'x'));
    renderAs('ASSOCIATE', <WorkerBadgeCard />, '/me/wallet', { associateId: 'a1' });
    expect(await screen.findByText(/comes with your clock-in number/)).toBeInTheDocument();
  });
});

describe('<PhonesCard>', () => {
  it('lists the phones and removes one after a confirm', async () => {
    apiFetch.mockImplementation(async (path: string, opts?: { method?: string }) => {
      if (path === '/devices') return { devices: [{ id: 'd1', platform: 'IOS', deviceModel: 'iPhone', osVersion: '26.1', appVersion: '1.0.0', notifications: true, biometricLock: false, lastSeenAt: new Date().toISOString(), current: false }] };
      if (opts?.method === 'DELETE') return undefined;
      return {};
    });
    renderAs('ASSOCIATE', <PhonesCard />, '/settings', { associateId: 'a1' });
    expect(await screen.findByText(/notifications on/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    const dialog = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/devices/d1', { method: 'DELETE' }));
  });

  it('no phones yet: tells you where to get the app', async () => {
    apiFetch.mockResolvedValue({ devices: [] });
    renderAs('ASSOCIATE', <PhonesCard />, '/settings', { associateId: 'a1' });
    expect(await screen.findByText(/iPhone or Android phone/)).toBeInTheDocument();
  });
});

describe('<BadgeReader> at the kiosk', () => {
  const T = {
    tapBadge: 'Tap badge',
    scanBadge: 'Scan badge',
    badgeHold: 'Hold your badge to the top of the tablet',
    badgeHoldCamera: 'Hold the code up to the camera',
    badgeReading: 'Reading…',
    badgeRead: 'Badge read',
    nfcOff: 'NFC off',
    badgeTimeout: 'We didn’t feel a badge.',
    notABadge: 'Not an Alto badge.',
    cameraBlocked: 'No camera.',
    orTypeNumber: 'or type your number',
    cancel: 'Cancel',
  };

  it('a browser kiosk with no NFC and no QR reader shows nothing extra', () => {
    const { container } = render(<BadgeReader t={T} onBadge={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('in the app: ready → holding → read → hands the badge on', async () => {
    asNative('android');
    nfc.availability = 'ready';
    let resolve: (t: string) => void = () => {};
    nfc.read.mockReturnValue(new Promise<string>((r) => (resolve = r)));
    const onBadge = vi.fn();
    render(<BadgeReader t={T} onBadge={onBadge} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Tap badge' }));
    expect(screen.getByRole('status')).toHaveTextContent('Hold your badge to the top of the tablet');
    await act(async () => resolve('altob1.p.s'));
    expect(await screen.findByText('Badge read')).toBeInTheDocument();
    await waitFor(() => expect(onBadge).toHaveBeenCalledWith('altob1.p.s'), { timeout: 2000 });
  });

  it('a tap that times out says what to do', async () => {
    asNative('ios');
    nfc.availability = 'ready';
    const { NfcError } = await import('@/lib/native/nfc');
    nfc.read.mockRejectedValue(new NfcError('timeout'));
    render(<BadgeReader t={T} onBadge={() => {}} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Tap badge' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('We didn’t feel a badge.');
  });
});

describe('<BadgeDialog> for HR', () => {
  it('on the web: explains badges are written in the app; reissue asks first', async () => {
    getKioskPinBadge.mockResolvedValue({ badgeToken: 'altob1.a.b', badgeVersion: 1, workerName: 'Ana Lopez' });
    reissueKioskPinBadge.mockResolvedValue({ badgeToken: 'altob1.c.d', badgeVersion: 2 });
    renderAs('HR_ADMINISTRATOR', <BadgeDialog pinId="p1" name="Ana Lopez" onClose={() => {}} />, '/kiosk');
    expect(await screen.findByText(/in the Alto People app on a phone with NFC/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /reissue badge/i }));
    const confirmDialog = (await screen.findAllByRole('alertdialog').catch(() => screen.findAllByRole('dialog'))).at(-1)!;
    await userEvent.click(within(confirmDialog).getByRole('button', { name: /reissue badge/i }));
    await waitFor(() => expect(reissueKioskPinBadge).toHaveBeenCalledWith('p1'));
    expect(await screen.findByText(/Badge version 2/)).toBeInTheDocument();
  });

  it('in the app: writes the badge and says to test it', async () => {
    asNative('android');
    nfc.availability = 'ready';
    nfc.write.mockResolvedValue(undefined);
    getKioskPinBadge.mockResolvedValue({ badgeToken: 'altob1.a.b', badgeVersion: 1, workerName: 'Ana Lopez' });
    renderAs('HR_ADMINISTRATOR', <BadgeDialog pinId="p1" name="Ana Lopez" onClose={() => {}} />, '/kiosk');
    await userEvent.click(await screen.findByRole('button', { name: 'Write badge' }));
    expect(await screen.findByText(/Written\. Test it at the kiosk/)).toBeInTheDocument();
    expect(nfc.write).toHaveBeenCalledWith('altob1.a.b');
  });
});

describe('<BiometricLock>', () => {
  it('prompts on its own, then unlocks', async () => {
    asNative('ios');
    const onUnlocked = vi.fn();
    render(<BiometricLock signedIn onUnlocked={onUnlocked} onSignInAgain={() => {}} />);
    await waitFor(() => expect(onUnlocked).toHaveBeenCalled());
  });

  it('a failed match says so and offers the password', async () => {
    asNative('ios');
    bio.pass = false;
    const onSignInAgain = vi.fn();
    render(<BiometricLock signedIn onUnlocked={() => {}} onSignInAgain={onSignInAgain} />);
    expect(await screen.findByText(/didn’t match/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /sign in with password/i }));
    expect(onSignInAgain).toHaveBeenCalled();
  });
});

describe('the notification explainer', () => {
  it('asks again only after a week', () => {
    window.localStorage.removeItem('alto:pushPromptDismissedAt');
    expect(pushPromptDue()).toBe(true);
    window.localStorage.setItem('alto:pushPromptDismissedAt', String(Date.now()));
    expect(pushPromptDue()).toBe(false);
    expect(pushPromptDue(Date.now() + 8 * 86_400_000)).toBe(true);
  });
});

describe('<NativeHandoff>', () => {
  it('signed in: sends you back to the app with the code', async () => {
    apiFetch.mockResolvedValue({ code: 'c', returnUrl: 'altopeople://auth/complete?code=c' });
    const assign = vi.spyOn(window, 'location', 'get');
    const loc = { href: '', replace: vi.fn() } as unknown as Location;
    assign.mockReturnValue(loc);
    renderAs('ASSOCIATE', <NativeHandoff />, '/native-handoff');
    await waitFor(() => expect(loc.href).toBe('altopeople://auth/complete?code=c'));
    expect(await screen.findByRole('link', { name: /open the app/i })).toHaveAttribute('href', 'altopeople://auth/complete?code=c');
    assign.mockRestore();
  });

  it('not signed in: goes to sign-in, which returns here', async () => {
    apiFetch.mockRejectedValue(new ApiError(401, 'unauthenticated', 'x'));
    const replace = vi.fn();
    const spy = vi.spyOn(window, 'location', 'get').mockReturnValue({ href: '', replace } as unknown as Location);
    renderAs('ASSOCIATE', <NativeHandoff />, '/native-handoff');
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/login?next=/native-handoff'));
    spy.mockRestore();
  });
});
