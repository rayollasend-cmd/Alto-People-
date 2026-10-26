import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderAs } from '../hrPack/harness';

/**
 * Floor walk 26: Settings was twelve phone screens of cards in one column.
 * It is five sections — Profile, Notifications, Security, Devices &
 * sessions, Your data. F500 polish (2026-10-26): one way to move between
 * them, desktop and phone — the kit's tabs (the strip fades the edge with
 * more) — instead of a row of pills plus Show/Hide folds on a phone.
 */

// Every card loads its own data; for the page's structure none of it matters.
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(() => new Promise(() => {})),
}));

import { Settings } from '@/pages/Settings';

describe('<Settings> — grouped into sections', () => {
  it('has five sections as tabs, Profile first and open', () => {
    renderAs('ASSOCIATE', <Settings />, '/settings', { associateId: 'a1' });
    const tabs = screen.getByRole('tablist', { name: 'Settings sections' });
    expect(within(tabs).getAllByRole('tab').map((a) => a.textContent)).toEqual([
      'Profile',
      'Notifications',
      'Security',
      'Devices & sessions',
      'Your data',
    ]);
    expect(within(tabs).getByRole('tab', { name: 'Profile' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
  });

  it('moves by tab, with no Show/Hide folds on top', async () => {
    renderAs('ASSOCIATE', <Settings />, '/settings', { associateId: 'a1' });
    expect(screen.queryByRole('button', { name: /^(Show|Hide)/ })).toBeNull();
    const tabs = screen.getByRole('tablist', { name: 'Settings sections' });
    await userEvent.click(within(tabs).getByRole('tab', { name: 'Your data' }));
    expect(within(tabs).getByRole('tab', { name: 'Your data' })).toHaveAttribute('aria-selected', 'true');
    expect(within(screen.getByRole('tabpanel')).getByText('Download your data')).toBeInTheDocument();
  });
});
