// English for the pages that use 'shiftLeads.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enShiftLeads = {
  'shiftLeads.floorSupervisors': 'Floor supervisors:',
  'shiftLeads.title': 'Shift leads',
  'shiftLeads.summary': '{covered} of {total} shifts led',
  'shiftLeads.allClear': 'Every named shift has a lead.',
  'shiftLeads.noneNamed': 'No store has named its shifts yet.',
  'shiftLeads.noLead': 'No lead',
  'shiftLeads.noShift': 'No shift',
  'shiftLeads.assign': 'Assign:',
  'shiftLeads.noSupervisor': 'No shift supervisor at this client yet.',
} as const;

registerEnglish(enShiftLeads);
