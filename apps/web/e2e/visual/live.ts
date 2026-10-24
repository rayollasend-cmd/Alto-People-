import type { BrowserContext, Page } from '@playwright/test';

/**
 * The two /api endpoints a HAR cannot hold, answered the same way when
 * recording and when replaying (registered after routeFromHAR, so they win):
 *
 * - /api/events/stream is the live-nudge channel (lib/liveEvents.ts), an
 *   EventSource that never ends, so it can never be recorded. It gets an
 *   open, silent stream that asks the browser not to reconnect for a day:
 *   the app sees a healthy connection with nothing to say, which is what a
 *   quiet afternoon looks like.
 * - /api/telemetry/product-events is a write-only beacon (lib/productEvents.ts)
 *   whose body carries session timings; the page never reads its answer.
 */
/** Paths answered here, never from a HAR (the recorder leaves them out). */
export const ANSWERED_IN_CODE = /^\/api\/(events\/stream|telemetry\/)/;

export async function quietChannels(target: Page | BrowserContext) {
  await target.route('**/api/events/stream', (route) =>
    route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: 'retry: 86400000\n\n' }),
  );
  await target.route('**/api/telemetry/**', (route) => route.fulfill({ status: 204, body: '' }));
}
