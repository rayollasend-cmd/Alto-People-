import type { Role } from '@alto-people/shared';
import { modelAvailable } from './assistantModel.js';
import { modelServes } from './hugoAllowance.js';

/**
 * The model is on, and this person's Hugo may use it — an associate's never
 * does (owner, 2026-10-30; lib/hugoAllowance modelServes). Every way in asks
 * this: the app's chat and GET /hugo, WhatsApp, goals, free-question repeats.
 * runModelLoop checks again before any call.
 */
export function modelAvailableFor(user: { role: Role; primaryRole?: Role | null }): boolean {
  return modelAvailable() && modelServes(user.role, user.primaryRole);
}
