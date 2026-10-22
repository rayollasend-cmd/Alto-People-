/**
 * Brief 2-2 — the labor rules engine (docs/labor-rules-investigation.md).
 *
 *   params/packs/resolve  the rule families, the shipped packs, resolution;
 *   evaluate              evaluateTime (buckets, premiums, reasons) and
 *                         evaluateSchedule (the publish gate);
 *   hours                 splitHours — the ONE split every caller uses: the
 *                         paycheck, the payroll sheet, the client statement,
 *                         the estimates and the cost views (audit 2026-10-21
 *                         #11); payContext loads what pay splits by;
 *   store/shadow/live     stored sets, the shadow beside each run, and the
 *                         per-jurisdiction LIVE switch with counsel's sign-off.
 */
export * from './params.js';
export * from './packs.js';
export * from './resolve.js';
export * from './evaluate.js';
export * from './hours.js';
export * from './store.js';
export * from './shadow.js';
