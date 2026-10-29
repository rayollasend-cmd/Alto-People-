import type { Capability, TenantModule } from '@alto-people/shared';

/**
 * The tabs a person's record shows this login — a tab the API would turn
 * away isn't shown. One rule for the record itself (PersonRecord) and the
 * shortcuts into it (⌘K's person actions), so a shortcut never lands on a
 * tab that quietly falls back to the first one.
 *
 * Overview comes first and is the default (F500 fix-up, G1): what needs
 * attention, their work and pay at a glance, before the 13-section
 * Profile read-out.
 */
export type PersonTabKey = 'overview' | 'profile' | 'employment' | 'pay' | 'time' | 'timeoff' | 'performance' | 'cases' | 'documents' | 'thread';

export function personRecordTabs(can: (c: Capability) => boolean, moduleOn: (m: TenantModule) => boolean): PersonTabKey[] {
  const keys: PersonTabKey[] = ['overview', 'profile', 'employment'];
  if (can('view:comp') || can('process:payroll')) keys.push('pay');
  if (can('manage:time') && moduleOn('time')) keys.push('time');
  if (can('manage:time')) keys.push('timeoff');
  if (can('view:hr-admin')) keys.push('performance');
  // The case desk's own rule (API lib/hrCaseScope.hrDeskScope, PEOPLE-5):
  // HR is view:hr-admin AND manage:onboarding; payroll works its desk. The
  // recruiter and the workforce manager hold manage:onboarding alone and
  // now read no one's cases — the tab would only say "Couldn't load".
  if (moduleOn('hrCases') && ((can('view:hr-admin') && can('manage:onboarding')) || can('process:payroll'))) keys.push('cases');
  // The vault reads need manage:documents (GET /documents/admin/vault/:id) —
  // a role with view:documents alone met "Missing capability" (PEOPLE-8).
  if (can('manage:documents')) keys.push('documents');
  keys.push('thread');
  return keys;
}
