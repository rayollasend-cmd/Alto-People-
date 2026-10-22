import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderAs } from '../hrPack/harness';

/**
 * Floor walk 26: Settings was twelve phone screens of cards in one column.
 * It is five sections now — Profile, Notifications, Security, Devices &
 * sessions, Your data — with a sticky row of links between them, and on a
 * phone each folds behind its heading (only Profile starts open).
 */

// Every card loads its own data; for the page's structure none of it matters.
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(() => new Promise(() => {})),
}));

import { Settings } from '@/pages/Settings';

describe('<Settings> — grouped into sections', () => {
  it('has a section nav and five sections, each with its heading', () => {
    renderAs('ASSOCIATE', <Settings />, '/settings', { associateId: 'a1' });
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(within(nav).getAllByRole('link').map((a) => a.textContent)).toEqual([
      'Profile',
      'Notifications',
      'Security',
      'Devices & sessions',
      'Your data',
    ]);
    for (const name of ['Profile', 'Notifications', 'Security', 'Devices & sessions', 'Your data']) {
      expect(screen.getByRole('region', { name })).toBeInTheDocument();
    }
  });

  it('folds on a phone: Profile open, the rest behind Show, and a nav link opens its section', async () => {
    renderAs('ASSOCIATE', <Settings />, '/settings', { associateId: 'a1' });
    const security = screen.getByRole('region', { name: 'Security' });
    const toggle = within(security).getByRole('button', { name: /Show/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(document.getElementById('settings-security-body')!.className).toContain('hidden md:grid');
    expect(within(screen.getByRole('region', { name: 'Profile' })).getByRole('button', { name: /Hide/ })).toHaveAttribute('aria-expanded', 'true');

    await userEvent.click(toggle);
    expect(within(security).getByRole('button', { name: /Hide/ })).toHaveAttribute('aria-expanded', 'true');

    const data = screen.getByRole('region', { name: 'Your data' });
    expect(within(data).getByRole('button', { name: /Show/ })).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(within(screen.getByRole('navigation', { name: 'Settings sections' })).getByRole('link', { name: 'Your data' }));
    expect(within(data).getByRole('button', { name: /Hide/ })).toHaveAttribute('aria-expanded', 'true');
  });
});
