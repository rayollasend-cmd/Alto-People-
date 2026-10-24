import { useEffect, useState } from 'react';

/**
 * Whether the command palette is open, and ⌘K / Ctrl-K to toggle it — apart
 * from the palette itself, so the shell can listen for the shortcut without
 * loading the palette (Layout fetches it on first open, or when idle).
 */
export function useCommandPalette() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Cmd-K on macOS, Ctrl-K elsewhere.
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return { open, setOpen };
}
