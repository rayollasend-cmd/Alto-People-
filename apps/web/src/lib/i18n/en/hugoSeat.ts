// English for the pages that use 'hugoSeat.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enHugoSeat = {
  'hugoSeat.askName': 'Ask {name}',
  'hugoSeat.ask': 'Ask',
  'hugoSeat.failed': 'The assistant could not answer.',
  'hugoSeat.open': 'Open',
  'hugoSeat.tagline': 'Your AI assistant — not a person. Ask me anything, or hand me a task.',
} as const;

registerEnglish(enHugoSeat);
