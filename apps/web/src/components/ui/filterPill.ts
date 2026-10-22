import { cn } from '@/lib/cn';

/* ---- one look for every filter control ---------------------------------
 * The app had three: rounded-rect outline chips (FilterChip), gold pills
 * (SegmentedControl), and chips forced to UPPERCASE by the page. This is
 * the one recipe both controls draw with: a pill, sentence case, the same
 * height, the one selection colour (gold tint), and a count when given.
 */
export function filterPillClass(selected: boolean, className?: string): string {
  return cn(
    'inline-flex h-8 items-center justify-center gap-1.5 rounded-full border px-3 text-sm font-normal transition-colors',
    'focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright/60 focus-visible:ring-offset-0',
    'disabled:cursor-not-allowed disabled:opacity-50',
    // A finger needs 44px on any touch device, phone or tablet.
    'coarse:h-auto coarse:min-h-11',
    selected
      ? 'border-gold/60 bg-gold/15 text-gold hover:border-gold hover:text-gold'
      : // silver/60: an unselected chip's border is its only outline, so it clears 3:1 (WCAG 1.4.11).
        'border-silver/60 bg-transparent text-silver hover:border-silver/80 hover:text-ink',
    className,
    // Always sentence case: a page's `uppercase tracking-wider` was the
    // third look (Reviews, Goals). Last, so it wins the merge.
    'normal-case tracking-normal',
  );
}

