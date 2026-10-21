import { createContext, useContext } from 'react';

/**
 * Set by ChartFrame around its plot area, which has a fixed height: a kit
 * chart inside it fills that box; outside one it uses its own `height`.
 */
export const InChartFrame = createContext(false);

export function useChartHeight(height: number | undefined, fallback: number): number | '100%' {
  const inFrame = useContext(InChartFrame);
  if (height !== undefined) return height;
  return inFrame ? '100%' : fallback;
}
