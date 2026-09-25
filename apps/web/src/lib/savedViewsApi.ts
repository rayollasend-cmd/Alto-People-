import type { SavedView, SavedViewInput, SavedViewScope, SavedViewUpdate } from '@alto-people/shared';
import { apiFetch } from './api';

/** Named filter sets on a list: mine first, then the team's shared ones. */
export function listSavedViews(scope: SavedViewScope): Promise<{ views: SavedView[] }> {
  return apiFetch<{ views: SavedView[] }>(`/saved-views?scope=${encodeURIComponent(scope)}`);
}

export function createSavedView(body: SavedViewInput): Promise<SavedView> {
  return apiFetch<SavedView>('/saved-views', { method: 'POST', body });
}

export function updateSavedView(id: string, body: SavedViewUpdate): Promise<SavedView> {
  return apiFetch<SavedView>(`/saved-views/${id}`, { method: 'PATCH', body });
}

export function deleteSavedView(id: string): Promise<void> {
  return apiFetch<void>(`/saved-views/${id}`, { method: 'DELETE' });
}
