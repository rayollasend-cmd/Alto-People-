import { useQuery } from '@tanstack/react-query';
import { apiFetch } from './api';

/**
 * The crew card (FLOOR-17): one person a field lead runs the floor with,
 * read-only — GET /crew/:id (apps/api/src/routes/crew.ts). Contact,
 * availability, certifications, attendance, next shifts and the emergency
 * contact. Never pay: the API doesn't send it, and nothing here asks.
 */

export type CrewCredentialStatus = 'valid' | 'expiring' | 'expired';
export type CrewAttendanceKind = 'LATE' | 'EARLY_OUT' | 'CALL_OUT' | 'NO_CALL_NO_SHOW';
export type CrewEmergencyRelation = 'SPOUSE' | 'PARENT' | 'CHILD' | 'SIBLING' | 'FRIEND' | 'OTHER';

export interface CrewCard {
  id: string;
  firstName: string;
  lastName: string;
  name: string;
  hasPhoto: boolean;
  position: string | null;
  hireDate: string | null;
  contact: { phone: string | null; email: string; messageUserId: string | null };
  sites: Array<{ id: string; name: string; timezone: string }>;
  onClock: { since: string; timezone: string } | null;
  nextShifts: Array<{ id: string; startsAt: string; endsAt: string; position: string; siteName: string | null; timezone: string }>;
  availability: {
    /** 0 = Sunday; minutes are the store's wall clock. */
    weekly: Array<{ dayOfWeek: number; startMinute: number; endMinute: number }>;
    unavailableDates: string[];
    timeOff: Array<{ from: string; to: string }>;
  };
  credentials: Array<{ id: string; name: string; isCert: boolean; acquiredOn: string | null; expiresOn: string | null; status: CrewCredentialStatus }>;
  attendance: {
    points: number;
    windowDays: number;
    late: number;
    earlyOut: number;
    callOuts: number;
    noShows: number;
    recent: Array<{ id: string; kind: CrewAttendanceKind; on: string; excused: boolean }>;
  };
  emergencyContact: { name: string; relation: CrewEmergencyRelation; phone: string } | null;
  /** The company day the card was read on (YYYY-MM-DD). */
  today: string;
}

export function getCrewCard(associateId: string): Promise<CrewCard> {
  return apiFetch<CrewCard>(`/crew/${encodeURIComponent(associateId)}`);
}

export function useCrewCard(associateId: string | null) {
  return useQuery({
    queryKey: ['crew', 'card', associateId],
    queryFn: () => getCrewCard(associateId!),
    enabled: !!associateId,
    staleTime: 60_000,
    // A 403/404 is the answer, not a blip — don't hammer it.
    retry: false,
  });
}
