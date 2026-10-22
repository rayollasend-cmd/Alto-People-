import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { Avatar } from '@/components/ui/Avatar';
import { forgetMissingPhotos, isPhotoKnownMissing, personPhotoUrl } from '@/lib/photoUrl';

/**
 * One request per known photo (G4: ~24 404s on one Users page load). A row
 * the API says has no photo asks for none; a URL that came back missing is
 * never asked for again this session; an upload clears that memory.
 */

beforeEach(() => forgetMissingPhotos());

const imgs = (c: HTMLElement) => c.querySelectorAll('img');

describe('Avatar', () => {
  it('hasPhoto={false}: initials, and no image request at all', () => {
    const { container } = render(<Avatar src="/api/users/u1/photo" hasPhoto={false} name="Rosa Martinez" />);
    expect(imgs(container)).toHaveLength(0);
    expect(container.textContent).toBe('RM');
  });

  it('a photo that comes back missing is not asked for again by the next row', () => {
    const first = render(<Avatar src="/api/associates/a1/photo" name="Dee Kpakpo" />);
    const img = first.container.querySelector('img')!;
    expect(img).toHaveAttribute('src', '/api/associates/a1/photo');
    fireEvent.error(img);
    expect(isPhotoKnownMissing('/api/associates/a1/photo')).toBe(true);
    expect(imgs(first.container)).toHaveLength(0);
    // The same person further down the list, or on the next page.
    const second = render(<Avatar src="/api/associates/a1/photo" name="Dee Kpakpo" />);
    expect(imgs(second.container)).toHaveLength(0);
    expect(second.container.textContent).toBe('DK');
    // Someone else is still asked for.
    const other = render(<Avatar src="/api/associates/a2/photo" name="Alan Darison" />);
    expect(imgs(other.container)).toHaveLength(1);
  });

  it('after an upload, a face that was missing is asked for again', () => {
    const first = render(<Avatar src="/api/associates/a1/photo" name="Dee Kpakpo" />);
    fireEvent.error(first.container.querySelector('img')!);
    forgetMissingPhotos();
    const again = render(<Avatar src="/api/associates/a1/photo" name="Dee Kpakpo" />);
    expect(imgs(again.container)).toHaveLength(1);
  });
});

describe('personPhotoUrl', () => {
  it('an API photoUrl of null is an answer: no guessed URL', () => {
    expect(personPhotoUrl({ photoUrl: null, associateId: 'a1', userId: 'u1' })).toBeUndefined();
  });

  it('hasPhoto: false says the same', () => {
    expect(personPhotoUrl({ hasPhoto: false, associateId: 'a1' })).toBeUndefined();
  });

  it('prefers the API URL (it carries the cache-buster), then the headshot, then the login', () => {
    expect(personPhotoUrl({ photoUrl: '/api/associates/a1/photo?v=5', associateId: 'a1' })).toBe('/api/associates/a1/photo?v=5');
    expect(personPhotoUrl({ associateId: 'a1', userId: 'u1' })).toBe('/api/associates/a1/photo');
    expect(personPhotoUrl({ userId: 'u1' })).toBe('/api/users/u1/photo');
    expect(personPhotoUrl({})).toBeUndefined();
  });
});
