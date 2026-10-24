// English for the pages that use 'shift.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enShift = {
  'shift.directions': 'Directions',
  // Shift card
  'shift.next': 'Next',
  'shift.confirmed': 'Confirmed',
  'shift.confirmNeeded': 'Confirm needed',
  'shift.open': 'Open',
  'shift.worked': 'Worked',
  'shift.draft': 'Draft',
  'shift.cancelled': 'Cancelled',
  'shift.workingWithYou': 'Working with you',
  'shift.tapFace': 'Tap a face to see who it is',
  'shift.noTeammates': 'No one else is scheduled alongside this shift yet.',
  'shift.managerNote': 'Note from your manager: ',
  'shift.illBeThere': "I'll be there",
  'shift.youConfirmed': 'You confirmed this shift',
  'shift.confirmedToast': 'Confirmed — your manager can see you acknowledged it.',
  'shift.offerToTeammate': 'Offer this shift to a teammate',
  'shift.requestOff': 'Request this shift off',
  'shift.offerTo': 'Offer to',
  'shift.loadingTeammates': 'Loading teammates…',
  'shift.pickTeammate': 'Pick a teammate',
  'shift.busyDuring': ' — busy during this shift',
  'shift.tradeLabel': 'Take one of their shifts in exchange (optional)',
  'shift.justHandOff': 'Nothing — just hand mine off',
  'shift.noteOptional': 'Note (optional)',
  'shift.notePlaceholder': "e.g. Doctor's appointment that morning",
  'shift.sendRequest': 'Send request',
  'shift.detailFailed': 'Could not load shift details.',
  'shift.confirmFailed': 'Could not confirm the shift.',
  'shift.cantMakeIt': "I can't make it",
  'shift.cantMakeItTitle': "Can't make this shift?",
  'shift.cantMakeItBody': 'We will tell your supervisor and look for someone to cover it. The shift stays yours until someone is approved for it; you will hear when it is off your schedule.',
  'shift.cantMakeItConfirm': 'Tell my supervisor',
  'shift.declinedToast': 'Thanks for telling us. We are looking for cover.',
  'shift.declinedNote': "You said you can't make it. We are looking for cover.",
  'shift.declineFailed': 'Could not send your answer.',
  'shift.teammatesFailed': 'Could not load teammates.',
  'shift.tradeProposedToast':
    'Trade proposed. They accept first, then your manager approves both halves.',
  'shift.swapSentToast':
    'Swap request sent. Track it under Shift swaps below — your manager has the final say.',
  'shift.swapSendFailed': 'Could not send the swap request.',
} as const;

registerEnglish(enShift);
