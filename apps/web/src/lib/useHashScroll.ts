import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * A link with a #section (a notification's "/#targets") lands on that
 * section. Pages draw after their data arrives, so the target is looked for
 * a few times over a couple of seconds before giving up quietly.
 */
export function useHashScroll(): void {
  const { hash, key } = useLocation();
  useEffect(() => {
    const id = decodeURIComponent(hash.replace(/^#/, ''));
    if (!id) return;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const look = () => {
      const el = document.getElementById(id);
      if (el) {
        el.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
        return;
      }
      if (++tries < 12) timer = setTimeout(look, 200);
    };
    look();
    return () => clearTimeout(timer);
  }, [hash, key]);
}
