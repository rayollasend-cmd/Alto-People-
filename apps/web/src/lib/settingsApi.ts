import type {
  ChangePasswordInput,
  UpdateProfileInput,
} from '@alto-people/shared';
import { apiFetch } from './api';

export interface ProfileResponse {
  firstName: string;
  lastName: string;
  email: string;
}

export function changePassword(body: ChangePasswordInput): Promise<void> {
  return apiFetch<void>('/auth/change-password', { method: 'POST', body });
}

export function updateProfile(body: UpdateProfileInput): Promise<ProfileResponse> {
  return apiFetch<ProfileResponse>('/auth/me/profile', { method: 'PATCH', body });
}

export type LoginEventAction =
  | 'auth.login'
  | 'auth.logout'
  | 'auth.password_changed'
  | 'auth.password_reset_completed';

export interface LoginEvent {
  id: string;
  action: LoginEventAction;
  at: string;
  ip: string | null;
  userAgent: string | null;
}

export function getLoginHistory(): Promise<{ events: LoginEvent[] }> {
  return apiFetch<{ events: LoginEvent[] }>('/auth/me/login-history');
}
