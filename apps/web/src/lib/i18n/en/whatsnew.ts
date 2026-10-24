// English for the pages that use 'whatsnew.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enWhatsnew = {
  // "What's new" release card (associate-visible entries)
  'whatsnew.title': 'New this week',
  'whatsnew.dismiss': 'Dismiss what’s new',
  'whatsnew.weekAhead':
    "You'll get “Your week ahead” the evening before your work week starts.",
  'whatsnew.espanol': 'La aplicación ahora habla español — cámbialo en el menú.',
  'whatsnew.seeAll': 'See everything new',
  'whatsnew.pageTitle': "What's new",
  'whatsnew.pageSubtitle': 'Every release, newest first.',
  'whatsnew.empty': 'Nothing announced yet.',
  'whatsnew.draft': 'Draft',
  'whatsnew.photoCrop':
    'Set your profile photo with a proper position-and-zoom step — Settings → Profile photo.',
  'whatsnew.confirmTap': 'Confirm a shift with one tap, right from the schedule list.',
  'whatsnew.clockNumber': 'Your clock-in number now lives on your Home screen — tap to reveal.',
} as const;

registerEnglish(enWhatsnew);
