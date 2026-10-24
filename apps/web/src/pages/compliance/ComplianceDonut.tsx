import { lazyPlot } from '@/components/ui/charts/lazyPlot';
import { cn } from '@/lib/cn';

// Chart-only donut (no legend) sized for the Tile 1 hero column. The shared
// <DonutChart> component bundles its own legend in a flex-row, which doesn't
// fit a 220px column — so we drop down to recharts here directly. The center
// label sits in the donut hole via absolute positioning over a sized parent;
// this only works because the parent has explicit width/height in px.
//
// Lives in its own module so recharts doesn't sit in the ComplianceScorecard
// chunk; the parent lazy-imports it. The drawing itself (recharts) loads
// with the donut, not with this module (lazyPlot): the SIZE square holds
// the space and the centre label shows while it lands.
const ComplianceDonutPlot = lazyPlot(() => import('./ComplianceDonut.plot').then((m) => ({ default: m.ComplianceDonutPlot })));

export function ComplianceDonut({ fully, total }: { fully: number; total: number }) {
  const pct = total === 0 ? 100 : Math.round((fully / total) * 100);
  const gaps = Math.max(0, total - fully);
  const tone = pct === 100 ? 'text-success' : pct >= 80 ? 'text-warning' : 'text-alert';
  const SIZE = 170;

  return (
    <div className="flex flex-col items-center text-center">
      <div className="relative shrink-0" style={{ width: SIZE, height: SIZE }}>
        <ComplianceDonutPlot fully={fully} gaps={gaps} size={SIZE} />
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <div className="font-display text-3xl tabular-nums text-white leading-none">
            {pct}%
          </div>
          <div className="text-2xs uppercase tracking-widest text-silver/70 mt-1">
            compliant
          </div>
        </div>
      </div>
      <div className={cn('text-xs mt-3', tone)}>
        {fully} of {total} fully compliant
      </div>
      {gaps > 0 && (
        <div className="text-2xs text-silver mt-0.5">
          {gaps} {gaps === 1 ? 'associate has' : 'associates have'} at least one gap
        </div>
      )}
    </div>
  );
}
