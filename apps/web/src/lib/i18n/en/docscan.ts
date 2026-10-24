// English for the pages that use 'docscan.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enDocscan = {
  // Document standardization (crop/scan step)
  'docscan.title': 'Line up your document',
  'docscan.subtitle':
    'Drag and zoom until the document fills the frame edge to edge. Every document is saved as a clean, same-size color scan.',
  'docscan.shapeCard': 'ID card',
  'docscan.shapePassport': 'Passport',
  'docscan.shapeLetter': 'Full page',
  'docscan.rotate': 'Rotate 90°',
  'docscan.zoom': 'Zoom',
  'docscan.enhance': 'Scan look (auto color & contrast)',
  'docscan.tooSmall':
    'The document is too small in this photo to stay readable — retake it closer, filling the frame.',
  'docscan.use': 'Use document',
  'docscan.saving': 'Saving…',
  'docscan.badImage': 'That image couldn’t be read — try a different file.',
  'docscan.autoTitle': 'Document found',
  'docscan.autoSubtitle':
    'We detected the edges. Drag the corner dots to fine-tune, then Scan — the photo is flattened into a clean color scan.',
  'docscan.detecting': 'Finding your document…',
  'docscan.dragCorners': 'Drag the dots onto the document corners. The magnifier follows your finger.',
  'docscan.corner': 'Document corner',
  'docscan.adjustManually': 'Crop manually',
  'docscan.backToAuto': 'Auto-detect',
  'docscan.scan': 'Scan document',
  'docscan.badTitle': "Couldn't read that photo",
  'docscan.badBody':
    'The photo may be damaged or in a format this browser can’t open. Take it again with the camera, or pick a JPG or PNG.',
  'docscan.tryAnother': 'Choose another photo',
} as const;

registerEnglish(enDocscan);
