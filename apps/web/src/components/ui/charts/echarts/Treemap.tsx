import { useCallback, type ReactNode } from 'react';
import { EChart } from './EChart';
import { esc, mix, tooltipBase, type EChartColors } from './colors';
import type { EChartsCoreOption } from './engine';

/**
 * Where the money goes: nested rectangles sized by value — client, then
 * store, then position. Each top-level group takes a series colour in
 * order (a sixth and beyond share "Other"); each level inside it steps
 * toward the card's surface, so the nesting reads at a glance. A group's
 * name sits on a strip in its own colour (ECharts paints a parent's strip
 * and the gaps between its children in the parent's border colour). Click
 * a block to zoom into it; the trail underneath walks back out.
 */
export interface TreeNode {
  name: string;
  value: number;
  children?: TreeNode[];
}

export interface TreemapProps {
  data: TreeNode[];
  /** The first crumb of the trail: "All clients". */
  rootName?: string;
  format?: (n: number) => string;
  height?: number;
  /**
   * What to show instead when there are fewer than TREEMAP_MIN_ITEMS blocks:
   * one $105 block filling an 880×320 card said nothing a sentence couldn't
   * (F500 audit 2026-10-26). Gets the blocks; left out, a short list of them.
   */
  few?: (leaves: TreeLeaf[]) => ReactNode;
}

/** One block of the map: its path from the top level down, and its value. */
export interface TreeLeaf {
  path: string[];
  value: number;
}

/** Below this many blocks a treemap is a sentence, not a picture. */
export const TREEMAP_MIN_ITEMS = 3;

/** Every block with a value, deepest level, largest first. */
export function treemapLeaves(nodes: TreeNode[], prefix: string[] = []): TreeLeaf[] {
  const out: TreeLeaf[] = [];
  for (const n of nodes) {
    if (!(n.value > 0)) continue;
    const kids = (n.children ?? []).filter((ch) => ch.value > 0);
    if (kids.length === 0) out.push({ path: [...prefix, n.name], value: n.value });
    else out.push(...treemapLeaves(kids, [...prefix, n.name]));
  }
  return out.sort((a, b) => b.value - a.value);
}

const plain = (n: number) => n.toLocaleString();

/** Relative luminance of `rgb(r, g, b)`. */
function luminance(color: string): number {
  const m = /(\d+),\s*(\d+),\s*(\d+)/.exec(color);
  if (!m) return 0;
  const [r, g, b] = [m[1], m[2], m[3]].map((v) => {
    const s = Number(v) / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Navy or white, whichever reads better on `color`. */
export function readableOn(color: string): string {
  const l = luminance(color);
  const onWhite = 1.05 / (l + 0.05);
  const onNavy = (l + 0.05) / (0.0094 + 0.05);
  return onNavy >= onWhite ? 'rgb(11, 24, 50)' : 'rgb(255, 255, 255)';
}

const total = (nodes: TreeNode[]) => nodes.reduce((s, n) => s + n.value, 0);

/** Levels in a node's subtree, the node's own included. */
function depthOf(n: TreeNode): number {
  return 1 + Math.max(0, ...(n.children ?? []).filter((ch) => ch.value > 0).map(depthOf));
}

export function treemapOption(data: TreeNode[], c: EChartColors, format: (n: number) => string = plain, rootName = 'All'): EChartsCoreOption {
  const grand = total(data);
  const paint = (n: TreeNode, group: string, depth: number): Record<string, unknown> => {
    const shade = depth === 0 ? group : mix(group, c.surface, Math.min(0.5, 0.2 * depth));
    return {
      name: n.name,
      value: n.value,
      itemStyle: { color: shade, borderColor: shade },
      label: { show: true, color: readableOn(shade) },
      upperLabel: { show: true, color: readableOn(shade) },
      children: n.children?.filter((ch) => ch.value > 0).map((ch) => paint(ch, group, depth + 1)),
    };
  };
  const sorted = [...data].filter((n) => n.value > 0).sort((a, b) => b.value - a.value);
  return {
    textStyle: { fontFamily: c.font },
    tooltip: {
      ...tooltipBase(c),
      formatter: (p: { treePathInfo?: Array<{ name: string }>; value?: number }) => {
        const path = (p.treePathInfo ?? []).slice(1).map((s) => esc(s.name)).join(' › ');
        const v = p.value ?? 0;
        const share = grand > 0 ? ` · ${Math.round((v / grand) * 100)}% of all` : '';
        return `${path}<br/><b>${esc(format(v))}</b>${share}`;
      },
    },
    series: [
      {
        type: 'treemap',
        name: rootName,
        top: 0,
        left: 0,
        right: 0,
        bottom: 30,
        roam: false,
        nodeClick: 'zoomToNode',
        // Every level shown — and, because it is set, the breadcrumb names
        // where the reader is (the view's root: "All" until they zoom in).
        // Unset, ECharts ends the breadcrumb at whichever block happens to
        // sit at the chart's exact centre (its own "FIXME" in TreemapView),
        // so it read "All › Coastal Resort Holdings › Front Beach 218" or
        // "… › Deli associate" on a one-pixel difference in layout.
        leafDepth: Math.max(1, ...sorted.map(depthOf)),
        squareRatio: 0.5 * (1 + Math.sqrt(5)),
        // From the second series colour on: gold is punctuation, never a fill
        // the size of the card (docs/design-system.md §2).
        data: sorted.map((n, i) => paint(n, c.series[i + 1] ?? c.other, 0)),
        label: {
          show: true,
          fontSize: 12,
          fontFamily: c.font,
          overflow: 'truncate',
          formatter: (p: { name: string; value: number }) => `${p.name}\n${format(p.value)}`,
        },
        upperLabel: { show: true, height: 22, fontSize: 12, fontFamily: c.font, fontWeight: 600, overflow: 'truncate' },
        // The root's gaps are the card itself; inside a group, the gaps are
        // the group's own colour around a lighter (or, in dark, deeper) child.
        levels: [
          { itemStyle: { borderWidth: 0, gapWidth: 4, borderColor: c.surface }, upperLabel: { show: false } },
          { itemStyle: { borderWidth: 3, gapWidth: 2 } },
          { itemStyle: { borderWidth: 2, gapWidth: 2 }, upperLabel: { height: 18, fontSize: 11, fontWeight: 500 } },
          { itemStyle: { borderWidth: 0, gapWidth: 0 } },
        ],
        breadcrumb: {
          show: true,
          bottom: 0,
          height: 22,
          left: 0,
          itemStyle: { color: c.grid, borderColor: c.grid, textStyle: { color: c.ink, fontFamily: c.font, fontSize: 12 } },
          emphasis: { itemStyle: { color: c.other, textStyle: { color: c.ink } } },
        },
      },
    ],
  };
}

export function Treemap({ data, rootName, format, height, few }: TreemapProps) {
  const build = useCallback((c: EChartColors) => treemapOption(data, c, format, rootName), [data, format, rootName]);
  const leaves = treemapLeaves(data);
  if (leaves.length < TREEMAP_MIN_ITEMS) {
    if (few) return <>{few(leaves)}</>;
    const fmt = format ?? plain;
    const sum = leaves.reduce((s, l) => s + l.value, 0);
    return (
      <ul className="space-y-1.5 text-sm" data-testid="treemap-few">
        {leaves.map((l) => (
          <li key={l.path.join('|')} className="flex flex-wrap items-baseline justify-between gap-x-3">
            <span className="min-w-0 text-ink">{l.path.join(' › ')}</span>
            <span className="tabular-nums text-ink-muted">
              {fmt(l.value)}
              {sum > 0 && leaves.length > 1 && ` · ${Math.round((l.value / sum) * 100)}%`}
            </span>
          </li>
        ))}
      </ul>
    );
  }
  return <EChart build={build} height={height} />;
}
