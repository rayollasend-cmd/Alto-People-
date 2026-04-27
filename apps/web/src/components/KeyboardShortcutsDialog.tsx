import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';

/**
 * Phase 69 — global keyboard-shortcut overlay. Press `?` (or shift+/)
 * anywhere in the app to see what's available. Designed to be cheap:
 * one global keydown listener, the dialog's content is static.
 *
 * The shortcuts listed here mirror what the rest of the app already
 * implements (CommandPalette opens on Cmd-K). When a new shortcut is
 * added elsewhere, drop it into the SHORTCUTS array below.
 */

interface ShortcutGroup {
  label: string;
  items: Array<{ keys: string[]; description: string }>;
}

const SHORTCUTS: ShortcutGroup[] = [
  {
    label: 'Navigation',
    items: [
      { keys: ['⌘', 'K'], description: 'Open command palette (search & jump)' },
      { keys: ['Esc'], description: 'Close dialogs and overlays' },
      { keys: ['?'], description: 'Show this overlay' },
    ],
  },
  {
    label: 'Tables',
    items: [
      { keys: ['↑', '↓'], description: 'Move between table tabs' },
      { keys: ['←', '→'], description: 'Switch tabs (in tab strips)' },
    ],
  },
];

interface KeyboardShortcutsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function KeyboardShortcutsDialog({
  open,
  onOpenChange,
}: KeyboardShortcutsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Press <Kbd>?</Kbd> any time to show this list.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          {SHORTCUTS.map((group) => (
            <section key={group.label}>
              <h3 className="text-[10px] uppercase tracking-widest text-silver mb-2">
                {group.label}
              </h3>
              <ul className="grid gap-1.5">
                {group.items.map((item) => (
                  <li
                    key={item.description}
                    className="flex items-center justify-between gap-3 text-sm"
                  >
                    <span className="text-white">{item.description}</span>
                    <span className="flex items-center gap-1">
                      {item.keys.map((k) => (
                        <Kbd key={k}>{k}</Kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex items-center justify-center min-w-[1.5rem] px-1.5 h-6 rounded border border-navy-secondary bg-navy-secondary/40 text-xs font-mono text-silver">
      {children}
    </kbd>
  );
}

/**
 * Hook: wires the global `?` keydown handler. Skips when the user is
 * typing in an input/textarea/contenteditable (so `?` in a Reason field
 * doesn't pop the overlay).
 */
export function useKeyboardShortcutsHook() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== '?') return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      setOpen(true);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return { open, setOpen };
}
