// English for the pages that use 'bell.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enBell = {
  // Notifications bell (role walk floor 10, 23).
  'bell.title': 'Notifications',
  'bell.ariaNew': 'Notifications ({n} new for you)',
  'bell.oneNew': '1 new notification for you',
  'bell.nNew': '{n} new notifications for you',
  'bell.inbox': 'Notifications',
  'bell.markAllRead': 'Mark all read',
  'bell.whichAria': 'Which notifications',
  'bell.needsMe': 'Needs me',
  'bell.everything': 'Everything',
  'bell.failed': 'Failed to load. Retrying…',
  'bell.caughtUp': 'All caught up',
  'bell.caughtUpBody': 'You’ll see new in-app messages here.',
  'bell.nothingMine': 'Nothing is waiting on you here',
  'bell.nothingMineBody': 'Everything is read or for your information.',
  'bell.showEverything': 'Show everything',
  'bell.showingLatest': 'Showing the latest {shown} of {total}',
  'bell.viewAll': 'View all notifications',
  'bell.latest': 'Latest: {text}',
  'bell.nUnread': '{n} unread',
  'bell.markTheseRead': 'Mark these {n} read',
} as const;

registerEnglish(enBell);
