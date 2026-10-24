// English for the pages that use 'record.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enRecord = {
  'record.signatureAria': 'Signature',
  // My disciplinary record
  'record.title': 'My record',
  'record.titleNotices': 'Notices on file',
  'record.missing': 'That notice isn’t on your record any more.',
  'record.emptyDesc2': 'You have no disciplinary notices.',
  'record.ackNotAgree': 'Acknowledging confirms you received and read this notice — it does not mean you agree with it.',
  'record.addResponse': 'Add your response',
  'record.editResponse': 'Edit your response',
  'record.yourResponse': 'Your response',
  'record.responseLabel': 'Your side — HR reads it with the notice',
  'record.responseHint': '{n} characters left',
  'record.saveResponse': 'Save response',
  'record.responseSaved': 'Your response is saved with the notice.',
  'record.responseFailed': 'Couldn’t save your response. Try again.',
  'record.subtitle':
    'Formal notices addressed to you. Acknowledging confirms you received and read a notice — it does not mean you agree with it.',
  'record.loadFailed': 'Couldn’t load your record.',
  'record.emptyTitle': 'Nothing on file',
  'record.emptyDesc': "You have no disciplinary notices. Keep it that way — we're glad to have you.",
  'record.needsAck': 'Needs your acknowledgment',
  'record.acked': 'Acknowledged',
  'record.rescinded': 'Rescinded',
  'record.dates': 'Incident {incident} · Effective {effective}',
  'record.suspensionDays': ' · {days}-day suspension',
  'record.expected': 'What we need from you: ',
  'record.rescindedAt': 'Rescinded {when}',
  'record.ackedAt': 'You acknowledged this {when} — ',
  'record.signLabel': 'Acknowledge with your signature',
  'record.signHint': 'Type your full name exactly as it appears: ',
  'record.signMismatch': 'Signature must match your name on file.',
  'record.ackButton': 'I acknowledge',
  'record.ackThanks': 'Acknowledged — thank you.',
  'record.ackFailed': 'Could not record the acknowledgment.',
  'record.back': '← Back to my profile',
  'record.kind.VERBAL_WARNING': 'Verbal warning',
  'record.kind.WRITTEN_WARNING': 'Written warning',
  'record.kind.FINAL_WARNING': 'Final warning',
  'record.kind.SUSPENSION': 'Suspension',
  'record.kind.TERMINATION': 'Termination',
} as const;

registerEnglish(enRecord);
