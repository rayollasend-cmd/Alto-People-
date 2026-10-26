// English for the pages that use 'inbox.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enInbox = {
  // Associate inbox
  'inbox.title': 'Notifications',
  'inbox.unreadSuffix': '({count} unread)',
  'inbox.subtitle': 'Messages from HR, system notifications, and company broadcasts.',
  'inbox.searchAria': 'Search messages',
  'inbox.searchPlaceholder': 'Search subject, body, or sender…',
  'inbox.unreadOnly': 'Unread only',
  'inbox.markAll': 'Mark all read',
  'inbox.kindPile': '{count} unread like “{subject}”',
  'inbox.clearKind': 'Clear all of this kind',
  'inbox.clearedKind': 'Cleared {count}.',
  'inbox.marking': 'Marking…',
  'inbox.zeroTitle': 'No notifications',
  'inbox.unreadBadge': '{count} unread',
  'inbox.selectAria': 'Select “{subject}”',
  'inbox.selectedCount': '{count} selected',
  'inbox.markSelected': 'Mark read',
  'inbox.clearSelection': 'Clear selection',
  'inbox.showMore': 'Show {count} more',
  'inbox.readerEmpty': 'Pick a notification to read it here.',
  'inbox.unreadDot': 'Unread',
  'inbox.clearKindShort': 'Clear',
  'inbox.zeroDesc': 'Messages from HR, system notifications, and broadcasts will land here.',
  'inbox.noMatches': 'No matches',
  'inbox.noMatchesUnread': 'Nothing unread matches. Clear the filters to see everything.',
  'inbox.noMatchesSearch': 'Nothing matches your search.',
  'inbox.message': '{count} message',
  'inbox.messages': '{count} messages',
  'inbox.unreadInGroup': '· {count} unread',
  'inbox.broadcast': 'Broadcast',
  'inbox.noSubject': '(no subject)',
  'inbox.fromTeam': 'From the Alto People team',
  'inbox.open': 'Open',
  'inbox.loadFailed': 'Failed to load inbox.',
  'inbox.markFailed': 'Could not mark the message as read.',
  'inbox.repeats': '{count}×',
  'inbox.repeatsTitle': 'The same notification {count} times — the newest is shown.',
} as const;

registerEnglish(enInbox);
