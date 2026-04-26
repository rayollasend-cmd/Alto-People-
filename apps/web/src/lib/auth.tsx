import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import {
  type Role,
  type Capability,
  ROLES,
  ROLE_CAPABILITIES,
  hasCapability,
} from './roles';

const STORAGE_KEY = 'alto.mockRole';

interface AuthState {
  role: Role | null;
  capabilities: ReadonlySet<Capability>;
  signIn: (role: Role) => void;
  signOut: () => void;
  can: (capability: Capability) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

function readStoredRole(): Role | null {
  if (typeof window === 'undefined') return null;
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (!stored) return null;
  return stored in ROLES ? (stored as Role) : null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [role, setRole] = useState<Role | null>(readStoredRole);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (role) window.localStorage.setItem(STORAGE_KEY, role);
    else window.localStorage.removeItem(STORAGE_KEY);
  }, [role]);

  const value = useMemo<AuthState>(() => {
    const capabilities = role
      ? ROLE_CAPABILITIES[role]
      : (new Set<Capability>() as ReadonlySet<Capability>);
    return {
      role,
      capabilities,
      signIn: (next) => setRole(next),
      signOut: () => setRole(null),
      can: (cap) => (role ? hasCapability(role, cap) : false),
    };
  }, [role]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { role } = useAuth();
  const location = useLocation();
  if (!role) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }
  return <>{children}</>;
}
