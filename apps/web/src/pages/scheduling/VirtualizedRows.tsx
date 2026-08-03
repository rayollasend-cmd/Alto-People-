import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { cn } from '@/lib/cn';

/**
 * Roster rows, windowed once the roster gets big — shared by the calendar
 * week views (extracted from WeekCalendarView in the 2026-08 sweep so the
 * time-grid view could stop mounting its entire roster).
 *
 * The grids render one droppable per associate × day, and dnd-kit runs
 * collision detection against every registered droppable on each drag move
 * — so drag latency scaled with roster size rather than with what's on
 * screen. Below the threshold nothing changes: the plain path keeps the
 * page as the scroller, which is the familiar behaviour for a normal-sized
 * team. Past it the body becomes its own scroll container and only the
 * visible window is mounted. Rows can be variable height (a day with three
 * shifts is ~3× a day with one), so each row is measured via
 * `measureElement` rather than assumed — a fixed estimate would drift the
 * scrollbar on dense weeks.
 */
const VIRTUALIZE_ROWS_THRESHOLD = 60;
const ROW_OVERSCAN = 6;
const ROWS_CONTAINER_MAX_VH = 'max-h-[calc(100vh-320px)]';

export function VirtualizedRows({
  count,
  renderRow,
  estimateRowPx = 56,
}: {
  count: number;
  renderRow: (index: number) => React.ReactNode;
  /** Initial row-height guess before measurement (56 fits the pivot week
   *  view; the hour-axis time grid passes its much taller row height). */
  estimateRowPx?: number;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimateRowPx,
    overscan: ROW_OVERSCAN,
  });

  if (count <= VIRTUALIZE_ROWS_THRESHOLD) {
    return <>{Array.from({ length: count }, (_, i) => renderRow(i))}</>;
  }

  const items = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  const padTop = items.length > 0 ? items[0].start : 0;
  const padBottom =
    items.length > 0 ? totalSize - items[items.length - 1].end : 0;

  return (
    // overflow-x-clip is load-bearing, same reason as Layout.tsx:147 —
    // overflow-y:auto silently computes overflow-x to auto, which would make
    // this a horizontal scroll container too. The rail column is
    // `sticky left-0` and resolves against the nearest horizontal scroller,
    // so that would pin the rail to THIS box instead of the outer
    // overflow-x-auto and the names would stop tracking the day columns.
    // `clip` doesn't create a scroll container, so sticky still resolves out.
    <div
      ref={scrollRef}
      className={cn('overflow-y-auto overflow-x-clip', ROWS_CONTAINER_MAX_VH)}
    >
      {padTop > 0 && <div aria-hidden style={{ height: padTop }} />}
      {items.map((v) => (
        <div key={v.key} data-index={v.index} ref={virtualizer.measureElement}>
          {renderRow(v.index)}
        </div>
      ))}
      {padBottom > 0 && <div aria-hidden style={{ height: padBottom }} />}
    </div>
  );
}
