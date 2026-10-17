import { describe, expect, it } from 'vitest';
import { greetingKey, greetingName } from '@/lib/greeting';

describe('greetingName', () => {
  it('greets by first name when the account has one', () => {
    expect(greetingName({ firstName: '  Ana ', email: 'ana.r@example.com' })).toBe('Ana');
  });

  it("never greets by the email's local part — a mailbox is nobody's name", () => {
    expect(greetingName({ firstName: null, email: 'workforce@alto.example' }, '')).toBe('');
    expect(greetingName({ firstName: '', email: 'people.ops@alto.example' }, '')).toBe('');
    expect(greetingName({ email: 'ana.r@example.com' })).toBe('there');
    expect(greetingName(null, '')).toBe('');
  });
});

describe('greetingKey', () => {
  it('picks the greeting for the hour', () => {
    expect(greetingKey(3)).toBe('home.greetLate');
    expect(greetingKey(9)).toBe('home.greetMorning');
    expect(greetingKey(13)).toBe('home.greetAfternoon');
    expect(greetingKey(19)).toBe('home.greetEvening');
    expect(greetingKey(23)).toBe('home.greetNight');
  });
});
