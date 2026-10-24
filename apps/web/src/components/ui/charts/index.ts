/**
 * The chart kit — import from '@/components/ui/charts'.
 * Wrap a figure in ChartFrame (components/ui/ChartFrame) for its title,
 * summary, Chart/Table switch, CSV and empty state; kit charts inside it
 * fill its plot box.
 */
export { PALETTE, CONCEPT, seriesColor, toneColor, foldToOther, TICK, TOOLTIP_STYLE, TOOLTIP_LABEL_STYLE, TOOLTIP_ITEM_STYLE, type Tone } from './palette';
export { ChartTooltipContent, PortalTooltip, LegendKey, DetailsTable, STOCK_LEGEND } from './ChartTooltip';
export { Sparkline, sparkDomain, type SparklineProps } from './Sparkline';
export { RingMeter } from './RingMeter';
export { StatTile } from './StatTile';
export { Heatmap, type HeatmapProps, type HeatmapAxisItem } from './Heatmap';
export { Waterfall, waterfallRows, type WaterfallProps, type WaterfallStep } from './Waterfall';
export { TrendLineChart, type TrendLineChartProps, type TrendSeries } from './TrendLineChart';
export { StackedBarChart, type StackedBarChartProps, type BarSeries } from './StackedBarChart';
export { CoverageCurve, CoverageHeatmap, HoursChart, ReliabilityChart, StoreBarChart, WeekFillChart, type HeatDay, type HourPoint } from './coverage';
export { InChartFrame } from './frame';
export { AXIS, Y_AXIS_WIDTH, dateTicks, fmtDateTick, parseAxisDate, dateHeading, type DateGrain } from './axes';
// ECharts figures — the engine loads on first use, as its own chunk (echarts/setup).
export { EChart, type EChartProps } from './echarts/EChart';
export { FlowChart, flowOption, type FlowChartProps, type FlowNode, type FlowLink } from './echarts/FlowChart';
export { CalendarHeatmap, calendarOption, type CalendarHeatmapProps, type CalendarDay } from './echarts/CalendarHeatmap';
export { Treemap, treemapOption, type TreemapProps, type TreeNode } from './echarts/Treemap';
