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
import { HeatmapChart, SankeyChart, TreemapChart } from 'echarts/charts';
import { CalendarComponent, TooltipComponent, VisualMapComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';

echarts.use([SankeyChart, HeatmapChart, TreemapChart, CalendarComponent, TooltipComponent, VisualMapComponent, SVGRenderer]);

export { echarts };
