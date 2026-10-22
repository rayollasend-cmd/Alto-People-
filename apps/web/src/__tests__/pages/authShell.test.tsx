import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), apiFetch: vi.fn(() => new Promise(() => {})) }));
vi.mock('@/lib/settingsApi', () => ({ confirmEmailChange: vi.fn(() => new Promise(() => {})) }));
vi.mock('@/lib/auth', async (orig) => ({ ...(await orig<typeof import('@/lib/auth')>()), useAuth: () => ({ signIn: vi.fn(), user: null }) }));

import { ForgotPassword } from '@/pages/ForgotPassword';
import { ResetPassword } from '@/pages/ResetPassword';
import { ConfirmEmailChange } from '@/pages/ConfirmEmailChange';
import { AcceptInvite } from '@/pages/AcceptInvite';
import { Install } from '@/pages/Install';

/**
 * Every signed-out page wears ONE lockup (F500 G5: three different
 * headers, and only /login had the Status · Trust Center · Accessibility
 * footer): the logo and wordmark, the card with the page's own name as its
 * h1, and the footer.
 */

function renderAt(path: string, pattern: string, el: React.ReactElement) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={pattern} element={el} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const PAGES: Array<[string, string, string, () => React.ReactElement, RegExp | null]> = [
  ['forgot password', '/forgot-password', '/forgot-password', () => <ForgotPassword />, /Forgot password/],
  ['reset password', '/reset-password/t1', '/reset-password/:token', () => <ResetPassword />, /New password/],
  ['confirm email change', '/confirm-email-change/t1', '/confirm-email-change/:token', () => <ConfirmEmailChange />, /Confirming your new email/],
  ['accept invite', '/accept-invite/t1', '/accept-invite/:token', () => <AcceptInvite />, null],
  ['install', '/install', '/install', () => <Install />, /Install Alto People|all set/],
];

describe('the signed-out lockup', () => {
  for (const [name, path, pattern, el, h1] of PAGES) {
    it(`${name}: logo and wordmark, its name as the h1, and the public-pages footer`, () => {
      renderAt(path, pattern, el());
      const shell = screen.getByTestId('auth-shell');
      expect(within(shell).getByRole('img')).toBeInTheDocument();
      expect(shell.textContent).toContain('Alto People');
      if (h1) expect(screen.getByRole('heading', { level: 1, name: h1 })).toBeInTheDocument();
      const footer = within(shell).getByRole('navigation');
      for (const link of ['Status', 'Trust Center', 'Accessibility']) {
        expect(within(footer).getByRole('link', { name: new RegExp(link) })).toBeInTheDocument();
      }
    });
  }
});
