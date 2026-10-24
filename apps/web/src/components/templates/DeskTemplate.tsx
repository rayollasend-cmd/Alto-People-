import * as React from 'react';
import { UNSAFE_LocationContext, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/Button';
import { PageHeader, isPageActions, type PageAction, type PageFact } from '@/components/ui/PageHeader';
import type { BreadcrumbSegment } from '@/components/ui/Breadcrumb';

/**
 * Desk — a queue someone works (design system §4.5): approvals, the
 * compliance desk, the verifier's worklist, the platform support inbox,
 * agent proposals. The queue on the left, the open item on the right, the
 * action in the item, and closure (what happened, by whom) recorded where
 * the item was.
 *
 * Narrower than a laptop (below lg) the desk never hides its own queue:
 *   - `narrow="pick"` (default): the item is a record picked from the
 *     queue. The queue is the screen; once an item is OPEN the item takes
 *     the screen, and Back (the browser's, the phone's, or `backLabel`)
 *     returns to the queue.
 *   - `narrow="stack"`: the item column is a companion panel of the same
 *     desk (the control room's crew beside its exceptions): the queue, then
 *     the item, both always shown.
 *
 * The open item belongs in the URL, so a refresh or a shared link reopens
 * it and the phone's Back closes it: name the param with `itemParam` and
 * open/close it with `useDeskItem(param)`.
 *
 *   const desk = useDeskItem('case');
 *   <DeskTemplate title="Leave of absence" counts={<Badge>12 waiting</Badge>}
 *     filters={<SegmentedControl … />}
 *     queue={<QueueList onOpen={desk.open} … />}
 *     item={desk.openId ? <CaseView id={desk.openId} /> : <EmptyState title="Pick a case" />}
 *     itemParam="case" backLabel="All cases" />
 */
export interface DeskTemplateProps {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  topbarTitle?: string;
  /** Leave out for the nav's trail; `[]` for none. */
  breadcrumbs?: BreadcrumbSegment[];
  /** How many wait, by state — shown under the title, not among the actions. */
  counts?: React.ReactNode;
  /** The desk's actions: the PageHeader list, or (legacy) nodes. */
  actions?: PageAction[] | React.ReactNode;
  /** Key facts under the title. */
  facts?: PageFact[];
  /** The one filter row for the queue. */
  filters?: React.ReactNode;
  /** The queue. */
  queue: React.ReactNode;
  /** The open item (or the empty prompt). */
  item: React.ReactNode;
  /** True when an item is open (pick mode). With `itemParam` it is read from the URL. */
  itemOpen?: boolean;
  /** The URL search param that names the open item (`?case=…`). */
  itemParam?: string;
  /** Below lg: 'pick' — queue, then the picked item alone; 'stack' — queue then item, both shown. */
  narrow?: 'pick' | 'stack';
  /** Below lg, the open item's way back to the queue ("All cases"). Omit when the item draws its own. */
  backLabel?: string;
  /** What the back control does; with `itemParam`, closing the item is the default. */
  onBack?: () => void;
  className?: string;
}

export function DeskTemplate({
  title,
  subtitle,
  topbarTitle,
  breadcrumbs,
  counts,
  actions,
  facts,
  filters,
  queue,
  item,
  itemOpen,
  itemParam,
  narrow = 'pick',
  backLabel,
  onBack,
  className,
}: DeskTemplateProps) {
  // Read without requiring a router (a desk rendered alone in a test).
  const location = (React.useContext(UNSAFE_LocationContext) as { location?: { search: string } } | null)?.location;
  const paramOpen = itemParam ? new URLSearchParams(location?.search ?? '').has(itemParam) : false;
  const open = narrow === 'pick' && (itemOpen ?? paramOpen);
  const structured = isPageActions(actions) ? actions : undefined;
  return (
    <div className={cn('space-y-[var(--d-stack)]', className)} data-template="desk" data-narrow={narrow}>
      <PageHeader
        title={title}
        subtitle={subtitle}
        topbarTitle={topbarTitle}
        breadcrumbs={breadcrumbs}
        facts={facts}
        meta={counts}
        actions={structured}
        primaryAction={structured ? undefined : (actions as React.ReactNode)}
      />
      {filters}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <section aria-label="Queue" className={cn('min-w-0', open && 'hidden lg:block')}>
          {queue}
        </section>
        <section aria-label="Open item" className={cn('min-w-0', narrow === 'pick' && !open && 'hidden lg:block')}>
          {open && backLabel && <DeskBack label={backLabel} onBack={onBack} itemParam={itemParam} />}
          {item}
        </section>
      </div>
    </div>
  );
}

function DeskBack({ label, onBack, itemParam }: { label: string; onBack?: () => void; itemParam?: string }) {
  const desk = useDeskItem(itemParam ?? 'item');
  return (
    <Button variant="ghost" size="sm" className="mb-2 lg:hidden" onClick={onBack ?? desk.close}>
      <ArrowLeft className="h-4 w-4" aria-hidden="true" />
      {label}
    </Button>
  );
}

/**
 * A desk's open item, kept in the URL (`?<param>=<id>`).
 *
 * Opening from the queue is a step of its own (pushed), so the browser's
 * and the phone's Back close the item instead of leaving the desk; moving
 * from one open item to the next replaces it, so Back doesn't replay every
 * item looked at. `close()` steps back when the item was opened here, and
 * otherwise (a shared link straight to the item) drops the param in place.
 */
export function useDeskItem(param = 'item'): { openId: string | null; open: (id: string) => void; close: () => void } {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const openId = params.get(param);
  const openedHere = !!(location.state as { deskItem?: boolean } | null)?.deskItem;
  const open = React.useCallback(
    (id: string) => {
      if (id === openId) return;
      const next = new URLSearchParams(params);
      next.set(param, id);
      if (openId === null) setParams(next, { state: { deskItem: true } });
      else setParams(next, { replace: true, state: { deskItem: openedHere } });
    },
    [openId, openedHere, param, params, setParams],
  );
  const close = React.useCallback(() => {
    if (openId === null) return;
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (openedHere && idx > 0) {
      navigate(-1);
      return;
    }
    const next = new URLSearchParams(params);
    next.delete(param);
    setParams(next, { replace: true });
  }, [navigate, openId, openedHere, param, params, setParams]);
  return { openId, open, close };
}
