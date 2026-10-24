// English for the pages that use 'home.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enHome = {
  'home.greetLate': 'Up late',
  'home.greetMorning': 'Good morning',
  'home.greetAfternoon': 'Good afternoon',
  'home.greetEvening': 'Good evening',
  'home.greetNight': 'Burning the midnight oil',
  'home.needsYou': 'Needs you',
} as const;

registerEnglish(enHome);
