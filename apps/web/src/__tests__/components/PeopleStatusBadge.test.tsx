import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WORK_STATUSES } from '@alto-people/shared';
import { I18nProvider } from '@/lib/i18n';
import { PeopleStatusBadge, workStatusEnglish, workStatusOf } from '@/components/ui/PeopleStatusBadge';

/**
 * One status per person (F500 SH-4): the badge says the one word and,
 * in its title, what the word means — on every page.
 */
describe('<PeopleStatusBadge>', () => {
  it('says Working · No recent shifts · Not placed · Onboarding · Paused · Separated, each with its meaning', () => {
    render(
      <I18nProvider>
        {WORK_STATUSES.map((s) => (
          <PeopleStatusBadge key={s} status={s} windowDays={14} />
        ))}
      </I18nProvider>,
    );
    for (const word of ['Working', 'No recent shifts', 'Not placed', 'Onboarding', 'Paused', 'Separated']) expect(screen.getByText(word)).toBeInTheDocument();
    const titled = (word: string) => screen.getByText(word).closest('[data-work-status]');
    expect(titled('Working')).toHaveAttribute('title', 'Placed at a site, and worked in the last 14 days or has a shift ahead.');
    expect(titled('Paused')?.getAttribute('title')).toMatch(/Still employed/);
  });

  it('never crashes on a value it does not know', () => {
    render(
      <I18nProvider>
        <PeopleStatusBadge status={'NOPE' as never} />
      </I18nProvider>,
    );
    expect(screen.getByText('Not placed')).toBeInTheDocument();
  });

  it('reads an older row that sent only the three words', () => {
    expect(workStatusOf({ workStatus: 'PLACED_NOT_ACTIVE', status: 'INACTIVE' })).toBe('PLACED_NOT_ACTIVE');
    expect(workStatusOf({ status: 'ACTIVE' })).toBe('ACTIVE');
    expect(workStatusOf({ status: 'PENDING' })).toBe('ONBOARDING');
    expect(workStatusOf({ status: 'INACTIVE', separatedAt: '2026-10-01T00:00:00.000Z' })).toBe('SEPARATED');
    expect(workStatusOf({ status: 'INACTIVE', deactivatedAt: '2026-10-01T00:00:00.000Z' })).toBe('DEACTIVATED');
    expect(workStatusEnglish('DEACTIVATED')).toBe('Paused');
  });
});
