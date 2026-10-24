// English for the pages that use 'career.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enCareer = {
  'career.mine': 'Where you are',
  'career.youAreHere': 'You are here',
  'career.theyAreHere': 'Here now',
  'career.nextRung': 'Next step',
  'career.progress': '{pct}% of the way there',
  'career.progressLabel': 'Progress toward {title}',
  'career.reqTenure': 'Time in the job',
  'career.reqReview': 'Latest review',
  'career.reqCert': 'Certification: {name}',
  'career.noReview': 'No review yet',
  'career.notYet': 'Not yet',
  'career.months': '{n} months',
  'career.rating': '{n} of 5',
  'career.met': 'done',
  'career.notMet': 'not yet',
  'career.haveNeed': 'You: {have} · Needs: {need}',
  'career.noLadderSelf': 'You’re not on a career ladder yet. Ask your supervisor where you can grow next.',
  'career.noLadderOther': 'Not on a career ladder yet — give them a job profile that sits on a ladder.',
  'career.placedByRole': 'Placed by their role',
  'career.noRequirements': 'Nothing set for this step yet — talk to your supervisor.',
  'career.topSelf': 'You’re at the top of this ladder.',
  'career.topOther': 'At the top of this ladder.',
  'career.skill.BEGINNER': 'Beginner',
  'career.skill.INTERMEDIATE': 'Intermediate',
  'career.skill.ADVANCED': 'Advanced',
  'career.skill.EXPERT': 'Expert',
} as const;

registerEnglish(enCareer);
