import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderAs } from '../hrPack/harness';

/**
 * Settings, F500 G5: a link to /settings#notifications lands on that
 * section open; the nav marks the section on screen; the notifications
 * copy matches its switches and names its columns once; Out of office is a
 * status line with a dialog, its picker by name; a client's photo copy
 * mentions no directory.
 */

vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), apiFetch: vi.fn() }));
import { apiFetch } from '@/lib/api';
import { Settings } from '@/pages/Settings';

function route(path: string) {
  if (path.startsWith('/auth/me/notification-preferences'))
    return { entries: [{ category: 'SHIFTS', label: 'Shifts', description: 'Shift changes', emailEnabled: true, inAppEnabled: true, mandatory: false }] };
  if (path === '/delegations/mine') return { given: [], received: [], today: '2026-10-22' };
  if (path === '/delegations/candidates')
    return {
      candidates: [
        { id: 'u1', name: 'Priya Shah', named: true, email: 'manager@altohr.com', role: 'MANAGER' },
        { id: 'u2', name: 'Operations Manager · ops@altohr.com', named: false, email: 'ops@altohr.com', role: 'OPERATIONS_MANAGER' },
      ],
    };
  return new Promise(() => {});
}

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('Settings (F500 G5)', () => {
  it('opens and marks the section a #hash names, and keeps the hash when you jump', async () => {
    vi.mocked(apiFetch).mockImplementation(async (p: string) => route(p) as never);
    window.history.replaceState(null, '', '/settings#notifications');
    renderAs('ASSOCIATE', <Settings />, '/settings#notifications', { associateId: 'a1' });
    const notif = screen.getByRole('region', { name: 'Notifications' });
    expect(within(notif).getByRole('button', { name: /Hide/ })).toHaveAttribute('aria-expanded', 'true');
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(within(nav).getByRole('link', { name: 'Notifications' })).toHaveAttribute('aria-current', 'location');
    await userEvent.click(within(nav).getByRole('link', { name: 'Security' }));
    expect(window.location.hash).toBe('#security');
  });

  it('says what the switches do, names the columns once, and puts Out of office behind a status line', async () => {
    vi.mocked(apiFetch).mockImplementation(async (p: string) => route(p) as never);
    renderAs('MANAGER', <Settings />, '/settings');
    expect(screen.getByText('Choose where each type reaches you — in the bell or by email. Required notices can’t be turned off.')).toBeInTheDocument();
    const cols = await screen.findByTestId('notif-columns');
    expect(cols).toHaveTextContent('Bell');
    expect(cols).toHaveTextContent('Email');
    expect(await screen.findByTestId('ooo-status')).toHaveTextContent('No cover set.');
    expect(screen.queryByLabelText('Who covers')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Set cover…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Set cover' });
    const options = within(within(dialog).getByLabelText('Who covers')).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Choose a manager…', 'Priya Shah — manager@altohr.com', 'Operations Manager · ops@altohr.com']);
  });

  it('a client account’s photo copy does not mention a directory', () => {
    vi.mocked(apiFetch).mockImplementation(async (p: string) => route(p) as never);
    renderAs('CLIENT_PORTAL', <Settings />, '/settings');
    expect(screen.getByText(/Shown next to your name in messages and requests/)).toBeInTheDocument();
    expect(screen.queryByText(/directory/)).toBeNull();
  });
});
