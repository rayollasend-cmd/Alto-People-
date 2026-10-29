import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { Avatar } from '@/components/ui/Avatar';
import { associateFace, forgetMissingPhotos, isPhotoKnownMissing, personPhotoUrl, shiftHolderFace } from '@/lib/photoUrl';

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

/**
 * LEAD-12 / FLOOR-25 / PEOPLE-26 (deep audit 2026-10-29): 36 photo 404s on one
 * schedule load, 10 on the client's Today. The roster, shift, day, document,
 * E-Verify, background and time-off payloads now say whether a photo exists;
 * a row whose payload says "none" (null) asks for nothing.
 */
describe('payload faces', () => {
  it('a roster row with photoUrl null: no request, initials', () => {
    expect(associateFace({ id: 'a1', photoUrl: null })).toBeUndefined();
    const { container } = render(<Avatar src={associateFace({ id: 'a1', photoUrl: null })} name="Dana Reyes" />);
    expect(imgs(container)).toHaveLength(0);
    expect(container.textContent).toBe('DR');
  });

  it('a roster row with a photo: its versioned URL', () => {
    expect(associateFace({ id: 'a1', photoUrl: '/api/associates/a1/photo?v=9' })).toBe('/api/associates/a1/photo?v=9');
  });

  it('an older payload without the field still tries the bare path (one request, remembered on a miss)', () => {
    expect(associateFace({ id: 'a1' })).toBe('/api/associates/a1/photo');
    expect(associateFace(null)).toBeUndefined();
  });

  it("a shift's holder: assignedAssociatePhotoUrl decides", () => {
    expect(shiftHolderFace({ assignedAssociateId: 'a1', assignedAssociatePhotoUrl: null })).toBeUndefined();
    expect(shiftHolderFace({ assignedAssociateId: 'a1', assignedAssociatePhotoUrl: '/api/associates/a1/photo?v=2' })).toBe('/api/associates/a1/photo?v=2');
    expect(shiftHolderFace({ assignedAssociateId: null })).toBeUndefined();
  });

  it('a photo that fails to load falls back to initials', () => {
    const { container } = render(<Avatar src="/api/associates/a9/photo?v=1" name="Kim Ode" />);
    fireEvent.error(container.querySelector('img')!);
    expect(imgs(container)).toHaveLength(0);
    expect(container.textContent).toBe('KO');
  });
});
