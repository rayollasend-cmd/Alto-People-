import { describe, expect, it } from 'vitest';
import { instantIntent, pickTier, routingText } from '../../lib/hugoRouting.js';
import type { HugoContext } from '../../lib/hugo.js';

/**
 * Which way a question goes: the registry at once, the quick model, or the
 * strongest. The instant path is narrow — a wrong instant answer is worse
 * than a slower right one.
 */
const ctx = (audience: HugoContext['audience']): HugoContext => ({ channel: 'app', audience, moduleOn: () => true, capabilityOn: () => true });
const examples = [
  { key: 'PAYDAY', example: 'When is my next payday?' },
  { key: 'DESK', example: 'What is waiting on me?' },
  { key: 'HELP_CENTER', example: 'How many sick days do I get?' },
];

describe('routingText', () => {
  it('drops case, accents, apostrophes and punctuation', () => {
    expect(routingText('¿Cuándo me pagan?')).toBe('cuando me pagan');
    expect(routingText("Why didn't I get paid?!")).toBe('why didnt i get paid');
  });
});

describe('instantIntent', () => {
  it('a tapped suggestion is the registry’s answer, for anyone — but a help-center question still goes to the model', () => {
    expect(instantIntent('When is my next payday?', ctx('associate'), examples)).toBe('PAYDAY');
    expect(instantIntent('what is waiting on me', ctx('manager'), examples)).toBe('DESK');
    expect(instantIntent('How many sick days do I get?', ctx('associate'), examples)).toBeNull();
  });

  it('a worker’s short, plain question about their own records is instant, in their language', () => {
    expect(instantIntent('when do I get paid', ctx('associate'), [])).toBe('PAYDAY');
    expect(instantIntent('¿Cuándo me pagan?', ctx('associate'), [])).toBe('PAYDAY');
    expect(instantIntent('my next shift', ctx('associate'), [])).toBe('SCHEDULE');
    expect(instantIntent('where is my van', ctx('associate'), [])).toBe('RIDE');
  });

  it('judgment, a long question, or a desk’s own words go to a model', () => {
    expect(instantIntent("why didn't I get paid", ctx('associate'), [])).toBeNull();
    expect(instantIntent('how much is my check', ctx('associate'), [])).toBeNull();
    expect(instantIntent('can I swap my shift', ctx('associate'), [])).toBeNull();
    expect(instantIntent('is my van late', ctx('associate'), [])).toBeNull();
    expect(instantIntent('when is my next shift and who else is working with me that day', ctx('associate'), [])).toBeNull();
    expect(instantIntent('my next shift', ctx('manager'), [])).toBeNull();
    expect(instantIntent('my badge broke', ctx('associate'), [])).toBeNull();
  });
});

describe('pickTier', () => {
  const desk = { canPropose: true, canReport: true };
  const worker = { canPropose: false, canReport: false };
  it('actions and numbers take the strongest model; everyday questions the quick one', () => {
    expect(pickTier('approve Ana’s time off', desk)).toBe('deep');
    expect(pickTier('how many call-outs by store this month?', desk)).toBe('deep');
    expect(pickTier('who is on the floor tonight?', desk)).toBe('fast');
    expect(pickTier('why was my check short?', worker)).toBe('fast');
    // Without the tool, the words alone don't buy the stronger model.
    expect(pickTier('approve my time off', worker)).toBe('fast');
  });
  it('several questions at once, or a long story, take the strongest', () => {
    expect(pickTier('When do I work? And when is payday?', worker)).toBe('deep');
    expect(pickTier('x'.repeat(300), worker)).toBe('deep');
  });
});
