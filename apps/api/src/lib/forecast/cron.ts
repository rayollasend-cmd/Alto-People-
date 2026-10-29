import { tenantJob } from '../tenantJobs.js';
import { monthlyForecastSweep } from './run.js';
import { logger } from '../logger.js';

/**
 * Brief 3-4: once a month per tenant (checked every six hours, so a restart
 * never misses the month), the forecast scores what came true and
 * recomputes with the weights the scoring picked. Never armed in tests.
 */
const SWEEP_MS = 6 * 3_600_000;
let timer: NodeJS.Timeout | null = null;

export function startForecastCron(): void {
  if (timer) return;
  const tick = tenantJob('forecast', () => monthlyForecastSweep(), { module: 'scheduling' });
  void tick().catch((err) => console.error('[alto-people/api] forecast sweep failed:', err));
  timer = setInterval(() => {
    void tick().catch((err) => console.error('[alto-people/api] forecast sweep failed:', err));
  }, SWEEP_MS);
  timer.unref();
  logger.info('forecast cron armed (monthly per tenant, checked every 6h)');
}

export function stopForecastCron(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
