import { describe, expect, it } from 'vitest';
import { becauseSentence } from '../paySchedules.js';

describe('becauseSentence', () => {
  it('says the engine’s reason about the person', () => {
    expect(becauseSentence('Client: Coastal Resort Holdings')).toBe('They work for Coastal Resort Holdings');
    expect(becauseSentence('Site: Seaside')).toBe('They work at Seaside');
    expect(becauseSentence('Department: Housekeeping')).toBe('They’re in Housekeeping');
    expect(becauseSentence('Individual')).toBe('Chosen for them by name');
    expect(becauseSentence('Company default')).toBe('No rule covers them, so the company default applies');
    expect(becauseSentence('Hourly staff')).toBe('They’re paid hourly');
  });

  it('with a name, about them by name', () => {
    expect(becauseSentence('Client: Seaside Inn', 'Ana')).toBe('Ana works for Seaside Inn');
    expect(becauseSentence('Department: Housekeeping', 'Ana')).toBe('Ana is in Housekeeping');
    expect(becauseSentence('Salaried staff', 'Ana')).toBe('Ana is salaried');
    expect(becauseSentence('Company default', 'Ana')).toBe('No rule covers Ana, so the company default applies');
  });

  it('reads anything else as given', () => {
    expect(becauseSentence('transferred to Seaside')).toBe('Transferred to Seaside');
    expect(becauseSentence('')).toBe('');
  });
});
