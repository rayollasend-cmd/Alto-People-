import { describe, expect, it } from 'vitest';
import { tileNames } from '@/pages/executive/people/PeopleBand';

/** LEAD-29: two "Kendra" tiles told the chairman nothing. */
describe('tileNames', () => {
  it('first names alone while they are unique', () => {
    expect(tileNames(['Kendra Hill', 'Tess Member', 'Ana Ruiz'])).toEqual(['Kendra', 'Tess', 'Ana']);
  });
  it('adds the last initial where first names collide', () => {
    expect(tileNames(['Kendra Hill', 'Kendra Moss', 'Ana Ruiz'])).toEqual(['Kendra H.', 'Kendra M.', 'Ana']);
  });
  it('falls back to the full name when even the initial collides', () => {
    expect(tileNames(['Tess Member', 'Tess Mills', 'Tess'])).toEqual(['Tess Member', 'Tess Mills', 'Tess']);
  });
});
