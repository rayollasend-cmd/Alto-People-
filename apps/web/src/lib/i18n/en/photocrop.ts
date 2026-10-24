// English for the pages that use 'photocrop.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enPhotocrop = {
  'photocrop.title': 'Position your photo',
  'photocrop.subtitle':
    'Drag to position, zoom until your face fills the circle — this is exactly how it will appear across the app.',
  'photocrop.use': 'Use photo',
} as const;

registerEnglish(enPhotocrop);
