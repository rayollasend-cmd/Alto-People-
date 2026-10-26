import { useCallback } from 'react';
import { EChart } from './EChart';
import { esc, tooltipBase, type EChartColors } from './colors';
import type { EChartsCoreOption } from './engine';

/**
 * A flow (Sankey): where a population goes, step by step — applied →
 * screened → interviewed → offered → hired, with every exit drawn where it
 * happens. Steps take the series colours in order; outcomes are coloured by
 * meaning (`tone`), never by position.
 */
export interface FlowNode {
  id: string;
  label: string;
  /** An outcome: good (hired), bad (rejected), warn (withdrew), neutral (still open). Unset = a step, in series order. */
  tone?: 'good' | 'bad' | 'warn' | 'neutral';
}

export interface FlowLink {
  source: string;
  target: string;
  value: number;
}

export interface FlowChartProps {
  nodes: FlowNode[];
  links: FlowLink[];
  format?: (n: number) => string;
  height?: number;
}

const plain = (n: number) => n.toLocaleString();

export function flowOption(nodes: FlowNode[], links: FlowLink[], c: EChartColors, format: (n: number) => string = plain): EChartsCoreOption {
  const label = new Map(nodes.map((n) => [n.id, n.label]));
  let step = 0;
  const colorOf = (n: FlowNode) =>
    n.tone === 'good' ? c.good : n.tone === 'bad' ? c.bad : n.tone === 'warn' ? c.warn : n.tone === 'neutral' ? c.other : (c.series[step++] ?? c.other);
  const used = new Set<string>();
  const drawn = links.filter((l) => l.value > 0);
  for (const l of drawn) used.add(l.source).add(l.target);
  return {
    textStyle: { fontFamily: c.font },
    tooltip: {
      ...tooltipBase(c),
      trigger: 'item',
      formatter: (p: { dataType?: string; name?: string; value?: number; data?: { source?: string; target?: string } }) =>
        p.dataType === 'edge'
          ? `${esc(label.get(p.data?.source ?? '') ?? '')} → ${esc(label.get(p.data?.target ?? '') ?? '')}<br/><b>${esc(format(p.value ?? 0))}</b>`
          : `${esc(label.get(p.name ?? '') ?? '')}: <b>${esc(format(p.value ?? 0))}</b>`,
    },
    series: [
      {
        type: 'sankey',
        left: 4,
        right: 132,
        top: 8,
        bottom: 8,
        // Every outcome (a node with nothing after it) lines up in the last
        // column, however early the people in it left.
        nodeAlign: 'justify',
        nodeWidth: 12,
        nodeGap: 14,
        draggable: false,
        emphasis: { focus: 'adjacency' },
        data: nodes.filter((n) => used.has(n.id)).map((n) => ({ name: n.id, itemStyle: { color: colorOf(n), borderWidth: 0 } })),
        links: drawn.map((l) => ({ source: l.source, target: l.target, value: l.value })),
        // A band wears where it goes: onward in the next step's colour,
        // out in the outcome's — red to Rejected, amber to Withdrew.
        lineStyle: { color: 'target', opacity: 0.38, curveness: 0.5 },
        // Every node says what it is on a chip of the card's own colour: drawn bare, a
        // step's name sat on the band leaving it and the first column read as an
        // unlabelled bar (F500 audit 2026-10-26).
        label: {
          color: c.ink,
          fontSize: 12,
          fontFamily: c.font,
          backgroundColor: c.surface,
          padding: [2, 6],
          borderRadius: 4,
          formatter: (p: { name: string; value: number }) => `${label.get(p.name) ?? p.name}  {v|${format(p.value)}}`,
          rich: { v: { color: c.muted, fontSize: 12, fontFamily: c.font } },
        },
      },
    ],
  };
}

export function FlowChart({ nodes, links, format, height }: FlowChartProps) {
  const build = useCallback((c: EChartColors) => flowOption(nodes, links, c, format), [nodes, links, format]);
  return <EChart build={build} height={height} />;
}
