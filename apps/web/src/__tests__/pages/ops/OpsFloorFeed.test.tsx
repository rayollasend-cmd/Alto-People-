import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OpsFloorFeed, OpsPhotoWall } from '@/pages/ops/OpsFloorFeed';
import type { OpsFeedEvent, OpsFeedPhoto } from '@/lib/opsApi';

/**
 * The feed and the photo wall were decoration: relative times, the
 * client's name where the store belongs, no way to narrow them, and no
 * way to get from a line to the shift it came from.
 *
 * These assert the three things that make them useful — the building, the
 * clock, and a way in.
 */

const EVENTS: OpsFeedEvent[] = [
  {
    at: '2026-09-17T02:30:00.000Z',
    kind: 'temp',
    store: 'Destin',
    department: 'Frozen & Dairy',
    period: 'OVERNIGHT',
    shiftId: 'shift-1',
    headline: 'Freezer 3: 12°F',
    detail: 'OUT OF RANGE — alerted',
    alert: true,
    photoId: null,
  },
  {
    at: '2026-09-17T11:05:00.000Z',
    kind: 'task',
    store: 'Front Beach 218',
    department: 'Grocery',
    period: 'MORNING',
    shiftId: 'shift-2',
    headline: 'Aisle 4 faced',
    detail: 'by Rosa M',
    alert: false,
    photoId: null,
  },
];

const PHOTOS: OpsFeedPhoto[] = [
  {
    id: 'p1',
    at: '2026-09-17T02:40:00.000Z',
    store: 'Destin',
    department: 'Frozen & Dairy',
    period: 'OVERNIGHT',
    shiftId: 'shift-1',
    title: 'Check freezer temps',
  },
];

describe('the floor feed', () => {
  it('names the store and the clock, and opens the shift behind a line', async () => {
    const onOpen = vi.fn();
    render(
      <OpsFloorFeed
        events={EVENTS}
        generatedAt="2026-09-17T12:00:00.000Z"
        hours={36}
        loading={false}
        failed={false}
        onOpenRecord={onOpen}
      />,
    );

    const feed = screen.getByRole('region', { name: /floor feed/i });
    expect(within(feed).getByText('Destin')).toBeInTheDocument();
    // A real time, not only "9h ago".
    expect(within(feed).getByText(/10:30 PM/)).toBeInTheDocument();

    await userEvent.click(within(feed).getByRole('button', { name: /Freezer 3/ }));
    expect(onOpen).toHaveBeenCalledWith('shift-1');
  });

  it('narrows to the alerts', async () => {
    render(
      <OpsFloorFeed
        events={EVENTS}
        generatedAt="2026-09-17T12:00:00.000Z"
        hours={36}
        loading={false}
        failed={false}
        onOpenRecord={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /Alerts/ }));
    expect(screen.getByText('Freezer 3: 12°F')).toBeInTheDocument();
    expect(screen.queryByText('Aisle 4 faced')).not.toBeInTheDocument();
  });

  it('says a failed feed failed, rather than calling it quiet', () => {
    render(
      <OpsFloorFeed
        events={null}
        generatedAt={null}
        hours={36}
        loading={false}
        failed
        onOpenRecord={vi.fn()}
      />,
    );
    expect(screen.getByText(/could not be loaded/i)).toBeInTheDocument();
  });
});

describe('from the floor', () => {
  it('captions each photo with its store and time, and opens the shift', async () => {
    const onOpen = vi.fn();
    render(<OpsPhotoWall photos={PHOTOS} loading={false} onOpenRecord={onOpen} />);

    expect(screen.getByText('Check freezer temps')).toBeInTheDocument();
    expect(screen.getByText(/10:40 PM/)).toBeInTheDocument();

    // The full-size link names what it is, rather than repeating the task
    // title on every photo.
    expect(
      screen.getByRole('link', { name: /Check freezer temps, Destin, Overnight/ }),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Open the shift record/ }));
    expect(onOpen).toHaveBeenCalledWith('shift-1');
  });

  it('stays on the page when there are no photos', () => {
    render(<OpsPhotoWall photos={[]} loading={false} onOpenRecord={vi.fn()} />);
    // It used to unmount itself, so nobody learned it existed.
    expect(screen.getByText('From the floor')).toBeInTheDocument();
    expect(screen.getByText('No photos yet')).toBeInTheDocument();
  });
});
