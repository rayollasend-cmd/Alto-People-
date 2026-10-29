import { useQuery } from '@tanstack/react-query';
import { useTenant } from '@/lib/auth';
import { listClientOptions } from '@/lib/onboardingApi';

/**
 * The client picker every invite, application, bulk invite and offer uses
 * (PEOPLE-4, FLOOR-1): GET /clients/options — the caller's own clients,
 * readable by whoever may invite or onboard. A tenant without clients
 * (the client portal off) never asks.
 */
export function useClientOptions(enabled = true) {
  const clientsOn = useTenant().moduleOn('clientPortal');
  return useQuery({
    queryKey: ['clients', 'options'],
    queryFn: listClientOptions,
    enabled: enabled && clientsOn,
    staleTime: 5 * 60_000,
  });
}
