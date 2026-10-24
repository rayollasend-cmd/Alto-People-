// English for the pages that use 'swap.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enSwap = {
  // Shift swaps (marketplace section)
  'swap.title': 'Shift swaps',
  'swap.tabIncoming': 'incoming',
  'swap.tabOutgoing': 'outgoing',
  'swap.loadFailed': 'Failed to load.',
  'swap.actionFailed': 'Action failed.',
  'swap.emptyIncomingTitle': 'No incoming swap requests',
  'swap.emptyOutgoingTitle': 'No outgoing swap requests',
  'swap.emptyIncomingDesc':
    "When a teammate asks to swap a shift with you, it'll show up here.",
  'swap.emptyOutgoingDesc':
    'Request a swap from your assigned shift in the schedule above.',
  'swap.theyTake': 'They take your: ',
  'swap.youTake': 'You take their: ',
  'swap.from': 'From',
  'swap.to': 'To',
  'swap.accept': 'Accept',
  'swap.decline': 'Decline',
  'swap.declineConfirmTitle': 'Decline this swap request?',
  'swap.declineConfirmDesc': '{name} will be notified that you declined.',
  'swap.stWaitingYou': 'Waiting for you to accept',
  'swap.stWaitingYouHint':
    'Accept or decline below — a manager gives final approval after that.',
  'swap.stWaitingPeer': 'Waiting for {name} to accept',
  'swap.stWaitingPeerHint': 'Once they accept, a manager gives final approval.',
  'swap.stAccepted': 'Accepted — waiting for manager approval',
  'swap.stAcceptedHint': "You'll be notified when a manager decides.",
  'swap.stYouDeclined': 'You declined',
  'swap.stPeerDeclined': '{name} declined',
  'swap.stApproved': 'Approved — schedules updated',
  'swap.stRejected': 'Not approved',
  'swap.stRejectedHint':
    'A manager rejected this swap — the shift stays as originally scheduled.',
  'swap.stCancelledByRequester': '{name} cancelled this request',
  'swap.stCancelled': 'Cancelled',
} as const;

registerEnglish(enSwap);
