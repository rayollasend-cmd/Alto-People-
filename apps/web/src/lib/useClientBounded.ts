import { useContext } from 'react';
import { isClientBoundedRole } from '@alto-people/shared';
import { AuthContext } from './auth';

/**
 * True for store-bound roles (the shift supervisor, the floor supervisor,
 * the client portal) — their client never changes, so it earns no place on
 * a row or a tile (the portal's rule: show the store only when rows span
 * stores). Reads the context softly so components rendered without an
 * AuthProvider (tests, previews) keep their org-wide labels.
 */
export function useClientBounded(): boolean {
  const role = useContext(AuthContext)?.user?.role;
  return !!role && isClientBoundedRole(role);
}
