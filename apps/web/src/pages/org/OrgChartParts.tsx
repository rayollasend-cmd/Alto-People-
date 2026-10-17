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
} from 'lucide-react';
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
import { PALETTE, ancestorsOf, managerChoices, type OrgIndex } from './orgChartModel';

/**
 * The org chart's drawing: one card for every kind of node, the chart
 * canvas (a focused node, its team, and each member's own team stacked
 * beneath — pan by dragging, zoom with the buttons or ctrl+scroll), the
 * accessible list (a real tree: arrows move, right opens, left closes),
 * and the "Reports to" dialog.
 */

export interface Painter {
  /** The palette slot for a node, or null when not colouring. */
  slotOf: (n: OrgNode) => number | null;
  roleLabel: (r: Role) => string;
  term: (k: TermKey) => string;
}

/** A name that may be an email (an account with no display name): break it at the @, not mid-word. */
function NameText({ name }: { name: string }) {
  const at = name.indexOf('@');
  if (at <= 0) return <>{name}</>;
  return (
    <>
      {name.slice(0, at)}
      <wbr />
      <span className="font-normal text-ink-muted">{name.slice(at)}</span>
    </>
  );
}

const SEAT_STATUS: Record<'PLANNED' | 'OPEN' | 'FROZEN', { label: string; variant: 'pending' | 'success' | 'info' }> = {
  PLANNED: { label: 'Awaiting approval', variant: 'pending' },
  OPEN: { label: 'Hiring', variant: 'success' },
  FROZEN: { label: 'On hold', variant: 'info' },
};

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
}: {
  n: OrgNode;
  index: OrgIndex;
  painter: Painter;
  highlighted?: boolean;
  compact?: boolean;
  onFocus?: (n: OrgNode) => void;
  onEdit?: (n: OrgNode) => void;
}) {
  const slot = painter.slotOf(n);
  const isPerson = n.kind === 'person' || n.kind === 'staff' || n.kind === 'lead';
  const team = index.teamSize.get(n.id) ?? 0;
  const hasTeam = (index.children.get(n.id) ?? []).length > 0;
  return (
    <div
      data-node={n.id}
      className={cn(
        'group relative flex items-center gap-2.5 rounded-lg border bg-surface text-left',
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
          <Badge size="sm" variant={SEAT_STATUS[n.positionStatus].variant} className="mt-1">
            {SEAT_STATUS[n.positionStatus].label}
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
      </div>
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
}: {
  index: OrgIndex;
  focusId: string | null;
  setFocus: (id: string | null) => void;
  highlightId: string | null;
  painter: Painter;
  topLabel: string;
  onEdit?: (n: OrgNode) => void;
}) {
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
    if ((e.target as HTMLElement).closest('button,a')) return;
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
              >
                {n.name}
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
        <div className="inline-flex min-w-full origin-top flex-col items-center p-8" style={{ transform: `scale(${zoom})` }}>
          {focus && (
            <>
              <OrgCard n={focus} index={index} painter={painter} highlighted={highlightId === focus.id} onEdit={onEdit} />
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
                    <OrgCard n={m} index={index} painter={painter} highlighted={highlightId === m.id} onFocus={(n) => setFocus(n.id)} onEdit={onEdit} />
                    {below.length > 0 && (
                      <div className="mt-2 flex flex-col items-center gap-1.5 border-l border-line pl-3">
                        {below.slice(0, STACK).map((c) => (
                          <OrgCard key={c.id} n={c} index={index} painter={painter} compact highlighted={highlightId === c.id} onFocus={(n) => setFocus(n.id)} onEdit={onEdit} />
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

const LIST_CAP = 1500;

export function TreeList({
  index,
  expanded,
  setExpanded,
  highlightId,
  painter,
  onEdit,
  label,
}: {
  index: OrgIndex;
  expanded: Set<string>;
  setExpanded: (next: Set<string>) => void;
  highlightId: string | null;
  painter: Painter;
  onEdit?: (n: OrgNode) => void;
  label: string;
}) {
  const [active, setActive] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const rowsRef = useRef<HTMLUListElement>(null);

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
  const shown = showAll ? visible : visible.slice(0, LIST_CAP);
  const current = active && shown.some((r) => r.n.id === active) ? active : (shown[0]?.n.id ?? null);

  useEffect(() => {
    if (!highlightId) return;
    setActive(highlightId);
    const el = rowsRef.current?.querySelector(`[data-row="${CSS.escape(highlightId)}"]`);
    (el as HTMLElement | null)?.scrollIntoView?.({ block: 'nearest' });
  }, [highlightId]);

  const move = (id: string | null) => {
    if (!id) return;
    setActive(id);
    (rowsRef.current?.querySelector(`[data-row="${CSS.escape(id)}"]`) as HTMLElement | null)?.focus();
  };
  const toggle = (id: string, open?: boolean) => {
    const next = new Set(expanded);
    if (open ?? !next.has(id)) next.add(id);
    else next.delete(id);
    setExpanded(next);
  };

  const onKey = (e: KeyboardEvent<HTMLElement>, n: OrgNode) => {
    const i = shown.findIndex((r) => r.n.id === n.id);
    const hasKids = (index.children.get(n.id) ?? []).length > 0;
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
        else if (hasKids) move(index.children.get(n.id)![0]!.id);
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
      <ul ref={rowsRef} role="tree" aria-label={label} className="space-y-0.5">
        {shown.map(({ n, depth }) => {
          const hasKids = (index.children.get(n.id) ?? []).length > 0;
          const open = expanded.has(n.id);
          const slot = painter.slotOf(n);
          const isPerson = n.kind === 'person' || n.kind === 'staff' || n.kind === 'lead';
          return (
            <li
              key={n.id}
              data-row={n.id}
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
                <Badge size="sm" variant={SEAT_STATUS[n.positionStatus].variant}>
                  {SEAT_STATUS[n.positionStatus].label}
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
            </li>
          );
        })}
      </ul>
      {!showAll && visible.length > LIST_CAP && (
        <div className="mt-3 text-center">
          <Button size="sm" variant="outline" onClick={() => setShowAll(true)}>
            Show all {visible.length} rows
          </Button>
        </div>
      )}
    </div>
  );
}

/* ----- Reports to ---------------------------------------------------------- */

export function ReportsToDialog({ subject, index, onClose }: { subject: OrgNode | null; index: OrgIndex; onClose: () => void }) {
  const qc = useQueryClient();
  const choices = useMemo(() => (subject ? managerChoices(index, subject) : []), [index, subject]);
  const currentParent = subject?.parentId ? index.byId.get(subject.parentId) : undefined;
  const [pick, setPick] = useState<string>('');
  useEffect(() => {
    setPick(currentParent && choices.some((c) => c.id === currentParent.id) ? currentParent.id : '');
  }, [subject?.id, currentParent, choices]);

  const save = useMutation({
    mutationFn: async () => {
      const manager = pick ? index.byId.get(pick) : undefined;
      const s = subject!;
      if (s.associateId && (!manager || manager.associateId)) {
        // A person record's manager lives on the record (with its history).
        await assignOrgFields(s.associateId, { managerId: manager?.associateId ?? null });
        if (!manager && s.userId) await setStaffReportsTo(s.userId, null);
        return;
      }
      if (s.userId) {
        await setStaffReportsTo(s.userId, manager?.userId ?? null);
        return;
      }
      throw new Error('Pick a manager with a person record for this person.');
    },
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
