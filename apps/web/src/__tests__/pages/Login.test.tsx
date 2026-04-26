import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
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
      <AuthContext.Provider value={value}>
        <MemoryRouter>
          <Login />
        </MemoryRouter>
      </AuthContext.Provider>
    ),
  };
}

describe('<Login>', () => {
  it('renders email and password fields and a sign-in button', () => {
    renderLogin();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });

  it('disables the submit button until password is at least 12 chars', async () => {
    const user = userEvent.setup();
    renderLogin();
    const button = screen.getByRole('button', { name: /sign in/i });
    expect(button).toBeDisabled();

    await user.type(screen.getByLabelText(/password/i), 'short');
    expect(button).toBeDisabled();

    await user.clear(screen.getByLabelText(/password/i));
    await user.type(screen.getByLabelText(/password/i), 'twelve-chars');
    expect(button).not.toBeDisabled();
  });

  it('calls signIn with the trimmed email and password on submit', async () => {
    const user = userEvent.setup();
    const signIn = vi.fn(async () => {});
    renderLogin(signIn);

    await user.clear(screen.getByLabelText(/email/i));
    await user.type(screen.getByLabelText(/email/i), '  admin@altohr.com  ');
    await user.type(screen.getByLabelText(/password/i), 'password-1234');
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
    await user.type(screen.getByLabelText(/password/i), 'password-1234');
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
    await user.type(screen.getByLabelText(/password/i), 'password-1234');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/too many login attempts/i);
  });
});
