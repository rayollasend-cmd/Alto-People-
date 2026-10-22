import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { I18nProvider } from '@/lib/i18n';
import { RunTotalsMismatch } from '@/components/payroll/RunTotalsMismatch';

/**
 * A run whose stored totals and paychecks disagree says so wherever its
 * money shows (F500 SH-4): the dev run that stored $4,054.50 gross /
 * $3,490.20 net with no paychecks read "Net paid $0.00" on one card and
 * $3,490.20 on the next.
 */
const wrap = (ui: React.ReactNode) => render(<I18nProvider>{ui}</I18nProvider>);

describe('<RunTotalsMismatch>', () => {
  it('says nothing when the totals agree, or nobody checked', () => {
    const { container } = wrap(
      <>
        <RunTotalsMismatch check={{ totalGross: 1500, totalNet: 1269.45, itemsGross: 1500, itemsNet: 1269.45, paychecks: 2, totalsAgree: true }} />
        <RunTotalsMismatch check={{ totalGross: 1500, totalNet: 1269.45 }} />
        <RunTotalsMismatch check={null} />
      </>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('a run with money and no paychecks', () => {
    wrap(<RunTotalsMismatch check={{ totalGross: 4054.5, totalNet: 3490.2, itemsGross: 0, itemsNet: 0, paychecks: 0, totalsAgree: false }} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('The totals and the paychecks disagree.');
    expect(alert).toHaveTextContent('This run records $4,054.50 gross but has no paychecks.');
    expect(alert).toHaveTextContent(/Don’t sign off or pay from these numbers/);
  });

  it('paychecks that add up to something else, named to the cent', () => {
    wrap(<RunTotalsMismatch compact check={{ totalGross: 1500, totalNet: 1269.46, itemsGross: 1500, itemsNet: 1269.45, paychecks: 2, totalsAgree: false }} />);
    expect(screen.getByRole('alert')).toHaveTextContent('This run records $1,500.00 gross and $1,269.46 net, but its 2 paychecks add up to $1,500.00 gross and $1,269.45 net.');
  });
});
