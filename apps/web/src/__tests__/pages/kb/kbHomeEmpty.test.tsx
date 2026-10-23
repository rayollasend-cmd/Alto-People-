import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderAs } from '../hrPack/harness';

vi.mock('@/lib/kb124Api', async (orig) => ({
  ...(await orig<typeof import('@/lib/kb124Api')>()),
  getKbCategories: vi.fn().mockResolvedValue({ categories: [] }),
  searchKb: vi.fn().mockResolvedValue({ articles: [] }),
  adminListKb: vi.fn().mockResolvedValue({ articles: [] }),
}));

import { KbHome } from '@/pages/kb/KbHome';

/**
 * F500 G4 · /help-center: an associate with nothing published gets a next
 * step (ask HR), not a dead end, and no one-option "Browse" switch; the
 * people who write articles keep Browse / Manage.
 */
beforeEach(() => undefined);

describe('Help center', () => {
  it('an associate with nothing published can ask HR, and sees no one-option switch', async () => {
    renderAs('ASSOCIATE', <KbHome />, '/help-center');
    expect(await screen.findByText('No articles yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ask HR' })).toHaveAttribute('href', '/hr-cases');
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(screen.queryByText('Browse')).not.toBeInTheDocument();
  });

  it('HR keeps Browse / Manage and the New article action', async () => {
    renderAs('HR_ADMINISTRATOR', <KbHome />, '/help-center');
    expect(await screen.findByText('No articles yet')).toBeInTheDocument();
    expect(screen.getByText('Browse')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /New article/ }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('link', { name: 'Ask HR' })).not.toBeInTheDocument();
  });
});
