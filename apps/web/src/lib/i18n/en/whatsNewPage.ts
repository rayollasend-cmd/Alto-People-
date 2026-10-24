// English for the pages that use 'whatsNewPage.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enWhatsNewPage = {
  'whatsNewPage.audience.all': 'Everyone',
  'whatsNewPage.audience.admin': 'Admins & managers',
  'whatsNewPage.audience.associate': '{workers}',
  'whatsNewPage.audience.supervisor': 'Shift supervisors',
  'whatsNewPage.audience.driver': 'Drivers',
  'whatsNewPage.audience.client': 'Store portal',
  'whatsNewPage.publishedToast': 'Release note published.',
  'whatsNewPage.draftSavedToast': 'Draft saved.',
  'whatsNewPage.saveFailed': 'Could not save the note.',
  'whatsNewPage.deletedToast': 'Release note deleted.',
  'whatsNewPage.deleteFailed': 'Could not delete the note.',
  'whatsNewPage.newNote': 'New note',
  'whatsNewPage.loadWhat': 'release notes',
  'whatsNewPage.editAria': 'Edit note for {day}',
  'whatsNewPage.deleteAria': 'Delete note for {day}',
  'whatsNewPage.deleteConfirm': 'Delete this release note?',
  'whatsNewPage.editTitle': 'Edit release note',
  'whatsNewPage.newTitle': 'New release note',
  'whatsNewPage.releaseDay': 'Release day',
  'whatsNewPage.audienceLabel': 'Audience',
  'whatsNewPage.removeBulletAria': 'Remove bullet {n}',
  'whatsNewPage.spanishLabel': 'Español (optional — English shows when empty)',
  'whatsNewPage.addBullet': 'Add a bullet',
  'whatsNewPage.publishedCheckbox': 'Published — on every home screen at the next open',
  'whatsNewPage.publish': 'Publish',
  'whatsNewPage.saveDraft': 'Save draft',
} as const;

registerEnglish(enWhatsNewPage);
