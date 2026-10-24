// English for the pages that use 'addr.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enAddr = {
  // AddressAutocomplete — suggestions under an address form's street line
  'addr.suggestions': 'Address suggestions',
  'addr.found': '{n} addresses found — use the arrow keys to choose one.',
  'addr.foundOne': '1 address found — use the arrow keys to choose it.',
  'addr.filled': 'Address filled in — check it before you save.',
  'addr.byMapbox': 'Address search by Mapbox',
} as const;

registerEnglish(enAddr);
