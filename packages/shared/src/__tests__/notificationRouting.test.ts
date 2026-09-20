import { describe, expect, it } from 'vitest';
import { CATEGORY_ROLE_ROUTING, roleWantsCategory } from '../contracts.js';
import { ROLE_CAPABILITIES, rolesWithCapability } from '../roles.js';

/**
 * The admin fan-out picks recipients by capability — every role holding
 * manage:onboarding. That answers "who may see this", and using it as the
 * recipient list is why a marketing manager was told about every OSHA
 * incident in the company. This table answers "whose job is this".
 */

const FANOUT_POOL = rolesWithCapability('manage:onboarding');

describe('who a system notification is for', () => {
  it('keeps the marketing desk out of the floor and the HR file', () => {
    for (const category of ['ops.temp_alert', 'shift_no_show', 'separation', 'hr-cases', 'compliance']) {
      expect(roleWantsCategory('MARKETING_MANAGER', category)).toBe(false);
    }
  });

  it('still sends each event to the people who act on it', () => {
    expect(roleWantsCategory('INTERNAL_RECRUITER', 'onboarding')).toBe(true);
    expect(roleWantsCategory('OPERATIONS_MANAGER', 'ops.handover_alert')).toBe(true);
    expect(roleWantsCategory('WORKFORCE_MANAGER', 'shift_no_show')).toBe(true);
    // ...and not to the ones who don't: hiring is not the ops desk's work.
    expect(roleWantsCategory('OPERATIONS_MANAGER', 'internal-jobs')).toBe(false);
  });

  it('matches a dotted namespace, and does not match a mere prefix', () => {
    expect(roleWantsCategory('OPERATIONS_MANAGER', 'ops.sop_overdue')).toBe(true);
    expect(roleWantsCategory('MARKETING_MANAGER', 'ops.incomplete_close')).toBe(false);
    // 'compliance' routes; 'compliance.attestation.x' is the same family.
    expect(roleWantsCategory('MARKETING_MANAGER', 'compliance.expirations')).toBe(false);
    // But 'onboarding' must not swallow an unrelated category that merely
    // starts with the same letters.
    expect(roleWantsCategory('MARKETING_MANAGER', 'onboardingXyz')).toBe(true);
  });

  it('delivers an unrouted category to everyone, exactly as before', () => {
    // The fail-open rule: this table only narrows where a decision was
    // made, so a category added elsewhere can never silently vanish.
    for (const role of FANOUT_POOL) {
      expect(roleWantsCategory(role, 'some-brand-new-thing')).toBe(true);
      expect(roleWantsCategory(role, undefined)).toBe(true);
      expect(roleWantsCategory(role, null)).toBe(true);
    }
  });

  it('never routes an event to nobody', () => {
    // HR_ADMINISTRATOR is the backstop on every line; without that a
    // routed category could reach an empty set at an org that has not
    // filled the other roles.
    for (const [category, roles] of CATEGORY_ROLE_ROUTING) {
      expect(roles.length, `${category} has no recipients`).toBeGreaterThan(0);
      expect(roles, `${category} has no backstop`).toContain('HR_ADMINISTRATOR');
      // Every routed role must be real, and must actually be in the pool
      // the fan-out selects from — otherwise the line is a no-op.
      for (const r of roles) {
        expect(ROLE_CAPABILITIES, `${r} is not a role`).toHaveProperty(r);
        expect(FANOUT_POOL, `${r} is not in the admin fan-out pool`).toContain(r);
      }
    }
  });
});
