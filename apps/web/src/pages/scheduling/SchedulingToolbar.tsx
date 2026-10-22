import { useEffect, useState } from 'react';
import { Calendar, CalendarDays, CalendarRange, ChevronLeft, ChevronRight, List, Send, Wand2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { fmtMoneyCompact } from '@/lib/format';
import { cn } from '@/lib/cn';
import type { SchedulingKpis } from '@/lib/schedulingApi';

/**
 * One sticky 48px toolbar for the schedule (role walk, ops 4). At 1024×768
 * the week grid started at y=974 — nothing of it on screen — under five
 * KPI tiles, a view switcher, a date row, a legend, a density row, a
 * filter card and the auto-schedule banner. The toolbar carries the view,
 * the period arrows, the scope chips, Build and Publish; the KPIs read as
 * one line beneath it ("18% filled · 9 open · 77h · $1.1k"), and the
 * banner is a badge on the Build button.
 */

export type ToolbarView = 'list' | 'day' | 'week' | 'month';

export interface SchedulingToolbarProps {
  view: ToolbarView;
  onView: (v: ToolbarView) => void;
  /** "Oct 20 – Oct 26" / "Tuesday, Oct 21" / "October 2026". */
  periodLabel: string;
  onPrev?: () => void;
  onNext?: () => void;
  onToday?: () => void;
  /** Scope chips: client › location › position, each removable. */
  chips: Array<{ key: string; label: string; onRemove?: () => void }>;
  onOpenFilters?: () => void;
  canManage: boolean;
  /** Open (unassigned) shifts the auto-scheduler can fill this week — the badge on Build. */
  openToFill: number;
  onBuild?: () => void;
  building?: boolean;
  draftsToPublish: number;
  onPublish?: () => void;
  publishing?: boolean;
  /** Extra controls (Repeat, Templates, Export) go in the overflow the page renders. */
  trailing?: React.ReactNode;
  className?: string;
}

function ViewButton({ current, value, onClick, icon: Icon, label }: { current: ToolbarView; value: ToolbarView; onClick: (v: ToolbarView) => void; icon: LucideIcon; label: string }) {
  const active = current === value;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={() => onClick(value)}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-sm border px-2 text-xs font-medium uppercase tracking-wider transition coarse:h-9',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/40',
        active ? 'bg-gold/15 border-gold/50 text-gold' : 'border-transparent text-silver hover:text-ink',
      )}
      title={label}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      <span className="hidden lg:inline">{label}</span>
    </button>
  );
}

export function SchedulingToolbar(p: SchedulingToolbarProps) {
  return (
    <div
      role="toolbar"
      aria-label="Schedule"
      data-testid="scheduling-toolbar"
      className={cn(
        'sticky top-0 z-20 -mx-4 mb-2 flex h-12 items-center gap-2 overflow-x-auto border-b border-navy-secondary bg-navy/95 px-4 backdrop-blur no-print',
        'md:mx-0 md:rounded-md md:border md:px-2',
        p.className,
      )}
    >
      <div role="radiogroup" aria-label="Schedule view" className="inline-flex shrink-0 gap-0.5 rounded-md border border-navy-secondary bg-navy-secondary/30 p-0.5">
        <ViewButton current={p.view} value="list" onClick={p.onView} icon={List} label="List" />
        <ViewButton current={p.view} value="day" onClick={p.onView} icon={Calendar} label="Day" />
        <ViewButton current={p.view} value="week" onClick={p.onView} icon={CalendarDays} label="Week" />
        <ViewButton current={p.view} value="month" onClick={p.onView} icon={CalendarRange} label="Month" />
      </div>
      {p.onPrev && p.onNext && (
        <div className="inline-flex shrink-0 items-center">
          <Button variant="ghost" size="sm" onClick={p.onPrev} aria-label="Previous period" title="Previous period (←)">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <button
            type="button"
            onClick={p.onToday}
            className="px-1 text-sm font-medium tabular-nums text-ink hover:text-gold"
            title="Jump to today (t)"
            data-testid="toolbar-period"
          >
            {p.periodLabel}
          </button>
          <Button variant="ghost" size="sm" onClick={p.onNext} aria-label="Next period" title="Next period (→)">
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {p.chips.map((c) => (
          <span
            key={c.key}
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full border border-navy-secondary bg-navy-secondary/40 px-2.5 text-xs text-ink"
          >
            {c.label}
            {c.onRemove && (
              <button type="button" onClick={c.onRemove} aria-label={`Clear ${c.label}`} className="text-silver/70 hover:text-ink">
                ×
              </button>
            )}
          </span>
        ))}
        {p.onOpenFilters && (
          <button
            type="button"
            onClick={p.onOpenFilters}
            className="h-7 shrink-0 rounded-full border border-dashed border-navy-secondary px-2.5 text-xs text-silver hover:text-ink"
          >
            {p.chips.length === 0 ? 'Filter…' : 'Edit filters'}
          </button>
        )}
      </div>
      {p.trailing}
      {p.canManage && p.onBuild && (
        <Button variant="secondary" size="sm" onClick={p.onBuild} loading={p.building} className="relative shrink-0" title="Copy this week into next week, fill what's open, review the picks, then publish">
          <Wand2 className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="hidden sm:inline">Build</span>
          {p.openToFill > 0 && (
            <span
              className="ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-warning px-1 text-3xs font-semibold tabular-nums text-navy"
              title={`${p.openToFill} open shift${p.openToFill === 1 ? '' : 's'} this week can be auto-filled`}
              data-testid="toolbar-open-badge"
            >
              {p.openToFill}
            </span>
          )}
        </Button>
      )}
      {p.canManage && p.onPublish && (
        <Button variant="primary" size="sm" onClick={p.onPublish} loading={p.publishing} disabled={p.draftsToPublish === 0} className="shrink-0" title={p.draftsToPublish === 0 ? 'Nothing to publish in this week' : `Publish ${p.draftsToPublish} draft${p.draftsToPublish === 1 ? '' : 's'}`}>
          <Send className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="hidden sm:inline">Publish</span>
          {p.draftsToPublish > 0 && <span className="tabular-nums">{p.draftsToPublish}</span>}
        </Button>
      )}
    </div>
  );
}

/**
 * The KPIs as one line: "18% filled · 4 open · 5 unfilled · 77h scheduled
 * · 66h forecast · $1.1k". Null parts are left out; a client-bound role
 * never sees the dollars.
 */
export function kpiLine(kpis: SchedulingKpis | null, forecastHours: number | null): string {
  if (!kpis) return '';
  const filled = kpis.assignedShifts + kpis.completedShifts;
  const open = kpis.openUpcoming ?? kpis.openShifts;
  const unfilled = kpis.unfilledPast ?? kpis.wentUnfilled ?? 0;
  const parts: string[] = [];
  if (filled + open > 0) parts.push(`${kpis.fillRatePercent}% filled`);
  parts.push(`${open} open`);
  if (unfilled > 0) parts.push(`${unfilled} unfilled`);
  const hours = Math.round(kpis.totalScheduledMinutes / 60);
  parts.push(forecastHours != null ? `${hours}h scheduled · ${Math.round(forecastHours)}h forecast` : `${hours}h`);
  if (kpis.projectedLaborCost !== null) parts.push(fmtMoneyCompact(kpis.projectedLaborCost));
  return parts.join(' · ');
}

/**
 * Whether the page has scrolled far enough to fold the page header. Two
 * thresholds, so removing the header (which shortens the page) can't
 * flip the state straight back.
 */
export function useHeaderCollapsed(collapseAt = 160, expandAt = 24): boolean {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onScroll = () => {
      const y = window.scrollY;
      setCollapsed((c) => (c ? y > expandAt : y > collapseAt));
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [collapseAt, expandAt]);
  return collapsed;
}
