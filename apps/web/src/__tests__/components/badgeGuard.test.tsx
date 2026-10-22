import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Badge, BADGE_MAX_CHARS } from '@/components/ui/Badge';

/**
 * A badge is a word or two (F500 SH-2): the new-hire status badge held a
 * four-problem sentence and became a six-line round blob on a phone, inside
 * a DataGrid card that sets `[&_*]:whitespace-normal`.
 */

afterEach(() => vi.restoreAllMocks());

describe('Badge', () => {
  it('holds one line even inside a parent that forces wrapping, and ends long text in an ellipsis', () => {
    const long = 'No SSN on file, Home address incomplete, Employer EIN missing, Employer address incomplete';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(
      <div className="[&_*]:whitespace-normal">
        <Badge variant="pending">{long}</Badge>
      </div>,
    );
    const text = screen.getByText(long);
    expect(text).toHaveClass('truncate', 'min-w-0');
    // The text's own span carries the !important too — the parent's `[&_*]` rule reaches it.
    expect(text.className).toContain('!whitespace-nowrap');
    const badge = text.parentElement!;
    // !important beats the parent's arbitrary-variant rule.
    expect(badge.className).toContain('!whitespace-nowrap');
    expect(badge).toHaveClass('max-w-full', 'overflow-hidden');
    // The whole text is one hover away.
    expect(badge).toHaveAttribute('title', long);
  });

  it('warns the developer when a badge is used for a sentence (once per text)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sentence = 'x'.repeat(BADGE_MAX_CHARS + 1) + ' unique';
    const { rerender } = render(<Badge>{sentence}</Badge>);
    rerender(<Badge variant="success">{sentence}</Badge>);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/put the sentence beside it as text/);
    render(<Badge>Approved</Badge>);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('short labels get no tooltip; an explicit title wins', () => {
    render(<Badge>Ready</Badge>);
    expect(screen.getByText('Ready').parentElement).not.toHaveAttribute('title');
    render(<Badge title="Ready to file">Ready to file now</Badge>);
    expect(screen.getByText('Ready to file now').parentElement).toHaveAttribute('title', 'Ready to file');
  });

  it('truncate={false} wraps in a rounded rectangle, never a round blob', () => {
    render(<Badge truncate={false}>Two words</Badge>);
    const badge = screen.getByText('Two words');
    expect(badge.className).toContain('!whitespace-normal');
    expect(badge).toHaveClass('rounded-md');
  });

  it('keeps icon + text children as they are', () => {
    render(
      <Badge>
        <svg data-testid="icon" />
        Due Oct 3
      </Badge>,
    );
    expect(screen.getByTestId('icon').parentElement).toHaveClass('inline-flex');
  });
});
