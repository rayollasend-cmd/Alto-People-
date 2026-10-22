import { useEffect, useRef } from 'react';
import { isTypingTarget } from './shortcuts';

/**
 * Transport walk 12 — the keyboard on /transport.
 *
 *   [ / ]   previous / next day        t / m   today / tomorrow
 *   j / k   next / previous waiting group       x   pick the group under the cursor
 *   d       dispatch what's picked      p       Plan runs
 *   g r     Transportation, from anywhere (lib/shortcuts GO_TO)
 *
 * Nothing fires while typing or inside a dialog — the dialogs own their
 * keys. `resolveTransportKey` is the pure part, for tests.
 */

export type TransportKey = 'prevDay' | 'nextDay' | 'today' | 'tomorrow' | 'down' | 'up' | 'pick' | 'dispatch' | 'plan';

export function resolveTransportKey(key: string): TransportKey | null {
  switch (key) {
    case '[':
      return 'prevDay';
    case ']':
      return 'nextDay';
    case 't':
      return 'today';
    case 'm':
      return 'tomorrow';
    case 'j':
      return 'down';
    case 'k':
      return 'up';
    case 'x':
      return 'pick';
    case 'd':
      return 'dispatch';
    case 'p':
      return 'plan';
    default:
      return null;
  }
}

export interface TransportKeyboardHandlers {
  prevDay: () => void;
  nextDay: () => void;
  today: () => void;
  tomorrow: () => void;
  down: () => void;
  up: () => void;
  pick: () => void;
  dispatch: () => void;
  plan: () => void;
}

export function useTransportKeyboard(handlers: TransportKeyboardHandlers, enabled = true): void {
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      if (isTypingTarget(e.target)) return;
      const action = resolveTransportKey(e.key);
      if (!action) return;
      e.preventDefault();
      latest.current[action]();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}
