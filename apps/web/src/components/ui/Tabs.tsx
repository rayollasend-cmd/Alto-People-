import * as React from 'react';
import { cn } from '@/lib/cn';

/**
 * Underlined tab strip — the F500 / Rippling pattern. Replaces the four
 * hand-rolled tab implementations that grew up in compliance, benefits,
 * etc. Keyboard navigation: ArrowLeft/Right wrap, Home/End jump.
 *
 * Usage:
 *   <Tabs value={tab} onValueChange={setTab}>
 *     <TabsList>
 *       <TabsTrigger value="overview">Overview</TabsTrigger>
 *       <TabsTrigger value="settings">Settings</TabsTrigger>
 *     </TabsList>
 *     <TabsContent value="overview">…</TabsContent>
 *     <TabsContent value="settings">…</TabsContent>
 *   </Tabs>
 */

interface TabsContextValue {
  value: string;
  onValueChange: (value: string) => void;
  baseId: string;
  /** Values whose panel is mounted right now. A trigger only claims
   *  `aria-controls` for a panel that exists: strips that switch a view
   *  without a TabsContent (the live board, a status filter) pointed the
   *  selected tab at an id that was never in the document. */
  panels: ReadonlySet<string>;
  registerPanel: (value: string) => () => void;
}

const TabsContext = React.createContext<TabsContextValue | null>(null);

function useTabsContext(component: string): TabsContextValue {
  const ctx = React.useContext(TabsContext);
  if (!ctx) {
    throw new Error(`<${component}> must be used inside <Tabs>`);
  }
  return ctx;
}

interface TabsProps {
  value: string;
  onValueChange: (value: string) => void;
  className?: string;
  children: React.ReactNode;
}

export function Tabs({ value, onValueChange, className, children }: TabsProps) {
  const baseId = React.useId();
  const [panels, setPanels] = React.useState<ReadonlySet<string>>(() => new Set());
  const registerPanel = React.useCallback((panel: string) => {
    setPanels((prev) => (prev.has(panel) ? prev : new Set(prev).add(panel)));
    return () => {
      setPanels((prev) => {
        if (!prev.has(panel)) return prev;
        const next = new Set(prev);
        next.delete(panel);
        return next;
      });
    };
  }, []);
  const ctx = React.useMemo(
    () => ({ value, onValueChange, baseId, panels, registerPanel }),
    [value, onValueChange, baseId, panels, registerPanel],
  );
  return (
    <TabsContext.Provider value={ctx}>
      <div className={cn('w-full', className)}>{children}</div>
    </TabsContext.Provider>
  );
}

interface TabsListProps extends React.HTMLAttributes<HTMLDivElement> {
  className?: string;
}

export const TabsList = React.forwardRef<HTMLDivElement, TabsListProps>(
  ({ className, children, style, ...props }, ref) => {
    // On a phone a long strip scrolls sideways with its scrollbar hidden —
    // it read as cut off ("Depende…"). Fade the edge that has more tabs
    // past it, and keep the selected tab in view.
    const innerRef = React.useRef<HTMLDivElement | null>(null);
    const setRefs = (el: HTMLDivElement | null) => {
      innerRef.current = el;
      if (typeof ref === 'function') ref(el);
      else if (ref) ref.current = el;
    };
    const [edges, setEdges] = React.useState({ left: false, right: false });
    React.useEffect(() => {
      const el = innerRef.current;
      if (!el) return;
      const update = () =>
        setEdges({
          left: el.scrollLeft > 2,
          right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2,
        });
      update();
      el.addEventListener('scroll', update, { passive: true });
      const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
      ro?.observe(el);
      return () => {
        el.removeEventListener('scroll', update);
        ro?.disconnect();
      };
    }, []);
    const active = React.useContext(TabsContext)?.value;
    React.useEffect(() => {
      const el = innerRef.current;
      const sel = el?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      if (!el || !sel || el.scrollWidth <= el.clientWidth) return;
      // Horizontal only — never scroll the page to reach the strip.
      const left = sel.getBoundingClientRect().left - el.getBoundingClientRect().left + el.scrollLeft;
      if (left < el.scrollLeft || left + sel.offsetWidth > el.scrollLeft + el.clientWidth) {
        el.scrollLeft = Math.max(0, left - (el.clientWidth - sel.offsetWidth) / 2);
      }
    }, [active]);
    const mask =
      edges.left || edges.right
        ? `linear-gradient(to right, ${edges.left ? 'transparent, black 2rem' : 'black'}, ${
            edges.right ? 'black calc(100% - 2rem), transparent' : 'black'
          })`
        : undefined;
    const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;
      if (target.getAttribute('role') !== 'tab') return;
      const list = e.currentTarget;
      const triggers = Array.from(
        list.querySelectorAll<HTMLButtonElement>('[role="tab"]:not([disabled])'),
      );
      const idx = triggers.indexOf(target as HTMLButtonElement);
      if (idx < 0) return;
      let next: number;
      if (e.key === 'ArrowRight') next = (idx + 1) % triggers.length;
      else if (e.key === 'ArrowLeft') next = (idx - 1 + triggers.length) % triggers.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = triggers.length - 1;
      else return;
      e.preventDefault();
      triggers[next].focus();
      triggers[next].click();
    };
    return (
      <div
        ref={setRefs}
        role="tablist"
        onKeyDown={onKeyDown}
        style={mask ? { ...style, maskImage: mask, WebkitMaskImage: mask } : style}
        className={cn(
          // Single-row scrollable strip — keeps the bottom-border underline
          // pattern intact when there are too many tabs to fit on a phone.
          // `scrollbar-none` hides the scrollbar (we still get touch
          // / trackpad scrolling); the flex-nowrap forces the row layout.
          'flex flex-nowrap gap-1 border-b border-navy-secondary overflow-x-auto scrollbar-none',
          className,
        )}
        {...props}
      >
        {children}
      </div>
    );
  },
);
TabsList.displayName = 'TabsList';

interface TabsTriggerProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'value'> {
  value: string;
}

export const TabsTrigger = React.forwardRef<HTMLButtonElement, TabsTriggerProps>(
  ({ value, className, children, disabled, ...props }, ref) => {
    const { value: active, onValueChange, baseId, panels } = useTabsContext('TabsTrigger');
    const selected = value === active;
    return (
      <button
        ref={ref}
        type="button"
        role="tab"
        id={`${baseId}-trigger-${value}`}
        aria-selected={selected}
        aria-controls={panels.has(value) ? `${baseId}-content-${value}` : undefined}
        tabIndex={selected ? 0 : -1}
        disabled={disabled}
        onClick={() => onValueChange(value)}
        className={cn(
          // coarse: 44px touch target + 16px text, same treatment as every
          // other control in components/ui — tabs were the one holdout.
          'relative shrink-0 px-4 py-2.5 coarse:min-h-11 coarse:text-base text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright focus-visible:ring-offset-2 focus-visible:ring-offset-midnight',
          'disabled:opacity-50 disabled:pointer-events-none',
          selected
            ? 'border-gold text-gold'
            : 'border-transparent text-silver hover:text-white',
          className,
        )}
        {...props}
      >
        {children}
      </button>
    );
  },
);
TabsTrigger.displayName = 'TabsTrigger';

interface TabsContentProps extends React.HTMLAttributes<HTMLDivElement> {
  value: string;
}

export const TabsContent = React.forwardRef<HTMLDivElement, TabsContentProps>(
  ({ value, className, children, ...props }, ref) => {
    const { value: active, baseId, registerPanel } = useTabsContext('TabsContent');
    const selected = value === active;
    React.useLayoutEffect(
      () => (selected ? registerPanel(value) : undefined),
      [selected, value, registerPanel],
    );
    if (!selected) return null;
    return (
      <div
        ref={ref}
        role="tabpanel"
        id={`${baseId}-content-${value}`}
        aria-labelledby={`${baseId}-trigger-${value}`}
        tabIndex={0}
        className={cn('focus-visible:outline-none pt-5', className)}
        {...props}
      >
        {children}
      </div>
    );
  },
);
TabsContent.displayName = 'TabsContent';
