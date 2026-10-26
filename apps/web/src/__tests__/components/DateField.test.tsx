import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DateField, DateRangeField } from '@/components/ui/DateField';

/**
 * The app's date field: the day said the app's way, the device's own
 * calendar to pick it — never the browser's "10/24/2026" or "mm/dd/yyyy".
 */
describe('DateField', () => {
  it('says the day the app’s way and hands back a YYYY-MM-DD value', () => {
    const onChange = vi.fn();
    const year = new Date().getFullYear();
    render(<DateField value={`${year}-10-24`} onChange={onChange} aria-label="Day" />);
    expect(screen.getByText('Oct 24')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Day'), { target: { value: `${year}-10-26` } });
    expect(onChange).toHaveBeenCalledWith(`${year}-10-26`);
  });

  it('adds the year only when it isn’t this one, and invites a pick when empty', () => {
    const { rerender } = render(<DateField value="2031-01-31" onChange={() => {}} aria-label="Due" />);
    expect(screen.getByText('Jan 31, 2031')).toBeInTheDocument();
    rerender(<DateField value="" onChange={() => {}} aria-label="Due" />);
    expect(screen.getByText('Pick a date')).toBeInTheDocument();
  });

  it('a range never ends before it starts', () => {
    const onChange = vi.fn();
    render(<DateRangeField from="2031-01-10" to="2031-01-12" onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2031-01-20' } });
    expect(onChange).toHaveBeenCalledWith({ from: '2031-01-20', to: '2031-01-20' });
    expect(screen.getByRole('group')).toHaveAccessibleName('Jan 10 – 12, 2031');
  });
});
