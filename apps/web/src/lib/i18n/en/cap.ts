// English for the pages that use 'cap.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enCap = {
  // Camera capture (documents + profile photo)
  'cap.unavailable': 'Camera unavailable',
  'cap.checkPerms': 'Camera unavailable. Check browser permissions.',
  'cap.fallbackHint':
    'No problem — you can take the photo with your phone’s camera app instead. No browser permission needed.',
  'cap.openCameraApp': 'Use my camera app',
  'cap.opening': 'Opening camera…',
  'cap.fillFrame': 'Fill the frame edge to edge',
  'cap.capture': 'Capture',
  'cap.retake': 'Retake',
  'cap.usePhoto': 'Use this photo',
  'cap.previewAlt': 'Captured photo preview',
  'cap.captureFailed': 'Capture failed — try again.',
} as const;

registerEnglish(enCap);
