import type {
  ChangePasswordInput,
  ConfirmEmailChangeInput,
  MfaDisableInput,
  MfaEnrollConfirmInput,
  MfaEnrollStartResponse,
  NotificationCategory,
  NotificationPreferenceEntry,
  RequestEmailChangeInput,
  SupportedTimezone,
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
  | 'auth.password_reset_completed'
  | 'auth.sessions_revoked';

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

export function revokeOtherSessions(): Promise<void> {
  return apiFetch<void>('/auth/me/revoke-other-sessions', { method: 'POST' });
}

export function updateTimezone(timezone: SupportedTimezone | null): Promise<void> {
  return apiFetch<void>('/auth/me/timezone', {
    method: 'PATCH',
    body: { timezone },
  });
}

export function getNotificationPreferences(): Promise<{
  entries: NotificationPreferenceEntry[];
}> {
  return apiFetch<{ entries: NotificationPreferenceEntry[] }>(
    '/auth/me/notification-preferences',
  );
}

export function patchNotificationPreference(
  category: NotificationCategory,
  emailEnabled: boolean,
): Promise<void> {
  return apiFetch<void>('/auth/me/notification-preferences', {
    method: 'PATCH',
    body: { category, emailEnabled },
  });
}

export function requestEmailChange(body: RequestEmailChangeInput): Promise<void> {
  return apiFetch<void>('/auth/me/email-change/request', {
    method: 'POST',
    body,
  });
}

export function confirmEmailChange(body: ConfirmEmailChangeInput): Promise<void> {
  return apiFetch<void>('/auth/email-change/confirm', {
    method: 'POST',
    body,
  });
}

export function startMfaEnrollment(): Promise<MfaEnrollStartResponse> {
  return apiFetch<MfaEnrollStartResponse>('/auth/me/mfa/enroll/start', {
    method: 'POST',
  });
}

export function confirmMfaEnrollment(body: MfaEnrollConfirmInput): Promise<void> {
  return apiFetch<void>('/auth/me/mfa/enroll/confirm', {
    method: 'POST',
    body,
  });
}

export function disableMfa(body: MfaDisableInput): Promise<void> {
  return apiFetch<void>('/auth/me/mfa', {
    method: 'DELETE',
    body,
  });
}

export async function downloadDataExport(): Promise<void> {
  const res = await fetch('/api/auth/me/data-export', {
    method: 'GET',
    credentials: 'include',
  });
  if (!res.ok) {
    let message = 'Could not download your data.';
    try {
      const data = await res.json();
      if (data?.error?.message) message = data.error.message;
    } catch {
      /* keep default */
    }
    throw new Error(message);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const cd = res.headers.get('content-disposition') ?? '';
  const m = /filename="([^"]+)"/.exec(cd);
  const filename = m?.[1] ?? 'alto-data-export.zip';
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
