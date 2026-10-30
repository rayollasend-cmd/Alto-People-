import { describe, expect, it } from 'vitest';
import { HugoMemoryPatchSchema, checkHugoMemoryText, hugoMemorySameText } from '../hugoMemory.js';

/**
 * What Hugo knows — the guard every fact passes (packages/shared/src/hugoMemory.ts).
 * Each sensitive category is refused in each of the six languages associates
 * read; ordinary facts about the person go through untouched.
 */

const refused = (text: string) => {
  const r = checkHugoMemoryText(text);
  return r.ok ? null : r.reason;
};

describe('checkHugoMemoryText — keeps facts about the person', () => {
  it.each([
    'I prefer morning shifts',
    'I take the 6:10 van from the Main St stop',
    'Call me Rafa',
    'They call me Rafa at work',
    'I can’t work Sundays',
    'I like short answers in Spanish',
    'I’m saving up for a car',
    'I live with my mom', // about the person; the relation isn't the subject
    'Prefiero turnos de noche',
    'Trabajo hasta las 5 los viernes', // "hasta" is Spanish "until", not Turkish "sick"
    'Sabah vardiyalarını tercih ederim',
    'Mwen pito travay nan maten',
    'Prefiro trabalhar de manhã',
    'Я віддаю перевагу ранковим змінам',
    'My name is Cristian', // a name, not a religion
  ])('keeps %s', (text) => {
    expect(checkHugoMemoryText(text)).toEqual({ ok: true, text });
  });

  it('tidies spaces into one line, and refuses empty or too long', () => {
    expect(checkHugoMemoryText('  I prefer\n mornings  ')).toEqual({ ok: true, text: 'I prefer mornings' });
    expect(refused('   ')).toBe('EMPTY');
    expect(refused('a'.repeat(201))).toBe('TOO_LONG');
    expect(checkHugoMemoryText('a'.repeat(200)).ok).toBe(true);
  });
});

describe('checkHugoMemoryText — never keeps', () => {
  const cases: Record<string, Record<string, string>> = {
    SECRET: {
      en: 'My SSN is 123-45-6789',
      es: 'Mi contraseña es girasol',
      tr: 'Şifrem 4455',
      ht: 'Modpas mwen se lakay',
      pt: 'Minha senha é sol123',
      uk: 'Мій пароль — сонце',
      account: 'Account 1234 5678 9012 3456',
      phone: 'Text me at (555) 123-4567',
      email: 'Email me at ana@example.com',
    },
    HEALTH: {
      en: 'I’m pregnant',
      es: 'Estoy embarazada',
      tr: 'Hamileyim',
      ht: 'Mwen ansent',
      pt: 'Estou grávida',
      uk: 'Я вагітна',
      disability: 'I use a wheelchair',
      medical: 'I have diabetes so I need breaks',
    },
    RELIGION: {
      en: 'I go to church on Sundays',
      es: 'Voy a la iglesia los domingos',
      tr: 'Cuma günleri camiye giderim',
      ht: 'Mwen ale legliz dimanch',
      pt: 'Vou à igreja aos domingos',
      uk: 'Я ходжу до церкви в неділю',
    },
    IMMIGRATION: {
      en: 'My visa expires in May',
      j1: 'I’m on a J-1 until September',
      es: 'No tengo papeles, estoy sin papeles',
      tr: 'Vizem mayısta bitiyor', // vize*
      ht: 'Mwen san papye',
      pt: 'Estou sem documentos',
      uk: 'Моя віза закінчується в травні',
    },
    ORIENTATION: {
      en: 'I’m gay',
      es: 'Soy lesbiana',
      tr: 'Ben eşcinselim',
      ht: 'Mwen se madivin',
      pt: 'Sou bissexual',
      uk: 'Я гей',
    },
    CRIMINAL: {
      en: 'I have a felony on my record',
      es: 'Tengo antecedentes penales',
      tr: 'Sabıka kaydım var',
      ht: 'Mwen te nan prizon',
      pt: 'Tenho ficha criminal',
      uk: 'У мене є судимість',
    },
    UNION: {
      en: 'I’m a union member',
      es: 'Estoy en el sindicato',
      tr: 'Sendika üyesiyim',
      ht: 'Mwen nan yon sendika',
      pt: 'Sou do sindicato',
      uk: 'Я член профспілки',
    },
    OTHER_PERSON: {
      en: 'My coworker Maria is getting divorced',
      he: 'He drinks before his shifts',
      es: 'Mi jefe se va a divorciar',
      tr: 'Müdürüm boşanıyor',
      ht: 'Madanm mwen pa renmen travay li',
      pt: 'Minha chefe vai se divorciar',
      uk: 'Мій начальник розлучається',
      lead: 'Remember that she is leaving',
    },
  };
  for (const [reason, byLang] of Object.entries(cases)) {
    for (const [lang, text] of Object.entries(byLang)) {
      it(`${reason} (${lang}): ${text}`, () => {
        expect(refused(text)).toBe(reason);
      });
    }
  }
});

describe('the same fact twice', () => {
  it('is the same without case, accents or punctuation', () => {
    expect(hugoMemorySameText('I prefer mornings.', 'i prefer  MORNINGS')).toBe(true);
    expect(hugoMemorySameText('Prefiero mañanas', 'prefiero mananas')).toBe(true);
    expect(hugoMemorySameText('I prefer mornings', 'I prefer nights')).toBe(false);
  });
});

describe('HugoMemoryPatchSchema', () => {
  it('changes only what is sent, and needs something to change', () => {
    expect(HugoMemoryPatchSchema.parse({ text: 'I prefer nights' })).toEqual({ text: 'I prefer nights' });
    expect(HugoMemoryPatchSchema.parse({ kind: 'TRAVEL' })).toEqual({ kind: 'TRAVEL' });
    expect(() => HugoMemoryPatchSchema.parse({})).toThrow();
  });
});
