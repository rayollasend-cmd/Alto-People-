import { useContext } from 'react';
import { isClientBoundedRole } from '@alto-people/shared';
import { AuthContext } from './auth';

/**
 * Labor cost — spend, projected shift cost, per-day totals — is org
 * economics: store-bound roles (the shift supervisor) never see it, on any
 * surface (owner decision 2026-09-17; the API withholds the money reads
 * too). Pay rates stay: they're a scheduling input the supervisor sets.
 *
 * Reads the context softly so components rendered without an
 * AuthProvider (tests, previews) keep showing what they always did.
 */
export function useLaborCostVisible(): boolean {
  const role = useContext(AuthContext)?.user?.role;
  return !(role && isClientBoundedRole(role));
}
