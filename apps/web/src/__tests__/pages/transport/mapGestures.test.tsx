import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@/lib/i18n';

/**
 * Which maps ask for two fingers, and which do not.
 *
 * A map that sits INLINE in a scrolling page is a trap: at 42vh it is
 * under the thumb at the top of the Rides page, and every downward swipe
 * that starts on it pans the map instead of scrolling, so the driver row
 * below cannot be reached by the obvious gesture.
 *
 * The opposite is true of a map that OWNS the screen. In the full-screen
 * view and in the pin dialogs there is nothing behind to scroll to, and
 * the pin dialogs exist precisely so someone can place a pin one-handed —
 * demanding a second finger there would be the obstacle, not the rescue.
 *
 * So this is not a setting to apply everywhere; it is a distinction, and
 * the distinction is what can regress.
 */

const seen: Array<Record<string, unknown>> = [];
vi.mock('@/components/transport/LazyLiveMap', () => ({
  LazyLiveMap: (props: Record<string, unknown>) => {
    seen.push(props);
    return <div data-testid="map" data-cooperative={String(props.cooperativeGestures ?? false)} />;
  },
}));

import { TripMap } from '@/pages/transport/TripMap';

const LIVE = {
  direction: 'TO_HOME',
  pickup: { label: 'Front Beach', point: { lat: 30.21, lng: -85.81 } },
  destination: { label: 'Home', point: { lat: 30.19, lng: -85.79 } },
  position: { lat: 30.2, lng: -85.8 },
  stale: false,
} as never;

function renderTrip() {
  seen.length = 0;
  return render(
    <I18nProvider>
      <TripMap stage="ON_BOARD" live={LIVE} vanLabel="Van 2" className="h-[42vh]" />
    </I18nProvider>,
  );
}

describe('inline map vs a map that owns the screen', () => {
  it('asks for two fingers on the inline Rides-page map', () => {
    renderTrip();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.cooperativeGestures).toBe(true);
  });

  it('does not ask for them once the map goes full screen', async () => {
    renderTrip();
    // The expand control puts the map on its own screen; from there a
    // one-finger drag has nothing to steal.
    await userEvent.click(screen.getByRole('button', { name: 'Full-screen map' }));
    const maps = screen.getAllByTestId('map');
    expect(maps.length).toBeGreaterThan(1);
    // The last one rendered is the full-screen map.
    expect(maps[maps.length - 1]!.dataset.cooperative).toBe('false');
  });
});
