import type { ReactNode } from 'react';
import { PLATFORM_OPERATOR_TENANT_ID } from '@alto-people/shared';
import { useTenant } from '@/lib/auth';
import { NotFound } from '@/pages/NotFound';

/**
 * The platform operator's own tools (Reliability, Product usage, the
 * design system): a customer's account — even an HR administrator holding
 * the capability — gets the ordinary not-found page, as the API answers
 * 404 to them (F500 audit 2026-10-26: every customer could open them).
 */
export function OperatorOnly({ children }: { children: ReactNode }) {
  return useTenant().id === PLATFORM_OPERATOR_TENANT_ID ? <>{children}</> : <NotFound />;
}
