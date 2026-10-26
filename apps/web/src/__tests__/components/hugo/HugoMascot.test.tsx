import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { HugoMascot, isHugo } from '@/components/hugo/HugoMascot';

describe('isHugo', () => {
  it('is Hugo unless the tenant renamed its assistant', () => {
    expect(isHugo(undefined)).toBe(true);
    expect(isHugo(null)).toBe(true);
    expect(isHugo('Hugo')).toBe(true);
    expect(isHugo('Concierge')).toBe(false);
  });
});

describe('HugoMascot', () => {
  const original = window.matchMedia;
  afterEach(() => {
    window.matchMedia = original;
    vi.useRealTimers();
  });

  it('paints a sized, decorative still — and with reduced motion (the test default) never loads the strip', async () => {
    vi.useFakeTimers();
    const { container } = render(<HugoMascot pose="hello" size={96} />);
    const img = container.querySelector('img')!;
    expect(img.getAttribute('width')).toBe('96');
    expect(img.getAttribute('height')).toBe('96');
    expect(img.getAttribute('alt')).toBe('');
    expect(container.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(container.querySelector('.hugo-sprite')).toBeNull();
  });

  it('with motion allowed, plays the strip once the page is idle: frames, iterations', async () => {
    window.matchMedia = ((query: string) => ({ ...original(query), matches: /min-width/.test(query) })) as typeof window.matchMedia;
    vi.useFakeTimers();
    const { container } = render(<HugoMascot pose="hello" size={96} play={2} />);
    expect(container.querySelector('.hugo-sprite')).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(700);
    });
    await act(async () => {});
    const sprite = container.querySelector<HTMLElement>('.hugo-sprite')!;
    expect(sprite.dataset.kind).toBe('loop');
    expect(sprite.style.getPropertyValue('--hugo-end')).toBe('-1152px');
    expect(sprite.style.getPropertyValue('--hugo-iterations')).toBe('2');
    expect(container.querySelector('img')!.className).toContain('invisible');
  });

  it("'still' never moves", async () => {
    window.matchMedia = ((query: string) => ({ ...original(query), matches: false })) as typeof window.matchMedia;
    vi.useFakeTimers();
    const { container } = render(<HugoMascot pose="working" size={40} play="still" />);
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(container.querySelector('.hugo-sprite')).toBeNull();
  });
});
