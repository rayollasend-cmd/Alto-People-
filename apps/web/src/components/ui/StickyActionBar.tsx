import * as React from 'react';
import { MoreHorizontal } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useMinWidth } from '@/lib/useViewport';
import { Button } from './Button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './DropdownMenu';

/**
 * The decision, on screen, on a phone (role walk HR 15).
 *
 * On a 390px screen a page's header row wraps or scrolls sideways, and the
 * one button the page exists for — Approve, Reject — ends up past the
 * edge or three screens down. Below `sm` this bar sits at the bottom of
 * the scrolling page (sticky, not fixed: the tab bar is a sibling below
 * <main>, so the bar rides just above it and never covers it), holding
 * the main decision, the decline beside it, everything else behind "More",
 * and one line saying why the decision is blocked when it is.
 *
 * Desktop keeps the page's own header buttons; the page hides its copies
 * of these with `hidden sm:inline-flex` so a phone never shows both.
 */

export interface StickyAction {
  label: React.ReactNode;
  onSelect: () => void;
  /** Shown in the alert tone (Reject, Cancel invite). */
  destructive?: boolean;
  disabled?: boolean;
  icon?: React.ReactNode;
}

export interface StickyActionBarProps {
  /** The main decision: usually one <Button>. */
  primary?: React.ReactNode;
  /** The decline beside it (Reject, Deny). */
  secondary?: React.ReactNode;
  /** The rest of the header's actions, behind one "More" button. */
  more?: StickyAction[];
  /** Why the primary is blocked, or what it will do ("3 of 8 tasks done"). */
  note?: React.ReactNode;
  /** Label of the overflow button (translated by the caller). */
  moreLabel?: string;
  /** The toolbar's name for assistive tech ("Decision"). */
  label?: string;
  /** The breakpoint from which the bar hides; the page's own buttons take over there. */
  hideFrom?: 'sm' | 'md';
  className?: string;
}

export function StickyActionBar({
  primary,
  secondary,
  more = [],
  note,
  moreLabel = 'More actions',
  label = 'Actions',
  hideFrom = 'sm',
  className,
}: StickyActionBarProps) {
  // Not just hidden by CSS from the breakpoint up — not rendered, so a
  // desktop never carries a second Approve in its accessibility tree.
  const wide = useMinWidth(hideFrom === 'md' ? 768 : 640);
  if (wide) return null;
  if (!primary && !secondary && more.length === 0) return null;
  return (
    <div
      role="toolbar"
      aria-label={label}
      data-testid="sticky-action-bar"
      className={cn(
        hideFrom === 'md' ? 'md:hidden' : 'sm:hidden',
        'sticky bottom-0 z-20 -mx-4 mt-4 border-t border-navy-secondary bg-navy/95 px-4 pt-2 pb-2 backdrop-blur',
        'elev-2 print:hidden',
        className,
      )}
    >
      {note && <p className="mb-1.5 truncate text-xs text-silver">{note}</p>}
      <div className="flex items-center gap-2">
        {more.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon-sm" className="h-11 w-11 shrink-0" aria-label={moreLabel}>
                <MoreHorizontal className="h-5 w-5" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="min-w-[13rem]">
              {more.map((a, i) => (
                <DropdownMenuItem
                  key={i}
                  destructive={a.destructive}
                  disabled={a.disabled}
                  onSelect={() => a.onSelect()}
                  className="min-h-11"
                >
                  {a.icon}
                  {a.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {secondary && <div className="flex min-w-0 flex-1 [&>*]:h-11 [&>*]:w-full">{secondary}</div>}
        {primary && <div className="flex min-w-0 flex-[2] [&>*]:h-11 [&>*]:w-full">{primary}</div>}
      </div>
    </div>
  );
}
