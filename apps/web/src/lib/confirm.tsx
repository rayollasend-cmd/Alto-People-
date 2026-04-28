import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';

/**
 * Promise-based replacement for `window.confirm`. Mount <ConfirmProvider>
 * once near the app root, then anywhere in the tree:
 *
 *   const confirm = useConfirm();
 *   if (!(await confirm({ title: 'Delete this?', destructive: true }))) return;
 *
 * Renders a single shared <ConfirmDialog> so we don't pay the React/Radix
 * cost of one dialog instance per call site.
 */

export interface ConfirmOptions {
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

export interface PromptOptions extends ConfirmOptions {
  /** Label above the textarea. Defaults to "Reason". */
  reasonLabel?: string;
  reasonPlaceholder?: string;
  reasonMaxLength?: number;
  /** When true, an empty reason can't be submitted. Defaults to true. */
  required?: boolean;
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;
type PromptFn = (options: PromptOptions) => Promise<string | null>;

interface ConfirmContextValue {
  confirm: ConfirmFn;
  prompt: PromptFn;
}

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

interface PendingConfirm {
  kind: 'confirm';
  options: ConfirmOptions;
  resolve: (value: boolean) => void;
}

interface PendingPrompt {
  kind: 'prompt';
  options: PromptOptions;
  resolve: (value: string | null) => void;
}

type Pending = PendingConfirm | PendingPrompt;

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  // Tracks whether the active dialog was resolved via Confirm vs anything
  // else (Esc, overlay click, Cancel). Ref so it doesn't churn renders.
  const settledRef = useRef(false);

  const confirm = useCallback<ConfirmFn>((options) => {
    return new Promise<boolean>((resolve) => {
      settledRef.current = false;
      setPending({ kind: 'confirm', options, resolve });
    });
  }, []);

  const prompt = useCallback<PromptFn>((options) => {
    return new Promise<string | null>((resolve) => {
      settledRef.current = false;
      setPending({ kind: 'prompt', options, resolve });
    });
  }, []);

  const value = useMemoValue(confirm, prompt);

  const handleOpenChange = (open: boolean) => {
    if (open) return;
    if (!settledRef.current && pending) {
      // Closed via Esc / overlay / Cancel — decline path.
      if (pending.kind === 'confirm') pending.resolve(false);
      else pending.resolve(null);
    }
    setPending(null);
  };

  const handleConfirm = () => {
    if (!pending || pending.kind !== 'confirm') return;
    settledRef.current = true;
    pending.resolve(true);
    setPending(null);
  };

  const handlePromptConfirm = (reason: string) => {
    if (!pending || pending.kind !== 'prompt') return;
    settledRef.current = true;
    pending.resolve(reason);
    setPending(null);
  };

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      {pending?.kind === 'prompt' ? (
        <ConfirmDialog
          open={pending !== null}
          onOpenChange={handleOpenChange}
          title={pending.options.title}
          description={pending.options.description}
          confirmLabel={pending.options.confirmLabel}
          cancelLabel={pending.options.cancelLabel}
          destructive={pending.options.destructive}
          requireReason={pending.options.required === false ? 'optional' : true}
          reasonLabel={pending.options.reasonLabel}
          reasonPlaceholder={pending.options.reasonPlaceholder}
          reasonMaxLength={pending.options.reasonMaxLength}
          onConfirm={handlePromptConfirm}
        />
      ) : (
        <ConfirmDialog
          open={pending !== null}
          onOpenChange={handleOpenChange}
          title={pending?.options.title ?? ''}
          description={pending?.options.description}
          confirmLabel={pending?.options.confirmLabel}
          cancelLabel={pending?.options.cancelLabel}
          destructive={pending?.options.destructive}
          onConfirm={handleConfirm}
        />
      )}
    </ConfirmContext.Provider>
  );
}

// Tiny inline memo so the context value identity stays stable across renders.
function useMemoValue(confirm: ConfirmFn, prompt: PromptFn): ConfirmContextValue {
  return useRefStable({ confirm, prompt });
}

function useRefStable<T extends object>(value: T): T {
  const ref = useRef<T>(value);
  // Update fields in place; identity preserved.
  Object.assign(ref.current, value);
  return ref.current;
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) {
    throw new Error('useConfirm must be used inside <ConfirmProvider>');
  }
  return ctx.confirm;
}

export function usePrompt(): PromptFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) {
    throw new Error('usePrompt must be used inside <ConfirmProvider>');
  }
  return ctx.prompt;
}
