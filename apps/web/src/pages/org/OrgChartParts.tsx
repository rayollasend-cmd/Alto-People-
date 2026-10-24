import { useVirtualizer, type VirtualItem } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Building2,
  ChevronDown,
  ChevronRight,
  CornerLeftUp,
  ExternalLink,
  Map as MapIcon,
  Minus,
  Plus,
  Store,
  UserPlus,
  Users,
  UserCog,
  Settings2,
  MoveRight,
} from '@/components/ui/icons';
import type { Role, TermKey } from '@alto-people/shared';
import type { OrgNode } from '@/lib/orgChartApi';
import { setStaffReportsTo } from '@/lib/orgChartApi';
import { assignOrgFields } from '@/lib/orgApi';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { Avatar } from '@/components/ui/Avatar';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Select,
} from '@/components/ui';
import { PALETTE, ancestorsOf, descendantIds, managerChoices, type OrgIndex } from './orgChartModel';
import { enumWords, known } from '@/lib/known';

/**
 * The org chart's drawing: one card for every kind of node, the chart
 * canvas (a focused node, its team, and each member's own team stacked
 * beneath — pan by dragging, zoom with the buttons or ctrl+scroll), the
 * accessible list (a real tree: arrows move, right opens, left closes),
 * and the "Reports to" dialog.
 */

/**
 * Structure editing on the field chart (StructureEditor.tsx): a details
 * drawer for a region / client / store, "Move to region…" for a store, and
 * the drop that moves a dragged store onto a region (null = no region).
 */
export interface StructureActions {
  onDetails: (n: OrgNode) => void;
  onMove: (store: OrgNode) => void;
  onDropStore: (siteId: string, regionNodeId: string | null) => void;
  /** Every region on the chart, for the drop bar while a store is dragged. */
  regions: OrgNode[];
}

const SITE_DRAG = 'application/x-alto-site';
const STRUCTURE_KINDS: ReadonlyArray<OrgNode['kind']> = ['region', 'client', 'store'];

export interface Painter {
  /** The palette slot for a node, or null when not colouring. */
  slotOf: (n: OrgNode) => number | null;
  roleLabel: (r: Role) => string;
  term: (k: TermKey) => string;
}

/**
 * How a node is named on a card: an account with no display name is named
 * by its email, which broke across two lines at the @ ("manager /
 * @altohr.com"). Show the part before the @ — the role is the line under
 * it — and keep the full address in the tooltip and in search.
 */
export function displayName(name: string): string {
  const at = name.indexOf('@');
  return at > 0 && !/\s/.test(name) ? name.slice(0, at) : name;
}

function NameText({ name }: { name: string }) {
  const shown = displayName(name);
  if (shown === name) return <>{name}</>;
  return <span title={name}>{shown}</span>;
}

const SEAT_STATUS: Record<'PLANNED' | 'OPEN' | 'FROZEN', { label: string; variant: 'pending' | 'success' | 'info' }> = {
  PLANNED: { label: 'Awaiting approval', variant: 'pending' },
  OPEN: { label: 'Hiring', variant: 'success' },
  FROZEN: { label: 'On hold', variant: 'info' },
};
/** SEAT_STATUS for a value from the server — one this screen doesn't know yet reads as words (lib/known). */
const seatStatusOf = (k: string) => known(SEAT_STATUS, k, () => ({ label: enumWords(k), variant: 'info' as const }));

/** The line under a name: title, role and shifts, or what a structure node holds. */
export function describe(n: OrgNode, index: OrgIndex, p: Painter): string {
  const team = index.teamSize.get(n.id) ?? 0;
  switch (n.kind) {
    case 'lead':
      return [n.role ? p.roleLabel(n.role) : null, n.shiftLabels && n.shiftLabels.length ? n.shiftLabels.join(', ') : n.shiftLabels ? null : `every ${p.term('label.store').toLowerCase()}`]
        .filter(Boolean)
        .join(' · ');
    case 'staff':
    case 'person':
      return [n.subtitle ?? (n.role ? p.roleLabel(n.role) : null), n.departmentName].filter(Boolean).join(' · ') || 'No title yet';
    case 'vacancy':
      return n.subtitle ? `Open seat · ${n.subtitle}` : 'Open seat';
    case 'store':
      return `${n.reports} on the ${p.term('label.store').toLowerCase()}`;
    case 'client': {
      const stores = (index.children.get(n.id) ?? []).filter((c) => c.kind === 'store').length;
      return `${stores} ${stores === 1 ? p.term('label.store').toLowerCase() : p.term('label.stores').toLowerCase()} · ${team} people`;
    }
    case 'region':
      return `Region · ${team} people`;
    case 'group':
      return n.subtitle ?? '';
  }
}

function KindIcon({ kind }: { kind: OrgNode['kind'] }) {
  const Icon = kind === 'region' ? MapIcon : kind === 'client' ? Building2 : kind === 'store' ? Store : kind === 'vacancy' ? UserPlus : Users;
  return (
    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-surface-raised text-ink-muted" aria-hidden="true">
      <Icon className="h-4 w-4" />
    </span>
  );
}

/** Today's coverage on a store: filled of scheduled, green when whole. */
function Coverage({ n }: { n: OrgNode }) {
  if (n.shiftsToday === null) return null;
  if (n.shiftsToday === 0) return <span className="block text-2xs text-ink-muted">No shifts today</span>;
  const whole = n.filledToday === n.shiftsToday;
  return (
    <span className={cn('block text-2xs tabular-nums', whole ? 'text-success' : 'text-warning')}>
      {n.filledToday} of {n.shiftsToday} shifts filled today
    </span>
  );
}

export function OrgCard({
  n,
  index,
  painter,
  highlighted,
  compact,
  onFocus,
  onEdit,
  structure,
  onDragState,
}: {
  n: OrgNode;
  index: OrgIndex;
  painter: Painter;
  highlighted?: boolean;
  compact?: boolean;
  onFocus?: (n: OrgNode) => void;
  onEdit?: (n: OrgNode) => void;
  structure?: StructureActions;
  /** The canvas hears when a store starts and stops being dragged. */
  onDragState?: (siteId: string | null) => void;
}) {
  const [dropping, setDropping] = useState(false);
  const slot = painter.slotOf(n);
  const draggableStore = !!structure && n.kind === 'store';
  const dropTarget = !!structure && n.kind === 'region';
  const isPerson = n.kind === 'person' || n.kind === 'staff' || n.kind === 'lead';
  const team = index.teamSize.get(n.id) ?? 0;
  // A store whose crew loads on demand still has a team to open.
  const hasTeam = (index.children.get(n.id) ?? []).length > 0 || (n.kind === 'store' && n.reports > 0);
  return (
    <div
      data-node={n.id}
      draggable={draggableStore || undefined}
      onDragStart={
        draggableStore
          ? (e) => {
              e.dataTransfer.setData(SITE_DRAG, n.id.slice(2));
              e.dataTransfer.effectAllowed = 'move';
              onDragState?.(n.id.slice(2));
            }
          : undefined
      }
      onDragEnd={draggableStore ? () => onDragState?.(null) : undefined}
      onDragOver={
        dropTarget
          ? (e) => {
              if (!e.dataTransfer.types.includes(SITE_DRAG)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              setDropping(true);
            }
          : undefined
      }
      onDragLeave={dropTarget ? () => setDropping(false) : undefined}
      onDrop={
        dropTarget
          ? (e) => {
              e.preventDefault();
              setDropping(false);
              const siteId = e.dataTransfer.getData(SITE_DRAG);
              if (siteId) structure!.onDropStore(siteId, n.id);
            }
          : undefined
      }
      className={cn(
        'group relative flex items-center gap-2.5 rounded-lg border bg-surface text-left',
        draggableStore && 'cursor-grab active:cursor-grabbing',
        dropping && 'ring-2 ring-accent ring-offset-2',
        compact ? 'w-56 px-2.5 py-1.5' : 'w-60 px-3 py-2.5',
        n.kind === 'vacancy' ? 'border-dashed border-line' : 'border-line',
        slot !== null && 'border-l-4',
        slot !== null && PALETTE[slot]!.border,
        highlighted && 'ring-2 ring-accent',
        n.former && 'opacity-70',
      )}
    >
      {isPerson ? <Avatar src={n.photoUrl} name={n.name} size={compact ? 'xs' : 'sm'} /> : <KindIcon kind={n.kind} />}
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={() => onFocus?.(n)}
          disabled={!onFocus || !hasTeam}
          className="line-clamp-2 block w-full break-words text-left text-sm font-medium leading-snug text-ink enabled:hover:underline disabled:cursor-default"
          title={hasTeam ? `Show ${n.name}’s team` : n.name}
        >
          <NameText name={n.name} />
        </button>
        <div className="truncate text-xs text-ink-muted">{describe(n, index, painter)}</div>
        {!compact && n.kind === 'store' && <Coverage n={n} />}
        {!compact && n.kind === 'vacancy' && n.positionStatus && (
          <Badge size="sm" variant={seatStatusOf(n.positionStatus).variant} className="mt-1">
            {seatStatusOf(n.positionStatus).label}
          </Badge>
        )}
        {!compact && n.former && (
          <Badge size="sm" variant="outline" className="mt-1">
            Former
          </Badge>
        )}
        {!compact && hasTeam && team > 0 && isPerson && (
          <div className="mt-0.5 text-2xs text-ink-muted">
            {team} in {n.kind === 'lead' ? 'their crew' : 'their team'}
          </div>
        )}
      </div>
      <div className="flex shrink-0 flex-col gap-0.5">
        {n.associateId && (
          <Link
            to={`/people/${n.associateId}`}
            className="grid h-7 w-7 place-items-center rounded text-ink-muted hover:bg-surface-raised hover:text-ink coarse:h-10 coarse:w-10"
            aria-label={`Open ${n.name}’s record`}
            title="Open their record"
          >
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        )}
        {onEdit && (n.kind === 'person' || n.kind === 'staff') && !n.former && (
          <button
            type="button"
            onClick={() => onEdit(n)}
            className="grid h-7 w-7 place-items-center rounded text-ink-muted hover:bg-surface-raised hover:text-ink coarse:h-10 coarse:w-10"
            aria-label={`Change who ${n.name} reports to`}
            title="Reports to…"
          >
            <UserCog className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
        {structure && STRUCTURE_KINDS.includes(n.kind) && (
          <button
            type="button"
            onClick={() => structure.onDetails(n)}
            className="grid h-7 w-7 place-items-center rounded text-ink-muted hover:bg-surface-raised hover:text-ink coarse:h-10 coarse:w-10"
            aria-label={`Details for ${n.name}`}
            title="Details"
          >
            <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
        {structure && n.kind === 'store' && (
          <button
            type="button"
            onClick={() => structure.onMove(n)}
            className="grid h-7 w-7 place-items-center rounded text-ink-muted hover:bg-surface-raised hover:text-ink coarse:h-10 coarse:w-10"
            aria-label={`Move ${n.name} to a region`}
            title="Move to region…"
          >
            <MoveRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * While a store is dragged, every region is a drop target here — the
 * focused view may not show the region it should go to.
 */
function RegionDropBar({ structure, onDone }: { structure: StructureActions; onDone: () => void }) {
  const [over, setOver] = useState<string | null>(null);
  const targets: Array<{ id: string | null; name: string }> = [...structure.regions.map((r) => ({ id: r.id, name: r.name })), { id: null, name: 'No region' }];
  return (
    <div role="group" aria-label="Drop on a region to move the store" className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-line bg-surface/95 p-2 backdrop-blur">
      <span className="text-xs text-ink-muted">Move to</span>
      {targets.map((t) => (
        <div
          key={t.id ?? 'none'}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(SITE_DRAG)) return;
            e.preventDefault();
            setOver(t.id ?? 'none');
          }}
          onDragLeave={() => setOver(null)}
          onDrop={(e) => {
            e.preventDefault();
            const siteId = e.dataTransfer.getData(SITE_DRAG);
            setOver(null);
            onDone();
            if (siteId) structure.onDropStore(siteId, t.id);
          }}
          className={cn('rounded-full border px-3 py-1 text-xs', over === (t.id ?? 'none') ? 'border-accent bg-accent-fill/15 text-ink' : 'border-dashed border-line text-ink-muted')}
        >
          {t.name}
        </div>
      ))}
    </div>
  );
}

/* ----- The chart canvas ------------------------------------------------- */

const STACK = 5;

export function ChartCanvas({
  index,
  focusId,
  setFocus,
  highlightId,
  painter,
  topLabel,
  onEdit,
  structure,
}: {
  index: OrgIndex;
  focusId: string | null;
  setFocus: (id: string | null) => void;
  highlightId: string | null;
  painter: Painter;
  topLabel: string;
  onEdit?: (n: OrgNode) => void;
  structure?: StructureActions;
}) {
  const [draggingSite, setDraggingSite] = useState<string | null>(null);
  const focus = focusId ? (index.byId.get(focusId) ?? null) : null;
  const path = focus ? ancestorsOf(index, focus.id) : [];
  const team = index.children.get(focus?.id ?? null) ?? [];
  const [zoom, setZoom] = useState(1);
  const scroller = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);

  // A searched-for card scrolls into view.
  useEffect(() => {
    if (!highlightId) return;
    const el = scroller.current?.querySelector(`[data-node="${CSS.escape(highlightId)}"]`);
    (el as HTMLElement | null)?.scrollIntoView?.({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }, [highlightId, focusId]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button,a,[draggable="true"]')) return;
    const el = scroller.current;
    if (!el) return;
    drag.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
    el.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = scroller.current;
    if (!drag.current || !el) return;
    el.scrollLeft = drag.current.left - (e.clientX - drag.current.x);
    el.scrollTop = drag.current.top - (e.clientY - drag.current.y);
  };
  const endDrag = () => {
    drag.current = null;
  };
  const clampZoom = (z: number) => Math.min(1.5, Math.max(0.5, Math.round(z * 10) / 10));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <nav aria-label="Where you are in the chart" className="flex min-w-0 flex-wrap items-center gap-1 text-sm">
          <button type="button" className={cn('rounded px-1.5 py-0.5 hover:bg-surface-raised', !focus ? 'font-medium text-ink' : 'text-ink-muted')} onClick={() => setFocus(null)}>
            {topLabel}
          </button>
          {[...path, ...(focus ? [focus] : [])].map((n, i, all) => (
            <span key={n.id} className="flex items-center gap-1">
              <ChevronRight className="h-3.5 w-3.5 text-ink-muted" aria-hidden="true" />
              <button
                type="button"
                className={cn('max-w-[12rem] truncate rounded px-1.5 py-0.5 hover:bg-surface-raised', i === all.length - 1 ? 'font-medium text-ink' : 'text-ink-muted')}
                onClick={() => setFocus(n.id)}
                aria-current={i === all.length - 1 ? 'location' : undefined}
                title={n.name}
              >
                {displayName(n.name)}
              </button>
            </span>
          ))}
        </nav>
        <div className="flex items-center gap-1">
          {focus && (
            <Button size="sm" variant="ghost" onClick={() => setFocus(focus.parentId)}>
              <CornerLeftUp className="h-3.5 w-3.5" aria-hidden="true" />
              Up one level
            </Button>
          )}
          <Button size="icon-sm" variant="ghost" aria-label="Zoom out" onClick={() => setZoom((z) => clampZoom(z - 0.1))} disabled={zoom <= 0.5}>
            <Minus className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
          <button type="button" className="w-12 text-center text-xs tabular-nums text-ink-muted hover:text-ink" onClick={() => setZoom(1)} aria-label="Reset zoom">
            {Math.round(zoom * 100)}%
          </button>
          <Button size="icon-sm" variant="ghost" aria-label="Zoom in" onClick={() => setZoom((z) => clampZoom(z + 0.1))} disabled={zoom >= 1.5}>
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        </div>
      </div>

      <div
        ref={scroller}
        data-testid="org-canvas"
        className="relative max-h-[70vh] min-h-[22rem] cursor-grab overflow-auto rounded-lg border border-line bg-sunken active:cursor-grabbing print:max-h-none print:overflow-visible"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onWheel={(e) => {
          if (!e.ctrlKey && !e.metaKey) return;
          e.preventDefault();
          setZoom((z) => clampZoom(z - Math.sign(e.deltaY) * 0.1));
        }}
      >
        {structure && draggingSite && <RegionDropBar structure={structure} onDone={() => setDraggingSite(null)} />}
        <div className="inline-flex min-w-full origin-top flex-col items-center p-8" style={{ transform: `scale(${zoom})` }}>
          {focus && (
            <>
              <OrgCard n={focus} index={index} painter={painter} highlighted={highlightId === focus.id} onEdit={onEdit} structure={structure} onDragState={setDraggingSite} />
              {team.length > 0 && <div className="h-6 w-px bg-line" aria-hidden="true" />}
            </>
          )}
          {team.length > 0 && (
            <ul
              className={cn('relative flex items-start gap-6', focus ? 'pt-6' : 'max-w-[80rem] flex-wrap justify-center')}
              aria-label={focus ? `${focus.name}’s team` : topLabel}
            >
              {/* The bar the team hangs from. */}
              {focus && team.length > 1 && <li aria-hidden="true" className="pointer-events-none absolute left-[7.5rem] right-[7.5rem] top-0 h-px bg-line" />}
              {team.map((m) => {
                const below = index.children.get(m.id) ?? [];
                return (
                  <li key={m.id} className="relative flex flex-col items-center">
                    {focus && <span aria-hidden="true" className="absolute -top-6 h-6 w-px bg-line" />}
                    <OrgCard n={m} index={index} painter={painter} highlighted={highlightId === m.id} onFocus={(n) => setFocus(n.id)} onEdit={onEdit} structure={structure} onDragState={setDraggingSite} />
                    {below.length > 0 && (
                      <div className="mt-2 flex flex-col items-center gap-1.5 border-l border-line pl-3">
                        {below.slice(0, STACK).map((c) => (
                          <OrgCard key={c.id} n={c} index={index} painter={painter} compact highlighted={highlightId === c.id} onFocus={(n) => setFocus(n.id)} onEdit={onEdit} structure={structure} onDragState={setDraggingSite} />
                        ))}
                        {below.length > STACK && (
                          <button type="button" className="text-xs text-accent hover:underline" onClick={() => setFocus(m.id)}>
                            +{below.length - STACK} more — {m.kind === 'person' || m.kind === 'staff' || m.kind === 'lead' ? `show ${m.name}’s team` : `open ${m.name}`}
                          </button>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
      <p className="text-2xs text-ink-muted print:hidden">Drag to move around · ctrl+scroll or the buttons to zoom · click a name to see their team.</p>
    </div>
  );
}

/* ----- The list (an accessible tree) ------------------------------------ */

/** Past this many open rows the list windows: only what's on screen is in the DOM. */
const WINDOW_AFTER = 300;

export function TreeList({
  index,
  expanded,
  setExpanded,
  highlightId,
  painter,
  onEdit,
  label,
  structure,
}: {
  index: OrgIndex;
  expanded: Set<string>;
  setExpanded: (next: Set<string>) => void;
  highlightId: string | null;
  painter: Painter;
  onEdit?: (n: OrgNode) => void;
  label: string;
  structure?: StructureActions;
}) {
  const [active, setActive] = useState<string | null>(null);
  const rowsRef = useRef<HTMLUListElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // The rows as drawn: depth-first, into what's open.
  const visible = useMemo(() => {
    const out: Array<{ n: OrgNode; depth: number }> = [];
    const walk = (parent: string | null, depth: number) => {
      for (const n of index.children.get(parent) ?? []) {
        out.push({ n, depth });
        if (expanded.has(n.id)) walk(n.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [index, expanded]);
  const shown = visible;
  const current = active && shown.some((r) => r.n.id === active) ? active : (shown[0]?.n.id ?? null);

  // A 5,000-person field tree stays light: past WINDOW_AFTER open rows only
  // the rows in view are rendered, with spacers holding the rest's height.
  const windowed = visible.length > WINDOW_AFTER;
  const virtualizer = useVirtualizer({
    count: windowed ? visible.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 52,
    overscan: 15,
  });
  const vItems = windowed ? virtualizer.getVirtualItems() : [];
  const rendered: Array<{ n: OrgNode; depth: number; v: VirtualItem | null }> = windowed
    ? vItems.map((v) => ({ ...visible[v.index]!, v }))
    : visible.map((r) => ({ ...r, v: null }));
  const padTop = vItems.length ? vItems[0]!.start : 0;
  const padBottom = vItems.length ? virtualizer.getTotalSize() - vItems[vItems.length - 1]!.end : 0;

  /** Bring a row on screen (rendering it first when windowed), then act on it. */
  const reveal = (id: string, then?: (el: HTMLElement) => void) => {
    const find = () => rowsRef.current?.querySelector(`[data-row="${CSS.escape(id)}"]`) as HTMLElement | null;
    const i = visible.findIndex((r) => r.n.id === id);
    if (windowed && i >= 0) virtualizer.scrollToIndex(i, { align: 'auto' });
    const el = find();
    if (el) {
      el.scrollIntoView?.({ block: 'nearest' });
      then?.(el);
      return;
    }
    requestAnimationFrame(() => {
      const late = find();
      if (late) then?.(late);
    });
  };

  useEffect(() => {
    if (!highlightId) return;
    setActive(highlightId);
    reveal(highlightId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightId]);

  const move = (id: string | null) => {
    if (!id) return;
    setActive(id);
    reveal(id, (el) => el.focus());
  };
  const toggle = (id: string, open?: boolean) => {
    const next = new Set(expanded);
    if (open ?? !next.has(id)) next.add(id);
    else next.delete(id);
    setExpanded(next);
  };

  const onKey = (e: KeyboardEvent<HTMLElement>, n: OrgNode) => {
    const i = shown.findIndex((r) => r.n.id === n.id);
    const kids = index.children.get(n.id) ?? [];
    const hasKids = kids.length > 0 || (n.kind === 'store' && n.reports > 0);
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        move(shown[i + 1]?.n.id ?? null);
        break;
      case 'ArrowUp':
        e.preventDefault();
        move(shown[i - 1]?.n.id ?? null);
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (hasKids && !expanded.has(n.id)) toggle(n.id, true);
        else if (kids.length > 0) move(kids[0]!.id);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (hasKids && expanded.has(n.id)) toggle(n.id, false);
        else move(n.parentId);
        break;
      case 'Home':
        e.preventDefault();
        move(shown[0]?.n.id ?? null);
        break;
      case 'End':
        e.preventDefault();
        move(shown[shown.length - 1]?.n.id ?? null);
        break;
      case 'm':
        if (structure && n.kind === 'store') {
          e.preventDefault();
          structure.onMove(n);
        }
        break;
      case 'i':
        if (structure && STRUCTURE_KINDS.includes(n.kind)) {
          e.preventDefault();
          structure.onDetails(n);
        }
        break;
      case 'Enter':
      case ' ':
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        if (hasKids) toggle(n.id);
        break;
    }
  };

  return (
    <div>
      <div ref={scrollRef} className={windowed ? 'max-h-[70vh] overflow-auto' : undefined}>
      <ul ref={rowsRef} role="tree" aria-label={label} className="space-y-0.5">
        {padTop > 0 && <li role="none" style={{ height: padTop }} />}
        {rendered.map(({ n, depth, v }) => {
          const hasKids = (index.children.get(n.id) ?? []).length > 0 || (n.kind === 'store' && n.reports > 0);
          const open = expanded.has(n.id);
          const slot = painter.slotOf(n);
          const isPerson = n.kind === 'person' || n.kind === 'staff' || n.kind === 'lead';
          return (
            <li
              key={n.id}
              data-row={n.id}
              data-index={v ? v.index : undefined}
              ref={v ? virtualizer.measureElement : undefined}
              role="treeitem"
              aria-level={depth + 1}
              aria-expanded={hasKids ? open : undefined}
              aria-selected={current === n.id}
              tabIndex={current === n.id ? 0 : -1}
              onFocus={(e) => e.target === e.currentTarget && setActive(n.id)}
              onKeyDown={(e) => onKey(e, n)}
              className={cn(
                'flex items-center gap-2 rounded-md py-1.5 pr-2 outline-none focus-visible:ring-2 focus-visible:ring-accent coarse:min-h-12',
                highlightId === n.id ? 'bg-accent-fill/15' : 'hover:bg-surface-raised',
                slot !== null && 'border-l-4',
                slot !== null && PALETTE[slot]!.border,
              )}
              style={{ paddingLeft: `${0.25 + Math.min(depth, 8) * 1.25}rem` }}
            >
              {hasKids ? (
                <button
                  type="button"
                  tabIndex={-1}
                  aria-hidden="true"
                  onClick={() => toggle(n.id)}
                  className="grid h-6 w-6 shrink-0 place-items-center rounded text-ink-muted hover:text-ink coarse:h-10 coarse:w-10"
                >
                  {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </button>
              ) : (
                <span className="h-6 w-6 shrink-0 coarse:w-10" aria-hidden="true" />
              )}
              {isPerson ? (
                <Avatar src={n.photoUrl} name={n.name} size="xs" />
              ) : (
                <span className="grid h-6 w-6 shrink-0 place-items-center text-ink-muted" aria-hidden="true">
                  {n.kind === 'region' ? <MapIcon className="h-4 w-4" /> : n.kind === 'client' ? <Building2 className="h-4 w-4" /> : n.kind === 'store' ? <Store className="h-4 w-4" /> : n.kind === 'vacancy' ? <UserPlus className="h-4 w-4" /> : <Users className="h-4 w-4" />}
                </span>
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-ink">
                  <NameText name={n.name} />
                  {n.former && <span className="ml-1.5 text-2xs text-ink-muted">(former)</span>}
                </div>
                <div className="truncate text-xs text-ink-muted">{describe(n, index, painter)}</div>
                {n.kind === 'store' && <Coverage n={n} />}
              </div>
              {n.kind === 'vacancy' && n.positionStatus && (
                <Badge size="sm" variant={seatStatusOf(n.positionStatus).variant}>
                  {seatStatusOf(n.positionStatus).label}
                </Badge>
              )}
              {hasKids && isPerson && (index.teamSize.get(n.id) ?? 0) > 0 && (
                <span className="shrink-0 text-2xs tabular-nums text-ink-muted" title="People below them">
                  {index.teamSize.get(n.id)} below
                </span>
              )}
              {n.associateId && (
                <Link to={`/people/${n.associateId}`} tabIndex={-1} className="grid h-7 w-7 shrink-0 place-items-center rounded text-ink-muted hover:text-ink coarse:h-10 coarse:w-10" aria-label={`Open ${n.name}’s record`}>
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                </Link>
              )}
              {onEdit && (n.kind === 'person' || n.kind === 'staff') && !n.former && (
                <button type="button" tabIndex={-1} onClick={() => onEdit(n)} className="grid h-7 w-7 shrink-0 place-items-center rounded text-ink-muted hover:text-ink coarse:h-10 coarse:w-10" aria-label={`Change who ${n.name} reports to`}>
                  <UserCog className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              )}
              {structure && n.kind === 'store' && (
                <button type="button" tabIndex={-1} onClick={() => structure.onMove(n)} className="grid h-7 w-7 shrink-0 place-items-center rounded text-ink-muted hover:text-ink coarse:h-10 coarse:w-10" aria-label={`Move ${n.name} to a region`}>
                  <MoveRight className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              )}
              {structure && STRUCTURE_KINDS.includes(n.kind) && (
                <button type="button" tabIndex={-1} onClick={() => structure.onDetails(n)} className="grid h-7 w-7 shrink-0 place-items-center rounded text-ink-muted hover:text-ink coarse:h-10 coarse:w-10" aria-label={`Details for ${n.name}`}>
                  <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              )}
            </li>
          );
        })}
        {padBottom > 0 && <li role="none" style={{ height: padBottom }} />}
      </ul>
      </div>
    </div>
  );
}

/* ----- Reports to ---------------------------------------------------------- */

/**
 * Put `s` under `manager` (or at the top): a person record's manager lives
 * on the record (with its history); an account with no person record
 * reports to another account.
 */
async function saveReportsTo(s: OrgNode, manager: OrgNode | undefined): Promise<void> {
  if (s.associateId && (!manager || manager.associateId)) {
    await assignOrgFields(s.associateId, { managerId: manager?.associateId ?? null });
    if (!manager && s.userId) await setStaffReportsTo(s.userId, null);
    return;
  }
  if (s.userId) {
    await setStaffReportsTo(s.userId, manager?.userId ?? null);
    return;
  }
  throw new Error('Pick a manager with a person record for this person.');
}

/**
 * Set reporting lines for many people at once (F500 G1 /org/chart): pick a
 * manager, tick who reports to them, save. The same rules as one card's
 * "Reports to": never yourself or your own team, and a person record
 * reports to a person record. Opens on everyone at the top of the chart —
 * on a new chart, that is everyone.
 */
export function BulkReportsToDialog({ open, index, roleLabel, onClose }: { open: boolean; index: OrgIndex; roleLabel: (r: Role) => string; onClose: () => void }) {
  const qc = useQueryClient();
  const people = useMemo(
    () =>
      [...index.byId.values()]
        .filter((n) => (n.kind === 'person' || n.kind === 'staff') && !n.former)
        .sort((a, b) => displayName(a.name).localeCompare(displayName(b.name))),
    [index],
  );
  const [managerId, setManagerId] = useState('');
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  useEffect(() => {
    if (!open) return;
    setManagerId('');
    setQuery('');
    setChosen(new Set());
  }, [open]);
  const manager = managerId ? index.byId.get(managerId) : undefined;
  /** Why `n` can't go under the picked manager, or null when it can. */
  const blocked = (n: OrgNode): string | null => {
    if (!manager) return null;
    if (n.id === manager.id) return 'The manager';
    if (managerChoices(index, n).some((c) => c.id === manager.id)) return null;
    if (descendantIds(index, n.id).has(manager.id)) return `${displayName(manager.name)} is in their team`;
    return 'Needs a manager with a person record';
  };
  const q = query.trim().toLowerCase();
  const shown = people.filter((n) => !q || n.name.toLowerCase().includes(q) || (n.subtitle ?? '').toLowerCase().includes(q));
  const eligible = (n: OrgNode) => !!manager && blocked(n) === null;
  const picked = [...chosen].map((id) => index.byId.get(id)).filter((n): n is OrgNode => !!n && eligible(n));
  const atTop = people.filter((n) => !n.parentId && n.id !== managerId);
  const toggle = (id: string, on: boolean) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const apply = useMutation({
    mutationFn: async () => {
      const results = await Promise.allSettled(picked.map((n) => saveReportsTo(n, manager)));
      const failed = results.flatMap((r, i) => (r.status === 'rejected' ? [{ n: picked[i]!, why: r.reason instanceof ApiError || r.reason instanceof Error ? r.reason.message : 'failed' }] : []));
      return { ok: picked.length - failed.length, failed };
    },
    onSuccess: ({ ok, failed }) => {
      void qc.invalidateQueries({ queryKey: ['org'] });
      if (ok > 0) toast.success(`${ok} ${ok === 1 ? 'person now reports' : 'people now report'} to ${displayName(manager!.name)}.`);
      for (const f of failed.slice(0, 3)) toast.error(`${displayName(f.n.name)}: ${f.why}`);
      if (failed.length === 0) onClose();
      else setChosen(new Set(failed.map((f) => f.n.id)));
    },
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !apply.isPending && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Set reporting lines</DialogTitle>
          <DialogDescription>Pick a manager, then everyone who reports to them. Each person’s own team moves with them.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="Manager">
            {(p) => (
              <Select {...p} value={managerId} onChange={(e) => setManagerId(e.target.value)}>
                <option value="">Choose a manager</option>
                {people.map((n) => (
                  <option key={n.id} value={n.id}>
                    {displayName(n.name)}
                    {n.subtitle ? ` — ${n.subtitle}` : n.role ? ` — ${roleLabel(n.role)}` : ''}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <fieldset className="space-y-2" disabled={!manager}>
            <legend className="text-sm font-medium text-ink">Reports to {manager ? displayName(manager.name) : 'them'}</legend>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Find a person"
                aria-label="Find a person"
                className="h-8 min-w-0 flex-1 rounded-md border border-line bg-surface px-2 text-sm text-ink placeholder:text-ink-muted"
              />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={!manager || atTop.length === 0}
                onClick={() => setChosen(new Set(atTop.filter(eligible).map((n) => n.id)))}
              >
                Everyone at the top ({atTop.filter((n) => !manager || eligible(n)).length})
              </Button>
            </div>
            <ul className="max-h-72 divide-y divide-line overflow-y-auto rounded-md border border-line" aria-label="People">
              {shown.map((n) => {
                const why = blocked(n);
                const now = n.parentId ? index.byId.get(n.parentId) : undefined;
                return (
                  <li key={n.id}>
                    <label className={cn('flex items-center gap-3 px-3 py-2 text-sm coarse:min-h-11', why ? 'opacity-60' : 'cursor-pointer')}>
                      <input
                        type="checkbox"
                        className="h-4 w-4 coarse:h-6 coarse:w-6"
                        checked={chosen.has(n.id) && !why}
                        disabled={!manager || !!why}
                        onChange={(e) => toggle(n.id, e.target.checked)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-ink" title={n.name}>
                          {displayName(n.name)}
                        </span>
                        <span className="block truncate text-xs text-ink-muted">{why ?? (now ? `Now reports to ${displayName(now.name)}` : 'Now at the top')}</span>
                      </span>
                    </label>
                  </li>
                );
              })}
              {shown.length === 0 && <li className="px-3 py-2 text-sm text-ink-muted">Nobody matches.</li>}
            </ul>
          </fieldset>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={apply.isPending}>
            Cancel
          </Button>
          <Button onClick={() => apply.mutate()} loading={apply.isPending} disabled={!manager || picked.length === 0}>
            {picked.length > 0 ? `Save for ${picked.length}` : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ReportsToDialog({ subject, index, onClose }: { subject: OrgNode | null; index: OrgIndex; onClose: () => void }) {
  const qc = useQueryClient();
  const choices = useMemo(() => (subject ? managerChoices(index, subject) : []), [index, subject]);
  const currentParent = subject?.parentId ? index.byId.get(subject.parentId) : undefined;
  const [pick, setPick] = useState<string>('');
  useEffect(() => {
    setPick(currentParent && choices.some((c) => c.id === currentParent.id) ? currentParent.id : '');
  }, [subject?.id, currentParent, choices]);

  const save = useMutation({
    mutationFn: () => saveReportsTo(subject!, pick ? index.byId.get(pick) : undefined),
    onSuccess: () => {
      toast.success(pick ? `${subject!.name} now reports to ${index.byId.get(pick)?.name}.` : `${subject!.name} is now at the top of the chart.`);
      void qc.invalidateQueries({ queryKey: ['org', 'chart'] });
      onClose();
    },
    onError: (err) => toast.error(err instanceof ApiError || err instanceof Error ? err.message : 'Could not change the reporting line.'),
  });

  return (
    <Dialog open={!!subject} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Who does {subject?.name} report to?</DialogTitle>
          <DialogDescription>
            {currentParent ? `Now: ${currentParent.name}.` : 'Now: nobody — they sit at the top of the chart.'} Their own team moves with them.
          </DialogDescription>
        </DialogHeader>
        <Field label="Reports to">
          {(p) => (
            <Select {...p} value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">Nobody — the top of the chart</option>
              {choices.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.subtitle ? ` — ${c.subtitle}` : ''}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!!currentParent && pick === currentParent.id}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
