import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderAs } from '../pages/hrPack/harness';

const api = vi.hoisted(() => ({
  getPersonPunchPhoto: vi.fn(),
  setPersonPunchPhoto: vi.fn(),
  endPersonPunchPhoto: vi.fn(),
  punchPhotoUrl: (id: string) => `/api/kiosk-punches/${id}/selfie`,
}));
vi.mock('@/lib/punchPhotosApi', () => api);
import { PunchPhotoCard } from '@/components/PunchPhotoCard';

/** A person's photo-at-punch card: why it applies, and a rule of their own needs a reason and (by default) an end date. */

const person = (over = {}) => ({
  associateId: 'a1',
  name: 'Ana Reyes',
  location: 'Front Beach 218',
  required: false,
  decidedBy: null,
  ownRule: null,
  history: [],
  recentPunches: [{ id: 'p1', action: 'CLOCK_IN', at: '2026-10-19T13:00:00.000Z', kiosk: 'Front desk', hasPhoto: true, flagged: false, reviewStatus: null }],
  last30Days: { keptWithoutPhoto: 0, refusedWithoutPhoto: 0 },
  canSetCompanyRules: true,
  ...over,
});

beforeEach(() => {
  api.getPersonPunchPhoto.mockReset();
  api.setPersonPunchPhoto.mockReset();
});

describe('<PunchPhotoCard>', () => {
  it('requires a photo for one person only with a reason, and defaults to a 30-day end', async () => {
    api.getPersonPunchPhoto.mockResolvedValue(person());
    api.setPersonPunchPhoto.mockResolvedValue({ rule: {} });
    const user = userEvent.setup();
    renderAs('HR_ADMINISTRATOR', <PunchPhotoCard associateId="a1" />);
    expect(await screen.findByText(/doesn’t require a photo/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Require a photo/ }));
    const dialog = await screen.findByRole('dialog');
    const go = within(dialog).getByRole('button', { name: 'Require it' });
    expect(go).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Why'), 'Two punches the supervisor didn’t see');
    await user.click(go);
    expect(api.setPersonPunchPhoto).toHaveBeenCalledWith('a1', expect.objectContaining({ required: true, reason: 'Two punches the supervisor didn’t see', endsOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) }));
  });

  it('says which rule decided it, and the photos open only on request', async () => {
    api.getPersonPunchPhoto.mockResolvedValue(
      person({ required: true, decidedBy: { scope: 'SITE', required: true, siteName: 'Front Beach 218', setBy: 'Dana Reyes', setAt: '2026-10-01T12:00:00.000Z', endsOn: null } }),
    );
    const user = userEvent.setup();
    renderAs('HR_ADMINISTRATOR', <PunchPhotoCard associateId="a1" />);
    expect(await screen.findByText(/Required at Front Beach 218, where they work — set by Dana Reyes/)).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Show their recent punch photos/ }));
    expect(screen.getByRole('img')).toHaveAttribute('src', '/api/kiosk-punches/p1/selfie');
    expect(screen.getByRole('button', { name: 'Exempt them' })).toBeInTheDocument();
  });

  it('is hidden from people who don’t manage time', () => {
    renderAs('MARKETING_MANAGER', <PunchPhotoCard associateId="a1" />);
    expect(api.getPersonPunchPhoto).not.toHaveBeenCalled();
  });
});
