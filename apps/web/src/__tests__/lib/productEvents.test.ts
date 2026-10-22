import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushProductEventsForTests, isSettingsPath, noteDecision, noteSearchLanded, resetProductEventsForTests, startProductSession } from '@/lib/productEvents';

/**
 * ux-upgrade §6: a session starts once, the first decision carries how long it
 * took, every decision counts, and only a search that lands on a settings page
 * is a "could not find it".
 */

function sent(): Array<{ kind: string; value?: number }> {
  const calls = (navigator.sendBeacon as unknown as ReturnType<typeof vi.fn>).mock.calls;
  const out: Array<{ kind: string; value?: number }> = [];
  for (const [, blob] of calls) {
    const text = (blob as { text?: () => Promise<string>; __body?: string }).__body ?? '';
    out.push(...(JSON.parse(text) as { events: Array<{ kind: string; value?: number }> }).events);
  }
  return out;
}

beforeEach(() => {
  resetProductEventsForTests();
  // jsdom has no sendBeacon; the fake keeps the body so the test can read it.
  const beacon = vi.fn((_url: string, blob: Blob) => {
    void blob;
    return true;
  });
  vi.stubGlobal('navigator', { ...navigator, sendBeacon: beacon });
  // Blob.text is async; stash the body synchronously instead.
  const OriginalBlob = globalThis.Blob;
  vi.stubGlobal(
    'Blob',
    class extends OriginalBlob {
      __body: string;
      constructor(parts: BlobPart[], opts?: BlobPropertyBag) {
        super(parts, opts);
        this.__body = String(parts[0]);
      }
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetProductEventsForTests();
});

describe('product events', () => {
  it('starts a session once and times the first decision from it', () => {
    startProductSession(1_000);
    startProductSession(5_000);
    noteDecision(31_000);
    noteDecision(40_000);
    flushProductEventsForTests();
    expect(sent()).toEqual([{ kind: 'session_start' }, { kind: 'decision' }, { kind: 'first_decision', value: 30_000 }, { kind: 'decision' }]);
  });

  it('counts a search only when it lands on a settings page', () => {
    expect(isSettingsPath('/admin/users')).toBe(true);
    expect(isSettingsPath('/settings')).toBe(true);
    expect(isSettingsPath('/admin')).toBe(true);
    expect(isSettingsPath('/administration')).toBe(false);
    expect(isSettingsPath('/people')).toBe(false);
    noteSearchLanded('users', '/admin/users');
    noteSearchLanded('u', '/admin/users'); // one letter is not a search
    noteSearchLanded('dee', '/people?associateId=p1');
    flushProductEventsForTests();
    expect(sent()).toEqual([{ kind: 'settings_search' }]);
  });
});
