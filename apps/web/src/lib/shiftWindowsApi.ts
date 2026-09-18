import { apiFetch } from './api';

/**
 * Supervisor shift windows — the store shift windows ("Overnight 10p–6a") a
 * shift supervisor leads, assigned the way their client is. Focus, not a
 * lock: their pages open on these hours and shift alerts reach them first;
 * they still see the whole store.
 */

export interface MyShiftWindow {
  locationId: string;
  locationName: string;
  timezone: string;
  label: string;
  startMinute: number;
  endMinute: number;
  targetCount: number;
}

export function getMyShiftWindows(): Promise<{ windows: MyShiftWindow[] }> {
  return apiFetch<{ windows: MyShiftWindow[] }>('/me/shift-windows');
}

export interface StoreShiftWindows {
  locationId: string;
  locationName: string;
  timezone: string;
  windows: Array<{
    label: string;
    startMinute: number;
    endMinute: number;
    targetCount: number;
    leads: Array<{ userId: string; name: string }>;
  }>;
}

export function listClientShiftWindows(clientId: string): Promise<{ stores: StoreShiftWindows[] }> {
  return apiFetch<{ stores: StoreShiftWindows[] }>(
    `/admin/shift-windows?clientId=${encodeURIComponent(clientId)}`,
  );
}

export function setSupervisorShiftWindows(
  userId: string,
  windows: Array<{ locationId: string; label: string }>,
): Promise<{ windows: Array<{ locationId: string; label: string }> }> {
  return apiFetch(`/admin/users/${userId}/shift-windows`, {
    method: 'PUT',
    body: { windows },
  });
}
