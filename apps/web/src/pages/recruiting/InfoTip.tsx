import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Info } from '@/components/ui/icons';
import { cn } from '@/lib/cn';

/**
 * An ⓘ that opens a short definition on tap or click (F500 2026-10-22: the
 * analytics sections carried their definitions as subtitles, and the board
 * printed its keyboard keys in prime space). A tap target, not a hover
 * tooltip, so it works on a phone; Escape or a click outside closes it.
 */
export function InfoTip({ label, children, className, align = 'start' }: { label: string; children: ReactNode; className?: string; align?: 'start' | 'end' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement | null>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('touchstart', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('touchstart', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <span ref={ref} className={cn('relative inline-flex align-middle', className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={label}
        className="inline-flex items-center justify-center rounded-full p-1 coarse:p-2 -m-1 coarse:-m-2 text-ink-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
      >
        <Info className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      {open && (
        <span
          id={id}
          role="note"
          className={cn(
            'absolute top-full z-30 mt-1.5 w-72 max-w-[80vw] rounded-md border border-silver/20 bg-navy-secondary px-3 py-2 text-xs font-normal normal-case leading-relaxed tracking-normal text-ink elev-2',
            align === 'end' ? 'right-0' : 'left-0',
          )}
        >
          {children}
        </span>
      )}
    </span>
  );
}
