import { describe, expect, it } from 'vitest';
import { boundsOf, closesPolygon, pointInShape, polygonArea, polygonValid, shapeLabel, shapePoints } from '@/lib/robotZones';

/**
 * The zone geometry the drawing canvas and the server agree on: inside means
 * the same thing for a rectangle and a polygon, a polygon closes on its first
 * corner, and a line or two points is not a zone.
 */
describe('robot zone geometry', () => {
  it('decides inside for rectangles and polygons the way the server does', () => {
    expect(pointInShape({ type: 'rect', x: 10, y: 10, w: 20, h: 10 }, 15, 15)).toBe(true);
    expect(pointInShape({ type: 'rect', x: 10, y: 10, w: 20, h: 10 }, 35, 15)).toBe(false);
    const tri = { type: 'polygon' as const, points: [[0, 0], [10, 0], [0, 10]] as [number, number][] };
    expect(pointInShape(tri, 2, 2)).toBe(true);
    expect(pointInShape(tri, 8, 8)).toBe(false);
    // A concave L: the notch is outside.
    const ell = { type: 'polygon' as const, points: [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]] as [number, number][] };
    expect(pointInShape(ell, 2, 8)).toBe(true);
    expect(pointInShape(ell, 8, 8)).toBe(false);
  });

  it('closes on the first corner only once there are three, and refuses a degenerate shape', () => {
    expect(closesPolygon([[0, 0], [10, 0]], [0.5, 0.5], 2)).toBe(false);
    expect(closesPolygon([[0, 0], [10, 0], [10, 10]], [0.5, 0.5], 2)).toBe(true);
    expect(closesPolygon([[0, 0], [10, 0], [10, 10]], [5, 5], 2)).toBe(false);
    expect(polygonArea([[0, 0], [10, 0], [10, 10], [0, 10]])).toBe(100);
    expect(polygonValid([[0, 0], [10, 0], [10, 10]])).toBe(true);
    expect(polygonValid([[0, 0], [10, 0]])).toBe(false);
    expect(polygonValid([[0, 0], [5, 0], [10, 0]])).toBe(false); // a line
  });

  it('frames the map around every zone and names shapes plainly', () => {
    expect(boundsOf([])).toEqual({ minX: 0, minY: 0, maxX: 100, maxY: 100 });
    expect(boundsOf([{ type: 'rect', x: 90, y: -10, w: 30, h: 5 }], 5)).toEqual({ minX: 0, minY: -15, maxX: 125, maxY: 100 });
    expect(shapePoints({ type: 'rect', x: 1, y: 2, w: 3, h: 4 })).toBe('1,2 4,2 4,6 1,6');
    expect(shapeLabel({ type: 'polygon', points: [[0, 0], [1, 0], [1, 1]] })).toBe('Polygon, 3 points');
    expect(shapeLabel({ type: 'rect', x: 1, y: 2, w: 3, h: 4 })).toBe('Rectangle 3 × 4 at 1, 2');
  });
});
