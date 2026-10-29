import { useEffect, useId, useRef, useState } from 'react';
import { Check } from '@/components/ui/icons';
import { Button } from '@/components/ui/Button';
import { useConfirm } from '@/lib/confirm';
import { hapticConfirm } from '@/lib/haptics';
import { cn } from '@/lib/cn';

/**
 * Press and hold for an action that can't be taken back — the driver's
 * Complete run. Holding fills the button from the left; letting go early
 * cancels. A plain tap never acts: it asks first (the confirm dialog), so
 * a screen reader, a switch control or a driver who doesn't know about
 * holding still gets there, deliberately.
 */
export function HoldButton({
  children,
  holding: holdingLabel,
  hint,
  confirm: ask,
  onConfirm,
  disabled,
  variant = 'primary',
  ms = 1200,
  className,
}: {
  children: React.ReactNode;
  /** What the button says while it fills ("Keep holding…"). */
  holding: string;
  /** The line under it: how it works, and that it can't be undone. */
  hint: string;
  /** The tap fallback's question. */
  confirm: { title: string; description?: string; confirmLabel: string };
  onConfirm: () => void;
  disabled?: boolean;
  variant?: 'primary' | 'secondary';
  ms?: number;
  className?: string;
}) {
  const confirm = useConfirm();
  const hintId = useId();
  const [holding, setHolding] = useState(false);
  const timer = useRef<number | null>(null);
  // A hold that completed also ends in a click; that click must not ask.
  const fired = useRef(false);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);
  const start = () => {
    if (disabled || timer.current !== null) return;
    fired.current = false;
    setHolding(true);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      fired.current = true;
      setHolding(false);
      hapticConfirm();
      onConfirm();
    }, ms);
  };
  const cancel = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
  };
  const isKey = (e: React.KeyboardEvent) => e.key === ' ' || e.key === 'Enter';
  return (
    <div className={cn('space-y-1.5', className)}>
      <Button
        type="button"
        variant={variant}
        disabled={disabled}
        aria-describedby={hintId}
        className="relative h-14 w-full overflow-hidden text-lg font-semibold [-webkit-touch-callout:none] [touch-action:manipulation]"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          start();
        }}
        onPointerUp={cancel}
        onPointerLeave={cancel}
        onPointerCancel={cancel}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          if (!isKey(e)) return;
          e.preventDefault();
          if (!e.repeat) start();
        }}
        onKeyUp={(e) => {
          if (isKey(e)) cancel();
        }}
        onClick={async (e) => {
          e.preventDefault();
          if (fired.current) {
            fired.current = false;
            return;
          }
          // e.detail 0: a keyboard or assistive "click" that held nothing.
          cancel();
          const ok = await confirm({ ...ask, destructive: false });
          if (ok) onConfirm();
        }}
      >
        <span
          aria-hidden="true"
          data-testid="hold-fill"
          className={cn('absolute inset-y-0 left-0 bg-accent-on/20 ease-linear motion-reduce:transition-none', holding ? 'w-full transition-[width]' : 'w-0 transition-none')}
          style={holding ? { transitionDuration: `${ms}ms` } : undefined}
        />
        <span className="relative inline-flex items-center gap-2">
          <Check className="h-5 w-5" />
          {holding ? holdingLabel : children}
        </span>
      </Button>
      <p id={hintId} className="text-center text-sm text-ink-muted">
        {hint}
      </p>
    </div>
  );
}
