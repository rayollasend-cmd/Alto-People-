// English for the pages that use 'emergency.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enEmergency = {
  // Emergency Mode — the one-tap check-in (Brief 1C-1)
  'emergency.title': 'Emergency: {title}',
  'emergency.shiftsSuspended': 'Your shifts are suspended. They do not count against you.',
  'emergency.prompt': 'Are you safe? One tap tells your team.',
  'emergency.safe': "I'm safe",
  'emergency.needHelp': 'I need help',
  'emergency.needRide': 'I need a ride',
  'emergency.rideHint': 'A van will come to the address on file.',
  'emergency.rideBooked': 'Your evacuation seat is booked. Watch the Rides tab for the van.',
  'emergency.rideRequested': 'Seat requested — dispatch is placing you on a van.',
  'emergency.respondedSafe': 'Thanks — you checked in safe at {time}.',
  'emergency.respondedHelp': 'Help is on the way. You checked in at {time}.',
  'emergency.change': 'Change my answer',
  'emergency.sending': 'Sending…',
  'emergency.failed': 'That did not go through. Try again, or call your supervisor.',
  'emergency.noAddress': 'We have no address on file for you. Add your home in the Rides tab, then try again.',
} as const;

registerEnglish(enEmergency);
