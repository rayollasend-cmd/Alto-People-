import { useEffect, useState } from 'react';
import { useChunkLoading } from '@/lib/chunkLoading';

/**
 * Top progress bar shown when route navigation is pending — typically
 * because the next page's lazy chunk is still streaming. We start at 0,
 * delay 200ms before becoming visible (so cached navigations don't flash
 * a bar), then animate to ~80% via CSS while the chunk fetch is in
 * flight, then snap to 100% and fade out when it lands.
 *
 * The signal comes from `lib/chunkLoading`, which every lazy route reports
 * into as its chunk is fetched. It used to come from react-router's
 * `useNavigation()`, but no route in this app declares a `loader`, so that
 * state never left 'idle' and this bar never rendered once. A chunk fetch
 * is the real thing the user waits on, and on a slow connection it is the
 * only sign that the tap registered at all.
 *
 * Brand-consistent: thin gold gradient. Sits above the topbar with a
 * subtle blur shadow for contrast against any background.
 */
export function NavigationProgress() {
  const loading = useChunkLoading();
  const [visible, setVisible] = useState(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (loading) {
      // Defer first paint until after 200ms — a fast cache hit will
      // resolve before then and the bar never appears.
      const showTimer = setTimeout(() => setVisible(true), 200);
      // Bump from 0 → ~80% over the first second so the bar visibly
      // *moves*, even though we have no actual progress signal from the
      // chunk fetch. The asymptote at 80% avoids the lying "100% but
      // still waiting" feel.
      let p = 0;
      const interval = setInterval(() => {
        p = Math.min(80, p + (80 - p) * 0.12);
        setProgress(p);
      }, 100);
      return () => {
        clearTimeout(showTimer);
        clearInterval(interval);
      };
    }
    // Done — snap to 100, hold long enough for the fade, then reset.
    if (visible) {
      setProgress(100);
      const hideTimer = setTimeout(() => {
        setVisible(false);
        setProgress(0);
      }, 200);
      return () => clearTimeout(hideTimer);
    }
    setProgress(0);
    return undefined;
  }, [loading, visible]);

  if (!visible && progress === 0) return null;

  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(progress)}
      aria-label="Loading page"
      className="fixed top-0 left-0 right-0 z-[100] h-0.5 pointer-events-none"
    >
      <div
        className="h-full bg-gradient-to-r from-gold via-gold-bright to-gold shadow-[0_0_8px_rgba(212,175,55,0.6)] transition-[width,opacity] duration-200 ease-out"
        style={{
          width: `${progress}%`,
          opacity: visible ? 1 : 0,
        }}
      />
    </div>
  );
}
