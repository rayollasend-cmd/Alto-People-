import type { ReactNode } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';

/**
 * A list's filters, as the screen allows (role walk HR 15, floor 8): inline
 * on a wider screen; on a phone one chip — "Filters (2)" — that opens them
 * in a bottom sheet (the kit's Dialog is one on a phone: anchored to the
 * bottom edge, a grab handle, drag down to close), so the list is the first
 * screen instead of two screens of controls. The time queue's chip, made
 * reusable.
 */
export function FilterSheet({
  mobile,
  open,
  onOpenChange,
  summary,
  description = 'Narrow the list, then close to see it.',
  testId = 'filter-sheet-chip',
  children,
}: {
  /** Below the breakpoint: the chip and the sheet; otherwise the filters render as they are. */
  mobile: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The chip's text, e.g. "Filters (2)". */
  summary: string;
  description?: string;
  testId?: string;
  children: ReactNode;
}) {
  if (!mobile) return <>{children}</>;
  return (
    <>
      <button
        type="button"
        onClick={() => onOpenChange(true)}
        className="inline-flex h-9 items-center gap-1.5 self-start rounded-md border border-navy-secondary bg-navy-secondary/40 px-3 text-sm text-ink"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid={testId}
      >
        <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
        {summary}
      </button>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Filters</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">{children}</div>
          <DialogFooter>
            <Button variant="primary" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** "Filters" or "Filters (n)" — n is how many filters are off their default. */
export function filtersSummary(active: number): string {
  return active > 0 ? `Filters (${active})` : 'Filters';
}
