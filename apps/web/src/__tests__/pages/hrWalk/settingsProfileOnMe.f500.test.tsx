import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderAs } from '../hrPack/harness';

/**
 * One home for personal data (F500 G5): an associate's name, photo, phone
 * and address are edited on /me. Settings' Profile section says so and
 * links there; a staff account (no associate) keeps its photo here.
 */

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(() => new Promise(() => {})),
}));

import { Settings } from '@/pages/Settings';

describe('<Settings> Profile section', () => {
  it('an associate reads where their personal data lives, with no name form here', () => {
    renderAs('ASSOCIATE', <Settings />, '/settings', { associateId: 'a1' });
    const profile = screen.getByRole('tabpanel', { name: 'Profile' });
    const card = within(profile).getByTestId('settings-profile-on-me');
    expect(card).toHaveTextContent('Your name, photo, phone and address are on My profile.');
    expect(within(card).getByRole('link', { name: 'Open My profile' })).toHaveAttribute('href', '/me');
    expect(within(profile).queryByLabelText('First name')).not.toBeInTheDocument();
  });

  it('a staff account keeps its photo in Settings', () => {
    renderAs('HR_ADMINISTRATOR', <Settings />, '/settings');
    const profile = screen.getByRole('tabpanel', { name: 'Profile' });
    expect(within(profile).queryByTestId('settings-profile-on-me')).not.toBeInTheDocument();
  });
});
