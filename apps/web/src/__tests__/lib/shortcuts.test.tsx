import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { GlobalShortcuts, isTypingTarget, resolveChord, useListKeyboard } from '@/lib/shortcuts';

// The chords follow what the person can open: an admin's full set here,
// narrowed in the books test below.
const auth = vi.hoisted(() => ({ caps: null as null | Set<string> }));
vi.mock('@/lib/auth', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth')>()),
  useAuth: () => ({ user: { id: 'me', role: 'HR_ADMINISTRATOR' }, can: (c: string) => auth.caps === null || auth.caps.has(c) }),
}));

/**
 * Access pack — keyboard support: g-then-key chords move between the main
 * surfaces; j/k/Enter/a/d work a list; nothing fires while typing.
 */

describe('resolveChord', () => {
  it('completes g→i within the window and not after it', () => {
    expect(resolveChord(null, 'g', 1000, 0)).toEqual({ path: null, leader: true });
    expect(resolveChord('g', 'i', 1500, 1000)).toEqual({ path: '/inbox', leader: false });
    expect(resolveChord('g', 'i', 9000, 1000)).toEqual({ path: null, leader: false });
    expect(resolveChord('g', 'z', 1500, 1000)).toEqual({ path: null, leader: false });
    expect(resolveChord(null, 'i', 1500, 1000)).toEqual({ path: null, leader: false });
  });
});

describe('isTypingTarget', () => {
  it('stands down inside fields and dialogs', () => {
    const input = document.createElement('input');
    expect(isTypingTarget(input)).toBe(true);
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const inner = document.createElement('button');
    dialog.appendChild(inner);
    document.body.appendChild(dialog);
    expect(isTypingTarget(inner)).toBe(true);
    const plain = document.createElement('div');
    expect(isTypingTarget(plain)).toBe(false);
  });
});

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname}</div>;
}

describe('<GlobalShortcuts>', () => {
  it('leaves out a chord whose page the person cannot open', () => {
    auth.caps = new Set(['view:dashboard', 'view:org']);
    try {
      render(
        <MemoryRouter initialEntries={['/']}>
          <GlobalShortcuts />
          <Routes>
            <Route path="*" element={<Where />} />
          </Routes>
        </MemoryRouter>,
      );
      fireEvent.keyDown(window, { key: 'g' });
      fireEvent.keyDown(window, { key: 'b' });
      expect(screen.getByTestId('where')).toHaveTextContent(/^\/$/);
    } finally {
      auth.caps = null;
    }
  });

  it('g then p goes to People; typing in a field does not', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <GlobalShortcuts />
        <Routes>
          <Route path="*" element={<><Where /><input aria-label="search" /></>} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.keyDown(window, { key: 'g' });
    fireEvent.keyDown(window, { key: 'p' });
    expect(screen.getByTestId('where')).toHaveTextContent('/people');
    const field = screen.getByLabelText('search');
    fireEvent.keyDown(field, { key: 'g' });
    fireEvent.keyDown(field, { key: 'h' });
    expect(screen.getByTestId('where')).toHaveTextContent('/people');
  });
});

describe('useListKeyboard', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  it('moves with j/k, opens with Enter, approves with a and declines with d', () => {
    const onOpen = vi.fn();
    const onApprove = vi.fn();
    const onDecline = vi.fn();
    const { result } = renderHook(() => useListKeyboard({ items, idOf: (i) => i.id, onOpen, onApprove, onDecline }));
    expect(result.current.cursor).toBeNull();
    act(() => { fireEvent.keyDown(window, { key: 'j' }); });
    expect(result.current.cursor).toBe('a');
    act(() => { fireEvent.keyDown(window, { key: 'j' }); });
    // ↓ outside the list scrolls the page; it only moves with focus inside.
    act(() => { fireEvent.keyDown(window, { key: 'ArrowDown' }); });
    expect(result.current.cursor).toBe('b');
    const list = document.createElement('ul');
    list.tabIndex = 0;
    document.body.appendChild(list);
    act(() => { result.current.listProps.ref(list); });
    list.focus();
    act(() => { fireEvent.keyDown(list, { key: 'ArrowDown' }); });
    expect(result.current.cursor).toBe('c');
    act(() => { fireEvent.keyDown(window, { key: 'j' }); });
    expect(result.current.cursor).toBe('c');
    act(() => { fireEvent.keyDown(window, { key: 'k' }); });
    expect(result.current.cursor).toBe('b');
    act(() => { fireEvent.keyDown(window, { key: 'Enter' }); });
    expect(onOpen).toHaveBeenCalledWith({ id: 'b' });
    act(() => { fireEvent.keyDown(window, { key: 'a' }); });
    expect(onApprove).toHaveBeenCalledWith({ id: 'b' });
    act(() => { fireEvent.keyDown(window, { key: 'd' }); });
    expect(onDecline).toHaveBeenCalledWith({ id: 'b' });
    expect(result.current.rowProps('b')['aria-selected']).toBe(true);
    expect(result.current.rowProps('a')['data-kb-cursor']).toBeUndefined();
    // Enter on a button is the button's, not "open the cursor row".
    const button = document.createElement('button');
    document.body.appendChild(button);
    onOpen.mockClear();
    act(() => { fireEvent.keyDown(button, { key: 'Enter' }); });
    expect(onOpen).not.toHaveBeenCalled();
    list.remove();
    button.remove();
  });

  it('does nothing while disabled', () => {
    const onApprove = vi.fn();
    const { result } = renderHook(() => useListKeyboard({ items, idOf: (i) => i.id, onApprove, enabled: false }));
    act(() => { fireEvent.keyDown(window, { key: 'j' }); });
    act(() => { fireEvent.keyDown(window, { key: 'a' }); });
    expect(result.current.cursor).toBeNull();
    expect(onApprove).not.toHaveBeenCalled();
  });
});
