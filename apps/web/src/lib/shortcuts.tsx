import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth, useTenant } from '@/lib/auth';
import { visibleModules } from '@/lib/modules';
import { useNavigate } from 'react-router-dom';
import { openKeyboardShortcuts } from '@/components/KeyboardShortcutsDialog';

/**
 * Access pack — keyboard support beyond ⌘K / ⌘J.
 *
 *   One global listener (GlobalShortcuts, mounted in Layout) for the
 *   go-to chords: press `g`, then `h` home, `i` inbox, `s` schedule,
 *   `p` people, `a` approvals, `t` timesheets, `y` payroll, `b` books,
 *   `o` onboarding, `,` settings. `?` opens the shortcut list
 *   (KeyboardShortcutsDialog has its own handler; this one is the chord
 *   leader). Nothing fires while typing in a field or inside a dialog.
 *
 *   One hook for lists (useListKeyboard): `j`/`k` or ↑/↓ move a cursor
 *   over the rows, Enter opens, `a` approves and `d` declines when the
 *   list offers those. The hook owns the cursor and returns props for
 *   each row (`aria-selected`, a data attribute the CSS highlights, and
 *   scroll-into-view), so a page adds keyboard support in three lines.
 */

export type GoTo = { key: string; path: string; label: string };

export const GO_TO: ReadonlyArray<GoTo> = [
  { key: 'h', path: '/', label: 'Home' },
  { key: 'i', path: '/inbox', label: 'Inbox' },
  { key: 's', path: '/scheduling', label: 'Schedule' },
  { key: 'p', path: '/people', label: 'People' },
  { key: 'a', path: '/approvals', label: 'Approvals' },
  { key: 't', path: '/time-attendance?tab=queue', label: 'Timesheets' },
  { key: 'y', path: '/payroll', label: 'Payroll' },
  { key: 'b', path: '/books', label: 'Books' },
  { key: 'o', path: '/onboarding', label: 'Onboarding' },
  { key: 'r', path: '/transport', label: 'Transportation' },
  { key: ',', path: '/settings', label: 'Settings' },
];

/**
 * The go-to chords this person can use: a chord whose page isn't on their
 * nav (no capability, or the module is off for the company) is left out of
 * the listener and the shortcut list alike. Home and Settings are everyone's.
 */
export function useGoToTargets(): ReadonlyArray<GoTo> {
  const { user, can } = useAuth();
  const tenant = useTenant();
  return useMemo(() => {
    const paths = new Set(visibleModules(user?.role, can, { regionId: user?.regionId, modules: tenant.modules, tenantId: tenant.id }).map((m) => m.path));
    // Finance reaches the time queue as "Timesheets".
    if (paths.has('/timesheets')) paths.add('/time-attendance');
    return GO_TO.filter((g) => {
      const base = g.path.split('?')[0] ?? g.path;
      return base === '/' || base === '/settings' || paths.has(base);
    });
  }, [user?.role, user?.regionId, can, tenant.modules, tenant.id]);
}

const CHORD_MS = 1500;

/** True when a keystroke belongs to the thing the person is typing in. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable) return true;
  // Inside an open dialog or menu the page's shortcuts stand down.
  return !!el.closest?.('[role="dialog"], [role="menu"], [role="listbox"], [cmdk-root]');
}

/**
 * The chord resolver, pure: feed it keys in order; it answers with a path
 * when a chord completes, 'leader' when it is waiting for the second key,
 * or null. Exported for tests.
 */
export function resolveChord(prev: string | null, key: string, now: number, prevAt: number, targets: ReadonlyArray<GoTo> = GO_TO): { path: string | null; leader: boolean } {
  if (prev === 'g' && now - prevAt <= CHORD_MS) {
    const hit = targets.find((g) => g.key === key.toLowerCase());
    return { path: hit?.path ?? null, leader: false };
  }
  return { path: null, leader: key === 'g' };
}

export function GlobalShortcuts() {
  const navigate = useNavigate();
  const targets = useGoToTargets();
  const leader = useRef<{ key: string; at: number } | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      const r = resolveChord(leader.current?.key ?? null, e.key, Date.now(), leader.current?.at ?? 0, targets);
      if (r.path) {
        e.preventDefault();
        leader.current = null;
        navigate(r.path);
        return;
      }
      leader.current = r.leader ? { key: 'g', at: Date.now() } : null;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, targets]);
  return null;
}

export interface ListKeyboardOptions<T> {
  items: readonly T[];
  idOf: (item: T) => string;
  onOpen?: (item: T) => void;
  onApprove?: (item: T) => void;
  onDecline?: (item: T) => void;
  /** Off while a dialog on the page has the keyboard. */
  enabled?: boolean;
}

export interface ListKeyboard {
  cursor: string | null;
  setCursor: (id: string | null) => void;
  /** Spread on each row. */
  rowProps: (id: string) => { 'data-kb-cursor': 'true' | undefined; 'aria-selected': boolean; ref: (el: HTMLElement | null) => void };
  /** Spread on the list container. */
  listProps: { tabIndex: 0; onFocus: () => void; ref: (el: HTMLElement | null) => void };
}

/** A control that owns its own Enter: buttons, links, form fields, menu items. */
function isControlTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return !!target.closest(
    'button, a[href], select, summary, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="switch"], [role="option"]',
  );
}

export function useListKeyboard<T>({ items, idOf, onOpen, onApprove, onDecline, enabled = true }: ListKeyboardOptions<T>): ListKeyboard {
  const [cursor, setCursor] = useState<string | null>(null);
  const rows = useRef(new Map<string, HTMLElement>());
  const listEl = useRef<HTMLElement | null>(null);
  const ids = items.map(idOf);
  const current = cursor && ids.includes(cursor) ? cursor : null;

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      if (isTypingTarget(e.target)) return;
      if (ids.length === 0) return;
      const at = current ? ids.indexOf(current) : -1;
      const move = (next: number) => {
        e.preventDefault();
        const id = ids[Math.max(0, Math.min(ids.length - 1, next))]!;
        setCursor(id);
        rows.current.get(id)?.scrollIntoView?.({ block: 'nearest' });
      };
      // Arrows scroll the page unless the list itself has focus; Enter on a
      // button or link is that control's, never "open the cursor row".
      const inList = !!listEl.current && listEl.current.contains(document.activeElement);
      switch (e.key) {
        case 'j':
          return move(at + 1);
        case 'k':
          return move(at <= 0 ? 0 : at - 1);
        case 'ArrowDown':
          if (inList) move(at + 1);
          return;
        case 'ArrowUp':
          if (inList) move(at <= 0 ? 0 : at - 1);
          return;
        case 'Enter':
          if (isControlTarget(e.target)) return;
          if (current && onOpen) {
            e.preventDefault();
            onOpen(items[at]!);
          }
          return;
        case 'a':
          if (current && onApprove) {
            e.preventDefault();
            onApprove(items[at]!);
          }
          return;
        case 'd':
          if (current && onDecline) {
            e.preventDefault();
            onDecline(items[at]!);
          }
          return;
        case '?':
          openKeyboardShortcuts();
          return;
        default:
          return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // ids is derived from items; items is the dependency that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, items, current, onOpen, onApprove, onDecline]);

  const rowProps = useCallback(
    (id: string) => ({
      'data-kb-cursor': (current === id ? 'true' : undefined) as 'true' | undefined,
      'aria-selected': current === id,
      ref: (el: HTMLElement | null) => {
        if (el) rows.current.set(id, el);
        else rows.current.delete(id);
      },
    }),
    [current],
  );

  return {
    cursor: current,
    setCursor,
    rowProps,
    listProps: {
      tabIndex: 0,
      onFocus: () => { if (!current && ids[0]) setCursor(ids[0]); },
      ref: (el: HTMLElement | null) => { listEl.current = el; },
    },
  };
}
