/** The scale the load test is run at (Brief 3-6): the numbers the seed and the runner share. */
export const SCALE_WORKERS = Number(process.env.LOAD_WORKERS ?? 50_000);
export const SCALE_SITES = Number(process.env.LOAD_SITES ?? 1_000);
/** Scale associates with a login (the clock-in and login scenarios rotate through them). */
export const SCALE_USERS = Number(process.env.LOAD_USERS ?? 2_000);
export const SCALE_EMAIL_DOMAIN = 'scale.altohr.example';
export const SCALE_EMAIL = (i: number): string => `load.${i}@${SCALE_EMAIL_DOMAIN}`;
/** Twelve characters or more is the login rule. */
export const SCALE_ASSOCIATE_PASSWORD = 'load-associate-2026!!';
export const SCALE_POSITION = 'Scale associate';
export const SCALE_MARKER_ACTION = 'load.seed.completed';
