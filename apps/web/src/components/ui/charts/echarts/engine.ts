import type { EChartsType } from 'echarts/core';

export type { EChartsType };
export type { EChartsCoreOption } from 'echarts/core';

type Engine = typeof import('./setup')['echarts'];

let engine: Promise<Engine> | null = null;

/** The engine, loaded once on first use (./setup). */
export function loadEcharts(): Promise<Engine> {
  engine ??= import('./setup').then((m) => m.echarts);
  return engine;
}
