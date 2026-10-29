/**
 * The ECharts engine with exactly the pieces the kit draws — its own chunk
 * ('echarts' in vite.config), fetched the first time a page shows one of
 * these figures and never on first paint. Add a chart or component here
 * before an option uses it; ECharts silently draws nothing for one that
 * isn't registered.
 *
 * SVG, not canvas: crisp text at any zoom and in print, a DOM a test can
 * read, and these figures stay well under the size where canvas wins.
 */
import * as echarts from 'echarts/core';
import { HeatmapChart, SankeyChart, ScatterChart, TreemapChart } from 'echarts/charts';
import { CalendarComponent, GridComponent, TooltipComponent, VisualMapComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';

// ScatterMatrix (2026-10-27) adds only the scatter and the cartesian grid it
// sits on (+12 KB gz). Its quadrant lines are HTML over the grid, not
// markLine, and it places its own names instead of the label-layout module:
// those two were another 10 KB, and the chunk's budget is 205.
echarts.use([SankeyChart, HeatmapChart, TreemapChart, ScatterChart, CalendarComponent, GridComponent, TooltipComponent, VisualMapComponent, SVGRenderer]);

export { echarts };
