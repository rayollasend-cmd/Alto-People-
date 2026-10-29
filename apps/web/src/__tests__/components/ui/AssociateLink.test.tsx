import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { AssociateLink } from '@/components/ui/AssociateLink';
import { renderAs } from '../../pages/hrPack/harness';

/**
 * A name goes where the viewer may follow it: the full record for People
 * readers, the scoped crew card for a supervisor who can reach her crew,
 * plain text for everyone else.
 */
describe('AssociateLink', () => {
  it('People readers get the record', () => {
    renderAs('HR_ADMINISTRATOR', <AssociateLink associateId="a1">Ana Diaz</AssociateLink>);
    expect(screen.getByRole('link', { name: 'Ana Diaz' })).toHaveAttribute('href', expect.stringMatching(/^\/people\/a1/));
  });

  it('a shift supervisor (no view:org, message:crew) gets the crew card', async () => {
    renderAs('SHIFT_SUPERVISOR', <AssociateLink associateId="a1">Ana Diaz</AssociateLink>);
    expect(await screen.findByTestId('crew-link')).toHaveTextContent('Ana Diaz');
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('anyone else reads plain text', () => {
    renderAs('ASSOCIATE', <AssociateLink associateId="a1">Ana Diaz</AssociateLink>);
    expect(screen.getByText('Ana Diaz').tagName).toBe('SPAN');
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByTestId('crew-link')).toBeNull();
  });
});
