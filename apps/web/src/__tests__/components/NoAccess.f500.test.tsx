import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderAs } from '../pages/hrPack/harness';
import { NoAccess } from '@/components/ui/NoAccess';

/** An associate who lands on /approvals is told whose page it is and sent to their own Inbox (F500 G5). */
describe('<NoAccess>', () => {
  it('on /approvals: approvals are for managers, and the way to my Inbox', () => {
    renderAs('ASSOCIATE', <NoAccess />, '/approvals');
    expect(screen.getByText('Approvals are for managers and supervisors — your own tasks are in your Inbox.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open my Inbox/ })).toHaveAttribute('href', '/inbox');
  });

  it('anywhere else: the plain access page, home only', () => {
    renderAs('ASSOCIATE', <NoAccess />, '/payroll');
    expect(screen.queryByRole('link', { name: /Open my Inbox/ })).toBeNull();
    expect(screen.getByTestId('no-access')).toBeInTheDocument();
  });
});
