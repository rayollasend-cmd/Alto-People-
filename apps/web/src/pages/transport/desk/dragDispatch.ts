import { useRef, useState, type DragEvent } from 'react';
import type { MovingRide } from './moves';

/**
 * Drag to dispatch: pick a rider up off a run's list (or off "Needs a van")
 * and drop them on another run's card. The browser's own drag and drop — a
 * mouse on the desk, a long press on an iPad — with the Move to… menu on every
 * row as the keyboard, touch and screen-reader way to make the same move.
 *
 * While a rider is in the air every card says what a drop would do: the seats
 * after the move, or why that run can't take them (a full van, the other way).
 */

export const RIDE_MIME = 'application/x-alto-ride';

/** The drop target id for a run's card. */
export const runTarget = (runId: string) => `run:${runId}`;
export const runIdOfTarget = (target: string) => (target.startsWith('run:') ? target.slice(4) : null);

export function useDragDispatch(onDrop: (m: MovingRide, target: string) => void) {
  const [moving, setMoving] = useState<MovingRide | null>(null);
  const [over, setOver] = useState<string | null>(null);
  // dragover fires every few ms; only a change of target re-renders.
  const overRef = useRef<string | null>(null);
  const movingRef = useRef<MovingRide | null>(null);

  const end = () => {
    movingRef.current = null;
    overRef.current = null;
    setMoving(null);
    setOver(null);
  };

  /** Props for a draggable rider row. */
  const source = (m: MovingRide) => ({
    draggable: true,
    onDragStart: (e: DragEvent<HTMLElement>) => {
      e.stopPropagation();
      try {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', m.ride.rider.name);
        e.dataTransfer.setData(RIDE_MIME, m.ride.id);
      } catch {
        /* a synthetic event without a data transfer */
      }
      movingRef.current = m;
      setMoving(m);
    },
    onDragEnd: end,
  });

  /**
   * Props for a drop target. A refused drop is still taken, so the reason
   * outlives the hover: the card says it while the rider is over it, and
   * the drop says it again in a toast.
   */
  const target = (id: string) => ({
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (!movingRef.current) return;
      e.preventDefault();
      try {
        e.dataTransfer.dropEffect = 'move';
      } catch {
        /* as above */
      }
      if (overRef.current !== id) {
        overRef.current = id;
        setOver(id);
      }
    },
    onDragLeave: (e: DragEvent<HTMLElement>) => {
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      if (overRef.current === id) {
        overRef.current = null;
        setOver(null);
      }
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      e.preventDefault();
      const m = movingRef.current;
      end();
      if (m) onDrop(m, id);
    },
  });

  return { moving, over, source, target, cancel: end };
}
