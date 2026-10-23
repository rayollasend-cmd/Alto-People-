import type { ZoneShape } from '@alto-people/shared';

/**
 * Safety-zone geometry for the site map (Brief 3-1; polygons on the page,
 * audit 2026-10-21). The map is in the commissioning map's own units: an
 * abstract plane the fleet reports positions in. Everything here is pure so
 * the drawing canvas and the tests share one definition of "inside".
 */

export type Point = [number, number];

/** The server's rule, mirrored: a rectangle by its edges, a polygon by ray casting. */
export function pointInShape(shape: ZoneShape, x: number, y: number): boolean {
  if (shape.type === 'rect') return x >= shape.x && x <= shape.x + shape.w && y >= shape.y && y <= shape.y + shape.h;
  let inside = false;
  const pts = shape.points;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]!;
    const [xj, yj] = pts[j]!;
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Shoelace area, unsigned. Zero for fewer than three points or a line. */
export function polygonArea(points: readonly Point[]): number {
  if (points.length < 3) return 0;
  let twice = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    twice += points[j]![0] * points[i]![1] - points[i]![0] * points[j]![1];
  }
  return Math.abs(twice) / 2;
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** A click within `tolerance` of the first vertex closes the polygon. */
export function closesPolygon(points: readonly Point[], click: Point, tolerance: number): boolean {
  return points.length >= 3 && distance(points[0]!, click) <= tolerance;
}

/** A polygon the server accepts: three or more vertices, at most 64, with area. */
export function polygonValid(points: readonly Point[]): boolean {
  return points.length >= 3 && points.length <= 64 && polygonArea(points) > 0;
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** The map's extent: every zone's bounding box plus a margin, never smaller than the default 100 × 100. */
export function boundsOf(shapes: readonly ZoneShape[], margin = 5): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = 0;
  let minY = 0;
  let maxX = 100;
  let maxY = 100;
  for (const s of shapes) {
    const pts: Point[] = s.type === 'rect' ? [[s.x, s.y], [s.x + s.w, s.y + s.h]] : s.points;
    for (const [x, y] of pts) {
      minX = Math.min(minX, x - margin);
      minY = Math.min(minY, y - margin);
      maxX = Math.max(maxX, x + margin);
      maxY = Math.max(maxY, y + margin);
    }
  }
  return { minX, minY, maxX, maxY };
}

/** The SVG points attribute for a shape. */
export function shapePoints(shape: ZoneShape): string {
  const pts: Point[] = shape.type === 'rect' ? [[shape.x, shape.y], [shape.x + shape.w, shape.y], [shape.x + shape.w, shape.y + shape.h], [shape.x, shape.y + shape.h]] : shape.points;
  return pts.map(([x, y]) => `${x},${y}`).join(' ');
}

export function shapeLabel(shape: ZoneShape): string {
  return shape.type === 'rect' ? `Rectangle ${shape.w} × ${shape.h} at ${shape.x}, ${shape.y}` : `Polygon, ${shape.points.length} points`;
}

/** The name of the first zone a map point falls in, or null (F500 G2: a robot's
 *  "Position" said "12, 40" where "Lobby bar" was the answer). */
export function zoneNameAt(zones: readonly { name: string; shape: ZoneShape }[], x: number | null | undefined, y: number | null | undefined): string | null {
  if (x == null || y == null) return null;
  return zones.find((z) => pointInShape(z.shape, x, y))?.name ?? null;
}
