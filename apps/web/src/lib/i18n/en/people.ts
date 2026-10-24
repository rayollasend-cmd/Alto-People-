// English for the pages that use 'people.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enPeople = {
  // One status per person (F500 SH-4; apps/api/src/lib/peopleStatus.ts).
  'people.ws.ACTIVE': 'Working',
  'people.ws.PLACED_NOT_ACTIVE': 'No recent shifts',
  'people.ws.NOT_PLACED': 'Not placed',
  'people.ws.ONBOARDING': 'Onboarding',
  'people.ws.DEACTIVATED': 'Paused',
  'people.ws.SEPARATED': 'Separated',
  'people.wsDef.ACTIVE': 'Placed at a site, and worked in the last {days} days or has a shift ahead.',
  'people.wsDef.PLACED_NOT_ACTIVE': 'Placed at a site, but no shift worked in the last {days} days and nothing scheduled.',
  'people.wsDef.NOT_PLACED': 'Hired, but not placed at any site.',
  'people.wsDef.ONBOARDING': 'Onboarding is still in progress. Not hired yet.',
  'people.wsDef.DEACTIVATED': 'Paused by hand. Still employed, but can’t clock in until reactivated.',
  'people.wsDef.SEPARATED': 'No longer with the company.',
  'people.onTheBooks': 'On the books',
  'people.onTheBooksDef': 'Hired and not separated: working, no recent shifts, not placed and paused.',
  'people.workingWindow': 'Working ({days} days)',
  'people.workingDef': 'Placed at a site, and worked in the last {days} days or has a shift ahead.',
  'people.tileFilter': 'Show only these people',
  'people.tileClear': 'Show everyone',
  'people.account': 'Account',
} as const;

registerEnglish(enPeople);
