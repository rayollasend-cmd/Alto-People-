import type { ControlRoomResponse, ControlRoomSiteOption } from '@alto-people/shared';
import { apiFetch } from '@/lib/api';

/** Brief 3-3: the control room's reads. Actions go through the record's own API. */
export function listControlRoomSites(): Promise<{ sites: ControlRoomSiteOption[] }> {
  return apiFetch<{ sites: ControlRoomSiteOption[] }>('/control-room/sites');
}

export function getControlRoom(locationId: string): Promise<ControlRoomResponse> {
  return apiFetch<ControlRoomResponse>(`/control-room?locationId=${encodeURIComponent(locationId)}`);
}
