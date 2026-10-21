import { PALETTE } from '@/components/ui/charts/palette';

/**
 * The portal's chart kit now lives in components/ui/charts — one kit for
 * the whole app. These re-exports keep every existing import working.
 */

export const SERIES = { primary: PALETTE.primary, secondary: PALETTE.secondary, tertiary: PALETTE.tertiary } as const;
export const STATUS = { good: PALETTE.good, warn: PALETTE.warn, bad: PALETTE.bad } as const;

export { DetailsTable, PortalTooltip, RingMeter, StatTile } from '@/components/ui/charts';
export { CoverageCurve, CoverageHeatmap, HoursChart, ReliabilityChart, StoreBarChart, WeekFillChart, type HeatDay, type HourPoint } from '@/components/ui/charts';
