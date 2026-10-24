// English for the pages that use 'earn.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enEarn = {
  // Earnings motivation card
  'earn.title': 'My earnings this week',
  'earn.readyToday': 'Ready to earn ~{amount} today?',
  'earn.finishToday': 'Finish today and add ~{amount} more.',
  'earn.soFar': 'earned so far',
  'earn.projected': 'projected by Friday',
  'earn.live': 'Earning now · {rate}/hr',
  'earn.otUnlocked': 'Overtime unlocked — every hour now pays {rate}',
  'earn.otPace': 'On pace for {hours}h of overtime this week (paid 1.5×)',
  'earn.weekBarsLabel': 'Earnings by day this week — solid is worked, light is scheduled',
  'earn.rateLine': '{worked}h worked · {remaining}h scheduled · {rate}/hr',
  'earn.daysLeft': '{n} days left',
  'earn.dayLeft': '1 day left',
  'earn.paceTo': 'On pace for {amount} by Friday',
  'earn.paceBefore': 'On pace for ',
  'earn.paceAfter': ' by Friday',
  'earn.beatsLast': 'beats last week',
  'earn.shortOfLast': '· {amount} short of last week',
  'earn.weekWrapped': "That's your week — nice work.",
  'earn.takeHome': 'About {amount} take-home so far this week',
  'earn.takeHomeLine': 'Take-home is after about {taxes} in taxes, {deductions} in deductions and {advances} already paid early.',
  'earn.hoursRate': '{worked} · {rate}/hr',
  'earn.details': 'Details',
  'earn.lastWeekPlain': 'Last week: {amount}',
  'earn.lastWeek': 'Last week: {amount} —',
  'earn.beatPace': "you're on pace to beat it",
  'earn.behindPace': '{amount} more to beat it',
  'earn.openShifts': '{count} open shifts you qualify for · up to ~{amount} more',
  'earn.paystubs': 'View paychecks',
  'earn.pickup': 'Want more? Grab an open shift.',
  'earn.disclaimer':
    'Estimated at your hourly rate, before taxes — your paycheck is the official number.',
} as const;

registerEnglish(enEarn);
