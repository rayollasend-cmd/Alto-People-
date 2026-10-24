// English for the pages that use 'crewText.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enCrewText = {
  'crewText.notSent': 'Nothing was sent — {reason}',
  'crewText.noPhone': 'No phone on file: {names}.',
  'crewText.optedOut': '{n} opted out of texts.',
  'crewText.failed': '{n} could not be delivered — see the communications log.',
  'crewText.sentTo': 'Sent to {n}.',
  'crewText.sendFailed': 'Could not send the text.',
  'crewText.title': 'Text the crew',
  'crewText.descOne': '{label} · 1 person. One SMS each, kept in the log.',
  'crewText.descMany': '{label} · {n} people. One SMS each, kept in the log.',
  'crewText.message': 'Message',
  'crewText.placeholder': 'Dock 2 opens at 5:45 today — come in the side door.',
  'crewText.cancel': 'Cancel',
  'crewText.sendTo': 'Send to {n}',
} as const;

registerEnglish(enCrewText);
