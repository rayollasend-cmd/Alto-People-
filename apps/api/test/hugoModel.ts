import { afterAll, beforeAll, onTestFinished } from 'vitest';
import { env } from '../src/config/env.js';

/**
 * For a file that drives Hugo's model machinery with an associate: lets
 * associates use the model for the whole file, as a deployment with
 * HUGO_MODEL_OFF_ROLES empty would. By default an associate's Hugo never
 * calls it (owner, 2026-10-30) — `associatesOffTheModel()` puts that back
 * inside a test that checks it.
 */
export function letAssociatesUseTheModel(): void {
  const saved = env.HUGO_MODEL_OFF_ROLES;
  beforeAll(() => {
    Object.assign(env, { HUGO_MODEL_OFF_ROLES: '' });
  });
  afterAll(() => {
    Object.assign(env, { HUGO_MODEL_OFF_ROLES: saved });
  });
}

/** Inside one test: the production default again — an associate's Hugo never calls the model. */
export function associatesOffTheModel(): void {
  const before = env.HUGO_MODEL_OFF_ROLES;
  Object.assign(env, { HUGO_MODEL_OFF_ROLES: 'ASSOCIATE' });
  onTestFinished(() => {
    Object.assign(env, { HUGO_MODEL_OFF_ROLES: before });
  });
}
