import { useEffect, useMemo, useState } from 'react';
import { useGoToTargets } from '@/lib/shortcuts';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { homeLabel, localizeModule } from '@/lib/navI18n';
import { MODULES } from '@/lib/modules';
import '@/lib/i18n/en/top';
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
  label: MessageKey;
  /** A key, or (the go-to chords) the page's name already in the reader's words. */
  items: Array<{ keys: string[]; description: MessageKey | { text: string } }>;
}

const SHORTCUTS: ShortcutGroup[] = [
  {
    label: 'top.kbGroupNav',
    items: [
      { keys: ['⌘', 'K'], description: 'top.kbPalette' },
      { keys: ['⌘', 'J'], description: 'top.kbAssistant' },
      // The go-to chords (g then a key) are added per person — only the
      // pages they can open (useGoToTargets).
      { keys: ['Esc'], description: 'top.kbEsc' },
      { keys: ['?'], description: 'top.kbHelp' },
    ],
  },
  {
    label: 'top.kbGroupLists',
    items: [
      { keys: ['j', 'k'], description: 'top.kbDownUp' },
      { keys: ['Enter'], description: 'top.kbOpenRow' },
      { keys: ['a'], description: 'top.kbApprove' },
      { keys: ['d'], description: 'top.kbDecline' },
    ],
  },
  {
    label: 'top.kbGroupBoard',
    items: [
      { keys: ['[', ']'], description: 'top.kbPrevNextDay' },
      { keys: ['t', 'm'], description: 'top.kbTodayTomorrow' },
      { keys: ['j', 'k'], description: 'top.kbGroups' },
      { keys: ['x'], description: 'top.kbPickGroup' },
      { keys: ['d'], description: 'top.kbDispatch' },
      { keys: ['p'], description: 'top.kbPlanRuns' },
    ],
  },
  {
    label: 'top.kbGroupTables',
    items: [
      { keys: ['j', 'k'], description: 'top.kbCursor' },
      { keys: ['Enter'], description: 'top.kbOpenCursor' },
      { keys: ['x'], description: 'top.kbSelectCursor' },
      { keys: ['Shift', 'click'], description: 'top.kbSelectRange' },
      { keys: ['↑', '↓'], description: 'top.kbTableTabs' },
      { keys: ['←', '→'], description: 'top.kbSwitchTabs' },
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
  const goTo = useGoToTargets();
  const { t } = useI18n();
  const groups = useMemo<ShortcutGroup[]>(
    () =>
      SHORTCUTS.map((g, i) =>
        i === 0
          ? {
              ...g,
              items: [
                ...g.items.slice(0, 2),
                ...goTo.map((g) => ({
                  keys: ['g', g.key],
                  description: { text: g.path === '/' ? t('top.kbGoTo', { name: homeLabel(t) }) : t('top.kbGoTo', { name: localizeModule(MODULES.find((m) => m.path === g.path), t)?.label ?? g.label }) },
                })),
                ...g.items.slice(2),
              ],
            }
          : g,
      ),
    [goTo, t],
  );
  const [pressBefore, pressAfter] = t('top.kbPress').split('{key}');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('top.shortcuts')}</DialogTitle>
          <DialogDescription>
            {pressBefore}<Kbd>?</Kbd>{pressAfter}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          {groups.map((group) => (
            <section key={group.label}>
              <h3 className="text-2xs uppercase tracking-widest text-silver mb-2">
                {t(group.label)}
              </h3>
              <ul className="grid gap-1.5">
                {group.items.map((item) => {
                  const text = typeof item.description === 'string' ? t(item.description) : item.description.text;
                  return (
                  <li
                    key={text}
                    className="flex items-center justify-between gap-3 text-sm"
                  >
                    <span className="text-white">{text}</span>
                    <span className="flex items-center gap-1">
                      {item.keys.map((k) => (
                        <Kbd key={k}>{k}</Kbd>
                      ))}
                    </span>
                  </li>
                  );
                })}
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

/** Custom event other components dispatch to ask the overlay to open. */
export const OPEN_KEYBOARD_SHORTCUTS_EVENT = 'alto:open-keyboard-shortcuts';

/** Helper that dispatches the open event from anywhere in the tree. */
export function openKeyboardShortcuts(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(OPEN_KEYBOARD_SHORTCUTS_EVENT));
}

/**
 * Hook: wires the global `?` keydown handler. Skips when the user is
 * typing in an input/textarea/contenteditable (so `?` in a Reason field
 * doesn't pop the overlay). Also listens for the custom open event so
 * menu items elsewhere can pop the overlay without prop-drilling.
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
    const onOpenEvent = () => setOpen(true);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener(OPEN_KEYBOARD_SHORTCUTS_EVENT, onOpenEvent);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener(OPEN_KEYBOARD_SHORTCUTS_EVENT, onOpenEvent);
    };
  }, []);

  return { open, setOpen };
}
