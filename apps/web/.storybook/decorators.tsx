import * as React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Decorator } from '@storybook/react-vite';
import { ROLE_CAPABILITIES, type AuthUser, type Capability, type Role } from '@alto-people/shared';
import { AuthContext, DEFAULT_TENANT, type TenantSession } from '@/lib/auth';
import { I18nProvider } from '@/lib/i18n';
import { ThemeProvider } from '@/lib/theme';
import { DensityProvider } from '@/lib/density';
import { PageTitleProvider } from '@/lib/pageTitle';
import { ConfirmProvider } from '@/lib/confirm';
import { Toaster } from '@/components/ui/Toaster';

/**
 * The app's providers around every story, in main.tsx's order: React Query,
 * i18n (English), theme, density, a signed-in person (auth + tenant), the
 * page-title context, confirm dialogs, a router, and the toaster.
 *
 * Per story, through `parameters`:
 *   auth:  { role, capabilities, user, tenant } — who is signed in. Default
 *          an HR administrator at Alto HR with every capability the role
 *          has; `auth: null` renders signed out.
 *   route: the URL the story sits at (default '/'), for components that
 *          read ?params or link relative to the page.
 *   api:   the fake API (see mockApi.ts).
 */

type AuthState = NonNullable<React.ContextType<typeof AuthContext>>;

export interface StoryAuth {
  role?: Role;
  /** Narrow the role's capabilities (a custom role). Default: all the role has. */
  capabilities?: Capability[];
  user?: Partial<AuthUser>;
  tenant?: Partial<TenantSession>;
}

const noop = async () => undefined;

export function fakeAuth(opts: StoryAuth | null | undefined): AuthState {
  if (opts === null) {
    return {
      isInitializing: false,
      isOffline: false,
      user: null,
      role: null,
      primaryRole: null,
      availableRoles: [],
      capabilities: new Set<Capability>(),
      tenant: DEFAULT_TENANT,
      signIn: async () => ({ mfaRequired: false, mfaEnrollmentRequired: false }),
      submitMfaChallenge: noop,
      signOut: noop,
      refreshUser: noop,
      switchRole: noop,
      can: () => false,
    };
  }
  const role: Role = opts?.role ?? 'HR_ADMINISTRATOR';
  const ceiling = ROLE_CAPABILITIES[role];
  const capabilities: ReadonlySet<Capability> = opts?.capabilities
    ? new Set(opts.capabilities.filter((c) => ceiling.has(c)))
    : ceiling;
  const user: AuthUser = {
    id: '00000000-0000-4000-8000-0000000000a1',
    email: 'jordan.reyes@altohr.com',
    role,
    status: 'ACTIVE',
    clientId: null,
    associateId: null,
    firstName: 'Jordan',
    lastName: 'Reyes',
    photoUrl: null,
    timezone: 'America/New_York',
    mfaEnabled: true,
    ...opts?.user,
  };
  return {
    isInitializing: false,
    isOffline: false,
    user,
    role,
    primaryRole: role,
    availableRoles: [role],
    capabilities,
    tenant: { ...DEFAULT_TENANT, id: '00000000-0000-4000-8000-000000000001', orgName: 'Alto HR', ...opts?.tenant },
    signIn: async () => ({ mfaRequired: false, mfaEnrollmentRequired: false }),
    submitMfaChallenge: noop,
    signOut: noop,
    refreshUser: noop,
    switchRole: noop,
    can: (c) => capabilities.has(c),
  };
}

/**
 * The theme toolbar (and VITE_SB_THEME in the story tests) drives the same
 * two switches the app uses: localStorage `alto.theme`, which ThemeProvider
 * reads, and `<html data-theme>`, which the :root tokens in index.css key
 * off. Written before the providers mount, so the first paint is right.
 */
function applyStoryTheme(theme: 'light' | 'dark') {
  try {
    window.localStorage.setItem('alto.theme', theme);
    // Stories read in English whatever the browser's language.
    window.localStorage.setItem('alto.lang', 'en');
  } catch {
    /* storage blocked: data-theme below still applies */
  }
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.density = 'comfortable';
}

function StoryProviders({
  theme,
  auth,
  route,
  children,
}: {
  theme: 'light' | 'dark';
  auth: StoryAuth | null | undefined;
  route: string;
  children: React.ReactNode;
}) {
  // A fresh cache per story: one story's answers never leak into the next.
  const [client] = React.useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false },
          mutations: { retry: false },
        },
      }),
  );
  const authValue = React.useMemo(() => fakeAuth(auth), [auth]);
  return (
    <QueryClientProvider client={client}>
      <I18nProvider>
        {/* Keyed by theme: ThemeProvider reads alto.theme once, on mount. */}
        <ThemeProvider key={theme}>
          <DensityProvider>
            <AuthContext.Provider value={authValue}>
              <PageTitleProvider>
                <ConfirmProvider>
                  <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
                  <Toaster />
                </ConfirmProvider>
              </PageTitleProvider>
            </AuthContext.Provider>
          </DensityProvider>
        </ThemeProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
}

export const withAppProviders: Decorator = (Story, context) => {
  const theme = context.globals.theme === 'dark' ? 'dark' : 'light';
  applyStoryTheme(theme);
  const params = context.parameters as { auth?: StoryAuth | null; route?: string };
  return (
    <StoryProviders theme={theme} auth={params.auth} route={params.route ?? '/'}>
      <Story />
    </StoryProviders>
  );
};
