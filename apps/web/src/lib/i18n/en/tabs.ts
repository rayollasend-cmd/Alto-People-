// English for the pages that use 'tabs.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enTabs = {
  // Bottom tab bar
  'tabs.home': 'Home',
  'tabs.schedule': 'Schedule',
  'tabs.clock': 'Clock',
  'tabs.timeOff': 'Time off',
  'tabs.pay': 'Pay',
  'tabs.more': 'More',
  'tabs.moreAria': 'More — open full navigation',
  'tabs.primaryAria': 'Primary',
  // Bottom tab bar — the manager/scheduler/recruiter tabs (wired by BottomTabBar)
  'tabs.approvals': 'Approvals',
  'tabs.time': 'Time',
  'tabs.recruiting': 'Recruiting',
  'tabs.onboarding': 'Onboarding',
  'tabs.liveBoard': 'Live board',
  'tabs.commandCenter': 'Command center',
  'tabs.inbox': 'Inbox',
  'tabs.people': 'People',
  'tabs.ride': 'Ride',
  'tabs.myTeam': 'My team',
} as const;

registerEnglish(enTabs);
