import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ReadinessStrip } from '@/pages/emergency/EmergencyHome';

/** F500 G2 — the quiet emergency page says how ready a declaration would be. */
describe('<ReadinessStrip>', () => {
  it('reach by text, the languages and the vans ready, from the counts', () => {
    render(
      <MemoryRouter>
        <ReadinessStrip
          r={{
            reach: 20,
            withPhone: 17,
            languages: [
              { lang: 'en', people: 12 },
              { lang: 'es', people: 6 },
              { lang: 'tr', people: 2 },
            ],
            vans: { ready: 3, seats: 36, inService: 4 },
          }}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText('If you declared for every site now')).toBeInTheDocument();
    expect(screen.getByText('17 of 20 have a phone number on file · 3 would get email and the app only')).toBeInTheDocument();
    expect(screen.getByText('English 12 · Spanish 6 · Turkish 2')).toBeInTheDocument();
    expect(screen.getByText('Vans ready tonight')).toBeInTheDocument();
    expect(screen.getByText('36 seats · 1 more with no driver')).toBeInTheDocument();
  });

  it('leaves the vans out when the company runs none — not a zero', () => {
    render(
      <MemoryRouter>
        <ReadinessStrip r={{ reach: 5, withPhone: 5, languages: [{ lang: 'en', people: 5 }], vans: null }} />
      </MemoryRouter>,
    );
    expect(screen.getByText('5 of 5 have a phone number on file')).toBeInTheDocument();
    expect(screen.queryByText('Vans ready tonight')).not.toBeInTheDocument();
  });
});
