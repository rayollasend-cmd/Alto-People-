import type { ReactNode } from 'react';
import { SlidersHorizontal } from '@/components/ui/icons';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { filterPillClass } from '@/components/ui/filterPill';

/**
 * A list's filters, as the screen allows (role walk HR 15, floor 8): inline
 * on a wider screen; on a phone one chip — "Filters (2)" — that opens them
 * in a bottom sheet (the kit's Dialog is one on a phone: anchored to the
 * bottom edge, a grab handle, drag down to close), so the list is the first
 * screen instead of two screens of controls. The time queue's chip, made
 * reusable. FilterBar uses it for every bar that knows its filters.
 */
export function FilterSheet({
  mobile,
  open,
  onOpenChange,
  summary,
  activeCount,
  onClear,
  description,
  testId = 'filter-sheet-chip',
  children,
}: {
  /** Below the breakpoint: the chip and the sheet; otherwise the filters render as they are. */
  mobile: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The chip's text, e.g. "Filters (2)". Default: built from `activeCount`. */
  summary?: string;
  /** How many filters are off their default; the chip shows it and turns gold. */
  activeCount?: number;
  /** Clears the filters; offered in the sheet while any are in use. */
  onClear?: () => void;
  description?: string;
  testId?: string;
  children: ReactNode;
}) {
  const { t } = useI18n();
  if (!mobile) return <>{children}</>;
  const active = activeCount ?? 0;
  const label = summary ?? (active > 0 ? t('filters.summaryCount', { count: active }) : t('filters.summary'));
  return (
    <>
      <button
        type="button"
        onClick={() => onOpenChange(true)}
        className={filterPillClass(active > 0, 'shrink-0 self-start')}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid={testId}
      >
        <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
        {label}
      </button>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('filters.title')}</DialogTitle>
            <DialogDescription>{description ?? t('filters.description')}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">{children}</div>
          <DialogFooter>
            {onClear && active > 0 && (
              <Button variant="ghost" onClick={onClear}>
                {t('filters.clear')}
              </Button>
            )}
            <Button variant="primary" onClick={() => onOpenChange(false)}>
              {t('filters.done')}
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
