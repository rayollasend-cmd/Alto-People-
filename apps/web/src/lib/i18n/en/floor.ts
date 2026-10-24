// English for the pages that use 'floor.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enFloor = {
  // My floor — the shift lead's home (tiles and the clock banner).
  'floor.siteOps': '{site} ops',
  'floor.notInYet': 'Not in yet',
  'floor.everyoneIn': 'Everyone due is in',
  'floor.noPunchYet': 'Shift started, no punch',
  'floor.unfilledToday': 'Unfilled today',
  'floor.everySlotFilled': 'Every slot filled',
  'floor.watchNothingWaiting': 'Nothing is waiting on you. What needs a decision goes to your lead.',
  'floor.watchLeadDecides': 'You watch the floor; your lead decides. Anything here is yours to open, not to rule on.',
  'floor.openSlots': 'Open slots on the schedule',
  'floor.shiftSop': 'Shift SOP',
  'floor.sopSubmitted': 'Your {window} SOP is submitted',
  'floor.clockOutAtTablet': 'Clock out at the {siteLc} tablet whenever you’re done.',
  'floor.clockOutWhenDone': 'You can clock out whenever you’re done.',
  'floor.clockInCovering':
    'Clock in at the {siteLc} tablet with your clock-in number — the shift’s SOP opens for you, and it’s yours to submit.',
  'floor.clockInHelping': 'Clock in at the {siteLc} tablet with your clock-in number — you help on {whose} SOP.',
  'floor.clockInHereOrKiosk': 'Clock in here or at the kiosk — your shift’s SOP opens by itself.',
  'floor.yourShifts': 'your shift’s',
} as const;

registerEnglish(enFloor);
