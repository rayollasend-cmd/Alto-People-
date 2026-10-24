// English for the pages that use 'rtw.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enRtw = {
  'rtw.title': 'Ready to work',
  'rtw.clearedAt': 'Your clock-in number is active for',
  'rtw.supervisors': 'Your shift supervisors',
  'rtw.noSupervisors': 'Your store’s supervisors will be in touch — HR has your details.',
  'rtw.next': 'What happens next: your supervisor schedules your first shift. It will show up here and you will get a notification.',
  'rtw.firstShift': 'Your first shift:',
  'rtw.kioskReminder': 'Bring your clock-in number on day one — it was sent to your email — and punch in at the kiosk when you arrive.',
} as const;

registerEnglish(enRtw);
