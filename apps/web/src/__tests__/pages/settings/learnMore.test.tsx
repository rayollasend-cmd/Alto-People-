import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LearnMore } from '@/pages/settings/LearnMore';
import { SettingsSaveBar } from '@/pages/settings/SettingsSaveBar';
import { SettingsSwitch } from '@/components/settings/SettingsSwitch';
import { vi } from 'vitest';

/**
 * F500 polish 2026-10-26: one line under a settings section, the rest behind
 * "Learn more"; and one save model — a quiet line when nothing changed, the
 * bar with Save when something did.
 */
describe('LearnMore', () => {
  it('keeps the detail hidden — with no display class to undo it — until asked', async () => {
    render(
      <p>
        One line.
        <LearnMore>The long explanation.</LearnMore>
      </p>,
    );
    const toggle = screen.getByRole('button', { name: 'Learn more' });
    const detail = screen.getByText('The long explanation.');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(detail).toHaveAttribute('hidden');
    expect(detail.className).not.toMatch(/\bblock\b/);
    await userEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true');
    expect(detail).not.toHaveAttribute('hidden');
  });
});

describe('SettingsSaveBar', () => {
  it('is a quiet line with no dead Save when nothing changed, and a bar with Save when something did', () => {
    const { rerender } = render(<SettingsSaveBar dirty={0} onSave={() => undefined} />);
    expect(screen.getByTestId('settings-save-bar')).toHaveAttribute('data-state', 'saved');
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    rerender(<SettingsSaveBar dirty={2} onSave={() => undefined} onDiscard={() => undefined} />);
    expect(screen.getByText('2 unsaved changes.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument();
  });
});

describe('SettingsSwitch', () => {
  it('is a named switch that reports the new state, ink not gold when on', async () => {
    const onChange = vi.fn();
    render(<SettingsSwitch checked={false} onCheckedChange={onChange} aria-label="Email for Shifts" />);
    const sw = screen.getByRole('switch', { name: 'Email for Shifts' });
    await userEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith(true);
    const track = sw.parentElement!.querySelector('[data-switch-track]')!;
    expect(track.className).toContain('peer-checked:bg-ink');
    expect(track.className).not.toMatch(/gold|accent-fill/);
  });
});
