import { PALETTE, TICK } from './palette';

/** Shared axis props so every kit chart's axes read the same. */

export function yAxisLabel(label: string | undefined) {
  return label ? { value: label, angle: -90, position: 'insideLeft' as const, offset: 12, style: { fill: TICK.fill, fontSize: 11, textAnchor: 'middle' as const } } : undefined;
}

export function xAxisLabel(label: string | undefined) {
  return label ? { value: label, position: 'insideBottom' as const, offset: -2, style: { fill: TICK.fill, fontSize: 11 } } : undefined;
}

export const AXIS = {
  tick: TICK,
  tickLine: false,
  axisLine: { stroke: PALETTE.grid },
} as const;
