// English for the pages that use 'callout.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enCallout = {
  'callout.title': "Can't make it?",
  'callout.body': "{shift}. Pick a reason — your lead is told and we start finding cover right away.",
  'callout.why': "Why?",
  'callout.reason.SICK': "Sick",
  'callout.reason.FAMILY': "Family",
  'callout.reason.TRANSPORT': "Ride or transportation",
  'callout.reason.EMERGENCY': "Emergency",
  'callout.reason.BEREAVEMENT': "Bereavement",
  'callout.reason.JURY_DUTY': "Jury duty",
  'callout.reason.OTHER': "Something else",
  'callout.note': "Anything your lead should know (optional)",
  'callout.confirm': "Call out",
  'callout.keep': "Keep my shift",
  'callout.late': "It's less than 2 hours before your shift — if you can, call your lead too.",
  'callout.recent': "You called out of {position}, {when}. Your lead knows and cover is under way.",
  'callout.failed': "That didn't go through. Try again, or call your lead.",
} as const;

registerEnglish(enCallout);
