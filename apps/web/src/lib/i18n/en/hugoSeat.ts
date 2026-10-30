// English for the pages that use 'hugoSeat.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enHugoSeat = {
  'hugoSeat.askName': 'Ask {name}',
  'hugoSeat.ask': 'Ask',
  'hugoSeat.failed': 'The assistant could not answer.',
  'hugoSeat.open': 'Open',
  'hugoSeat.tagline': 'Your assistant',
  'hugoSeat.mood.needsYou': 'I need a quick answer from you',
  'hugoSeat.mood.working': 'Headphones on — working on something for you',
  'hugoSeat.mood.workingMany': 'Headphones on — working on {count} things for you',
  'hugoSeat.mood.done': 'Finished something for you',
  'hugoSeat.mood.news': 'I noticed something for you',
  'hugoSeat.mood.coffee': 'On a coffee break — ask me anything',
  'hugoSeat.mood.reading': 'Catching up on my reading — ask me anything',
  'hugoSeat.allowance.basics': 'Until {date} I can answer the basics.',
} as const;

registerEnglish(enHugoSeat);
