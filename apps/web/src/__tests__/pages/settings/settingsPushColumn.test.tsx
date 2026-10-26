import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderAs } from '../hrPack/harness';

/**
 * Settings › Notifications, the Push column. Push has its own switch per
 * category beside the bell and email. When a push would not reach THIS
 * device (no subscription, a blocked or push-less browser, nothing set up on
 * the server), the column's header says so — and never implies a push will
 * arrive when no device of the person's would get it — and offers
 * "Turn on push on this device" when one tap can fix it.
 */

vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), apiFetch: vi.fn() }));
vi.mock('@/lib/thisDevicePush', async (orig) => ({
  ...(await orig<typeof import('@/lib/thisDevicePush')>()),
  thisDevicePushStatus: vi.fn(),
  turnOnPushHere: vi.fn(),
  pushIsNativeHere: vi.fn(() => false),
}));
vi.mock('@/lib/push', async (orig) => ({ ...(await orig<typeof import('@/lib/push')>()), unsubscribeFromPush: vi.fn(async () => {}) }));
import { apiFetch } from '@/lib/api';
import { I18nProvider } from '@/lib/i18n';
import { pushColumnNote, thisDevicePushStatus, turnOnPushHere } from '@/lib/thisDevicePush';
import { unsubscribeFromPush } from '@/lib/push';
import { Settings } from '@/pages/Settings';

type Reach = { web: boolean; native: boolean; devices: number };

const ENTRIES = [
  { category: 'scheduling', label: 'Scheduling', description: 'Shift changes', mandatory: false, emailEnabled: true, inAppEnabled: true, pushEnabled: true },
  { category: 'documents', label: 'Documents', description: 'Your paperwork', mandatory: false, emailEnabled: true, inAppEnabled: true, pushEnabled: false },
  { category: 'security', label: 'Account security', description: 'Sign-ins', mandatory: true, emailEnabled: true, inAppEnabled: true, pushEnabled: true },
];

let reach: Reach;
const patches: unknown[] = [];

function serve() {
  vi.mocked(apiFetch).mockImplementation((async (path: string, init?: { method?: string; body?: unknown }) => {
    if (path === '/auth/me/notification-preferences' && init?.method === 'PATCH') {
      patches.push(init.body);
      return undefined;
    }
    if (path === '/auth/me/notification-preferences') return { entries: ENTRIES, push: reach };
    return new Promise(() => {});
  }) as never);
}

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  vi.mocked(thisDevicePushStatus).mockReset();
  vi.mocked(turnOnPushHere).mockReset();
  vi.mocked(unsubscribeFromPush).mockClear();
  patches.length = 0;
  reach = { web: true, native: true, devices: 0 };
});

const prefsLoads = () => vi.mocked(apiFetch).mock.calls.filter(([p, init]) => p === '/auth/me/notification-preferences' && !(init as { method?: string } | undefined)?.method).length;

describe('the Push column', () => {
  it('sits beside Bell and Email with a switch per category; mandatory ones are locked on', async () => {
    vi.mocked(thisDevicePushStatus).mockResolvedValue('subscribed');
    reach = { web: true, native: false, devices: 1 };
    serve();
    renderAs('ASSOCIATE', <Settings />, '/settings#notifications', { associateId: 'a1' });
    const cols = await screen.findByTestId('notif-columns');
    expect(cols).toHaveTextContent(/Bell\s*Email\s*Push/);
    const push = (label: string) => screen.getByRole('switch', { name: `Push for ${label}` });
    expect(push('Scheduling')).toBeChecked();
    expect(push('Documents')).not.toBeChecked();
    expect(push('Account security')).toBeChecked();
    expect(push('Account security')).toBeDisabled();
    // The copy names all three.
    expect(screen.getByText('Choose where each type reaches you — in the bell, by email or by push. Required notices can’t be turned off.')).toBeInTheDocument();
  });

  it('a Push switch saves on its own, leaving email and the bell alone', async () => {
    vi.mocked(thisDevicePushStatus).mockResolvedValue('subscribed');
    reach = { web: true, native: false, devices: 1 };
    serve();
    renderAs('ASSOCIATE', <Settings />, '/settings#notifications', { associateId: 'a1' });
    const toggle = await screen.findByRole('switch', { name: 'Push for Scheduling' });
    await userEvent.click(toggle);
    await waitFor(() => expect(patches).toEqual([{ category: 'scheduling', pushEnabled: false }]));
    expect(toggle).not.toBeChecked();
    expect(screen.getByRole('switch', { name: 'Email for Scheduling' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Bell for Scheduling' })).toBeChecked();
  });

  it('this device subscribed and reachable: no note, and the device row offers to turn it off here', async () => {
    vi.mocked(thisDevicePushStatus).mockResolvedValue('subscribed');
    reach = { web: true, native: false, devices: 2 };
    serve();
    renderAs('ASSOCIATE', <Settings />, '/settings#notifications', { associateId: 'a1' });
    const row = await screen.findByTestId('push-this-device');
    expect(row).toHaveTextContent('Push notifications');
    expect(screen.queryByTestId('push-column-note')).toBeNull();
    await userEvent.click(within(row).getByRole('button', { name: 'Disable' }));
    expect(unsubscribeFromPush).toHaveBeenCalledTimes(1);
  });

  it('no device subscribed: the header says nothing arrives by push and turns it on here', async () => {
    vi.mocked(thisDevicePushStatus).mockResolvedValue('available');
    vi.mocked(turnOnPushHere).mockResolvedValue('subscribed');
    reach = { web: true, native: true, devices: 0 };
    serve();
    renderAs('ASSOCIATE', <Settings />, '/settings#notifications', { associateId: 'a1' });
    const note = await screen.findByTestId('push-column-note');
    expect(note).toHaveTextContent('Push is off on this device. No device of yours gets push yet, so nothing arrives by push.');
    // The switches point at the note.
    expect(screen.getByRole('switch', { name: 'Push for Scheduling' })).toHaveAttribute('aria-describedby', 'push-column-note');
    expect(screen.queryByTestId('push-this-device')).toBeNull();

    const before = prefsLoads();
    reach = { web: true, native: true, devices: 1 };
    await userEvent.click(within(note).getByRole('button', { name: 'Turn on push on this device' }));
    expect(turnOnPushHere).toHaveBeenCalledTimes(1);
    // The device count is read again, and the note goes once push reaches here.
    await waitFor(() => expect(prefsLoads()).toBeGreaterThan(before));
    await waitFor(() => expect(screen.queryByTestId('push-column-note')).toBeNull());
    expect(await screen.findByTestId('push-this-device')).toBeInTheDocument();
  });

  it('off here but on another device: says the others still get it', async () => {
    vi.mocked(thisDevicePushStatus).mockResolvedValue('available');
    reach = { web: true, native: true, devices: 1 };
    serve();
    renderAs('ASSOCIATE', <Settings />, '/settings#notifications', { associateId: 'a1' });
    const note = await screen.findByTestId('push-column-note');
    expect(note).toHaveTextContent('Push is off on this device. Your other devices still get it.');
    expect(within(note).getByRole('button', { name: 'Turn on push on this device' })).toBeInTheDocument();
  });

  it('a browser that cannot do push: says so, and offers no button that would fail', async () => {
    vi.mocked(thisDevicePushStatus).mockResolvedValue('unsupported');
    reach = { web: true, native: true, devices: 0 };
    serve();
    renderAs('ASSOCIATE', <Settings />, '/settings#notifications', { associateId: 'a1' });
    const note = await screen.findByTestId('push-column-note');
    expect(note).toHaveTextContent('This browser can’t get push. On iPhone, add the app to your home screen first.');
    expect(within(note).queryByRole('button')).toBeNull();
  });

  it('nothing set up on the server: plain words, no promise, no button', async () => {
    vi.mocked(thisDevicePushStatus).mockResolvedValue('available');
    reach = { web: false, native: false, devices: 0 };
    serve();
    renderAs('ASSOCIATE', <Settings />, '/settings#notifications', { associateId: 'a1' });
    const note = await screen.findByTestId('push-column-note');
    expect(note).toHaveTextContent('Push isn’t connected for your organization yet, so nothing goes out by push.');
    expect(within(note).queryByRole('button')).toBeNull();
  });

  it('in Spanish', async () => {
    window.localStorage.setItem('alto.lang', 'es');
    try {
      vi.mocked(thisDevicePushStatus).mockResolvedValue('available');
      reach = { web: true, native: true, devices: 0 };
      serve();
      renderAs('ASSOCIATE', <I18nProvider><Settings /></I18nProvider>, '/settings#notifications', { associateId: 'a1' });
      const note = await screen.findByTestId('push-column-note');
      expect(note).toHaveTextContent('Las notificaciones push están desactivadas en este dispositivo. Ninguno de tus dispositivos recibe push todavía, así que no te llegará nada por push.');
      expect(within(note).getByRole('button', { name: 'Activar push en este dispositivo' })).toBeInTheDocument();
      expect(screen.getByTestId('push-column-head')).toHaveTextContent('Push');
    } finally {
      window.localStorage.removeItem('alto.lang');
    }
  });
});

describe('pushColumnNote', () => {
  const r = (web: boolean, native: boolean, devices: number) => ({ web, native, devices });

  it('says nothing when push reaches this device', () => {
    expect(pushColumnNote('subscribed', r(true, false, 1), false)).toBeNull();
  });

  it('while this device is still being read, the server’s count alone keeps it honest', () => {
    expect(pushColumnNote('loading', r(true, true, 0), false)).toEqual({ lead: 'settingsPage.notif.pushNoDevice', tail: null, canTurnOn: false });
    expect(pushColumnNote('loading', r(true, true, 2), false)).toBeNull();
    expect(pushColumnNote('loading', null, false)).toBeNull();
    expect(pushColumnNote('loading', r(false, false, 0), false)?.lead).toBe('settingsPage.notif.pushNoneServer');
  });

  it('never implies arrival: with no reachable device the tail says nothing arrives', () => {
    expect(pushColumnNote('available', r(true, false, 0), false)).toEqual({ lead: 'settingsPage.notif.pushOffHere', tail: 'settingsPage.notif.pushNoDevice', canTurnOn: true });
    // Subscribed here, yet the server reaches no device: the subscription was dropped.
    expect(pushColumnNote('subscribed', r(true, false, 0), false)).toEqual({ lead: 'settingsPage.notif.pushOffHere', tail: 'settingsPage.notif.pushNoDevice', canTurnOn: true });
  });

  it('counts this device out of "your other devices"', () => {
    expect(pushColumnNote('available', r(true, false, 1), false)?.tail).toBe('settingsPage.notif.pushOthersGet');
    expect(pushColumnNote('denied', r(true, false, 1), false)).toEqual({ lead: 'settingsPage.notif.pushBlockedHere', tail: 'settingsPage.notif.pushOthersGet', canTurnOn: false });
  });

  it('inside the phone app, speaks of the phone’s settings and the phone transport', () => {
    expect(pushColumnNote('denied', r(true, true, 0), true)?.lead).toBe('settingsPage.notif.pushBlockedApp');
    // Web push set up, the phone transport not: this phone can't be reached.
    expect(pushColumnNote('available', r(true, false, 0), true)).toEqual({ lead: 'settingsPage.notif.pushKindNotConnected', tail: 'settingsPage.notif.pushNoDevice', canTurnOn: false });
  });

  it('nothing on the server: one sentence, no button', () => {
    expect(pushColumnNote('subscribed', r(false, false, 0), false)).toEqual({ lead: 'settingsPage.notif.pushNoneServer', tail: null, canTurnOn: false });
  });

  it('an older server that does not report reach: only the device speaks', () => {
    expect(pushColumnNote('available', null, false)).toEqual({ lead: 'settingsPage.notif.pushOffHere', tail: null, canTurnOn: true });
    expect(pushColumnNote('subscribed', null, false)).toBeNull();
  });
});
