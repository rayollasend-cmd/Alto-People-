import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Capability } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import { ApiError } from '@/lib/api';
import { Login } from '@/pages/Login';

function renderLogin(signIn = vi.fn(async () => {})) {
  const value = {
    isInitializing: false,
    isOffline: false,
    user: null,
    role: null,
    capabilities: new Set<Capability>(),
    signIn,
    signOut: vi.fn(),
    can: () => false,
  };
  return {
    signIn,
    ...render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <AuthContext.Provider value={value}>
          <MemoryRouter>
            <Login />
          </MemoryRouter>
        </AuthContext.Provider>
      </QueryClientProvider>,
    ),
  };
}

describe('<Login>', () => {
  it('renders email and password fields and a sign-in button', () => {
    renderLogin();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^password/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });

  it('disables the submit button until a password is typed — no sign-up length rule on sign-in', async () => {
    const user = userEvent.setup();
    renderLogin();
    const button = screen.getByRole('button', { name: /sign in/i });
    expect(button).toBeDisabled();

    // An older, shorter password still signs in: the 12-character rule is for choosing one.
    await user.type(screen.getByLabelText(/^password/i), 'short');
    expect(button).not.toBeDisabled();
    expect(screen.queryByText(/minimum 12 characters/i)).not.toBeInTheDocument();
  });

  it('calls signIn with the trimmed email and password on submit', async () => {
    const user = userEvent.setup();
    const signIn = vi.fn(async () => {});
    renderLogin(signIn);

    await user.clear(screen.getByLabelText(/email/i));
    await user.type(screen.getByLabelText(/email/i), '  admin@altohr.com  ');
    await user.type(screen.getByLabelText(/^password/i), 'password-1234');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(signIn).toHaveBeenCalledTimes(1));
    expect(signIn).toHaveBeenCalledWith('admin@altohr.com', 'password-1234');
  });

  it('shows a generic error when signIn fails with 401', async () => {
    const user = userEvent.setup();
    const signIn = vi.fn(async () => {
      throw new ApiError(401, 'invalid_credentials', 'Invalid email or password');
    });
    renderLogin(signIn);

    await user.type(screen.getByLabelText(/email/i), 'admin@altohr.com');
    await user.type(screen.getByLabelText(/^password/i), 'password-1234');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/invalid email or password/i);
  });

  it('shows a rate-limit message on 429', async () => {
    const user = userEvent.setup();
    const signIn = vi.fn(async () => {
      throw new ApiError(429, 'rate_limited', 'rate limited');
    });
    renderLogin(signIn);

    await user.type(screen.getByLabelText(/email/i), 'admin@altohr.com');
    await user.type(screen.getByLabelText(/^password/i), 'password-1234');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/too many login attempts/i);
  });

  it('shows a transient-error message on 5xx instead of blaming credentials', async () => {
    const user = userEvent.setup();
    const signIn = vi.fn(async () => {
      throw new ApiError(500, 'internal', 'boom');
    });
    renderLogin(signIn);

    await user.type(screen.getByLabelText(/email/i), 'admin@altohr.com');
    await user.type(screen.getByLabelText(/^password/i), 'password-1234');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/trouble signing you in/i);
    expect(alert.textContent).not.toMatch(/invalid email or password/i);
  });
});
