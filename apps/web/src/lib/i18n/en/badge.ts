// English for the pages that use 'badge.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enBadge = {
  'badge.aria': '{name}’s worker badge',
  'badge.kind': 'Worker badge',
  'badge.worker': 'Worker',
  'badge.role': 'Role',
  'badge.site': 'Site',
  'badge.number': 'Clock-in number',
  'badge.qrAlt': 'Your badge code for the kiosk',
  'badge.qrCaption': 'Hold this to the kiosk camera',
  'badge.qrCaptionNumber': 'Or type {number} at the kiosk',
  'badge.walletFailed': 'Couldn’t open the wallet. Try again in a moment.',
  'badge.noNumberTitle': 'Your badge comes with your clock-in number',
  'badge.noNumberBody': 'Ask your supervisor or HR to issue your number. Your badge appears here the moment they do.',
  'badge.loadFailed': 'We couldn’t load your badge.',
  'badge.adding': 'Opening…',
  'badge.addApple': 'Add to Apple Wallet',
  'badge.addGoogle': 'Save to Google Wallet',
  'badge.title': 'Your badge',
  'badge.subtitle': 'Show it at the kiosk instead of typing your number.',
  'badge.show': 'Show badge',
  'badge.walletOff': 'Wallet passes aren’t turned on for your organization yet — show this badge at the kiosk instead.',
  'badge.fullTitle': 'Your badge',
  'badge.fullBody': 'Hold the code up to the kiosk camera. Turn your screen brightness up if it doesn’t read.',
} as const;

registerEnglish(enBadge);
