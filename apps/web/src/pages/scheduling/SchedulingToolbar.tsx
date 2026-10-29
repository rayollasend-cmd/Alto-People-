import { useEffect, useState } from 'react';
import { Calendar, CalendarDays, CalendarRange, ChevronLeft, ChevronRight, List, Send, Wand2 } from '@/components/ui/icons';
import type { LucideIcon } from '@/components/ui/icons';
import { Button } from '@/components/ui/Button';
import { fmtMoneyWhole } from '@/lib/format';
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
      // Labelled at every size (four bare icons on a phone said nothing,
      // F500 2026-10-26), sentence case, 44px tall to a finger.
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-sm border px-2 text-xs font-medium transition coarse:h-11 coarse:px-2.5',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/40',
        active ? 'bg-gold/15 border-gold/50 text-ink' : 'border-transparent text-silver hover:text-ink',
      )}
    >
      <Icon className="h-3.5 w-3.5 max-sm:hidden" aria-hidden="true" />
      <span>{label}</span>
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
        // A phone wraps the bar onto two lines (view and period, then the
        // scope) instead of a 401px row in a 390px screen. A desk wraps too
        // rather than scroll sideways: at 1024 with the sidebar open the
        // one-line bar put Build and Publish at x=1182–1384, out of sight
        // with no cue (FLOOR-11). From 2xl the bar is one 48px line.
        'sticky top-0 z-20 -mx-4 mb-2 flex min-h-12 flex-wrap items-center gap-2 border-b border-navy-secondary bg-navy/95 px-4 py-1.5 backdrop-blur no-print',
        'md:mx-0 md:rounded-md md:border md:px-2 2xl:h-12 2xl:flex-nowrap 2xl:py-0',
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
      {/* The scope stays in view: the chips keep room for one ("Coastal
          Resort Ho…") however crowded the bar gets. */}
      <div className={cn('flex min-w-0 flex-1 items-center gap-1 overflow-x-auto max-md:order-last max-md:basis-full', p.chips.length > 0 && 'min-w-[5.5rem]')}>
        {p.chips.map((c) => (
          <span
            key={c.key}
            // A long store name ends in "…" (full name on hover) instead of
            // being cut off at the scroller's edge.
            className="inline-flex h-7 min-w-[5rem] max-w-[16rem] shrink items-center gap-1 rounded-full border border-navy-secondary bg-navy-secondary/40 px-2.5 text-xs text-ink coarse:h-9"
            title={c.label}
          >
            <span className="min-w-0 truncate">{c.label}</span>
            {c.onRemove && (
              <button type="button" onClick={c.onRemove} aria-label={`Clear ${c.label}`} className="-my-2 -mr-2 grid h-7 w-7 place-items-center text-silver/70 hover:text-ink coarse:h-11 coarse:w-11">
                ×
              </button>
            )}
          </span>
        ))}
      </div>
      {/* Outside the chips' scroller, so it never clips to "Edit filte"; with
          the page's extra controls it stays one group (a lone "…" wrapped
          onto its own line on a phone). */}
      <div className="flex shrink-0 items-center gap-2 max-md:ml-auto">
        {p.onOpenFilters && (
          <button
            type="button"
            onClick={p.onOpenFilters}
            className="h-7 shrink-0 whitespace-nowrap rounded-full border border-dashed border-navy-secondary px-2.5 text-xs text-silver hover:text-ink coarse:h-11 coarse:px-3.5"
          >
            {p.chips.length === 0 ? 'Filter…' : 'Edit filters'}
          </button>
        )}
        {p.trailing}
      </div>
      {/* Build and Publish stay together at the end of the bar and wrap as
          one group, so Publish is never the one pushed out of view. Each
          says its name at every size: icon-only on a phone read "1" (the
          badge) to a screen reader, and a tooltip doesn't exist on touch
          (FLOOR-26). */}
      {p.canManage && (p.onBuild || p.onPublish) && (
        <div className="ml-auto flex shrink-0 items-center gap-2" data-testid="toolbar-actions">
          {p.onBuild && (
            <Button
              variant="secondary"
              size="sm"
              onClick={p.onBuild}
              loading={p.building}
              className="relative shrink-0"
              aria-label={buildLabel(p.openToFill)}
              title="Copy this week into next week, fill what's open, review the picks, then publish"
            >
              <Wand2 className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Build</span>
              {p.openToFill > 0 && (
                <span
                  className="ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-warning px-1 text-3xs font-semibold tabular-nums text-navy"
                  aria-hidden="true"
                  data-testid="toolbar-open-badge"
                >
                  {p.openToFill}
                </span>
              )}
            </Button>
          )}
          {p.onPublish && (
            <Button
              variant="primary"
              size="sm"
              onClick={p.onPublish}
              loading={p.publishing}
              disabled={p.draftsToPublish === 0}
              className="shrink-0"
              aria-label={publishLabel(p.draftsToPublish)}
              title={p.draftsToPublish === 0 ? 'Nothing to publish in this week' : `Publish ${p.draftsToPublish} draft${p.draftsToPublish === 1 ? '' : 's'}`}
            >
              <Send className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Publish</span>
              {p.draftsToPublish > 0 && <span className="tabular-nums" aria-hidden="true">{p.draftsToPublish}</span>}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** Build's accessible name: "Build next week, 1 open to fill" — never the bare badge ("1"). */
export function buildLabel(openToFill: number): string {
  return openToFill > 0 ? `Build next week, ${openToFill} open to fill` : 'Build next week';
}

/** Publish's accessible name, with what it would publish. */
export function publishLabel(drafts: number): string {
  return drafts > 0 ? `Publish ${drafts} draft${drafts === 1 ? '' : 's'}` : 'Publish — nothing to publish in this week';
}

export type KpiPartKey = 'filled' | 'open' | 'unfilled' | 'hours' | 'forecast' | 'cost';

/**
 * The KPIs as parts — "18% filled", "4 open", "5 unfilled", "77h
 * scheduled", "66h forecast", "$1.1k" — so the page can render them as one
 * line on a desk and as sideways-scrolling chips on a phone, and make
 * "5 unfilled" a link to the list of them. Null parts are left out; a
 * client-bound role never sees the dollars.
 */
export function kpiParts(kpis: SchedulingKpis | null, forecastHours: number | null): Array<{ key: KpiPartKey; text: string }> {
  if (!kpis) return [];
  const filled = kpis.assignedShifts + kpis.completedShifts;
  const open = kpis.openUpcoming ?? kpis.openShifts;
  const unfilled = kpis.unfilledPast ?? kpis.wentUnfilled ?? 0;
  const parts: Array<{ key: KpiPartKey; text: string }> = [];
  if (filled + open > 0) parts.push({ key: 'filled', text: `${kpis.fillRatePercent}% filled` });
  parts.push({ key: 'open', text: `${open} open` });
  if (unfilled > 0) parts.push({ key: 'unfilled', text: `${unfilled} unfilled` });
  // Hours with one decimal, like every hours figure in the app.
  const hours = (kpis.totalScheduledMinutes / 60).toFixed(1);
  if (forecastHours != null) {
    parts.push({ key: 'hours', text: `${hours}h scheduled` });
    parts.push({ key: 'forecast', text: `${forecastHours.toFixed(1)}h forecast` });
  } else parts.push({ key: 'hours', text: `${hours}h` });
  // A figure, not a chart axis: whole dollars, never "$1.1k" (F500 2026-10-26).
  if (kpis.projectedLaborCost !== null) parts.push({ key: 'cost', text: fmtMoneyWhole(kpis.projectedLaborCost) });
  return parts;
}

/** The KPIs as one line: "18% filled · 4 open · 5 unfilled · 77h scheduled · 66h forecast · $1.1k". */
export function kpiLine(kpis: SchedulingKpis | null, forecastHours: number | null): string {
  return kpiParts(kpis, forecastHours)
    .map((p) => p.text)
    .join(' · ');
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
