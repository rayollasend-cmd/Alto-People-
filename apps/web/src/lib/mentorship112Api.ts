import { apiFetch } from './api';

export type MentorshipStatus =
  | 'PROPOSED'
  | 'ACTIVE'
  | 'COMPLETED'
  | 'DECLINED'
  | 'CANCELLED';

export interface Mentorship {
  id: string;
  mentorAssociateId: string;
  mentorName: string;
  menteeAssociateId: string;
  menteeName: string;
  focusSkillName: string | null;
  goals: string | null;
  status: MentorshipStatus;
  startedAt: string | null;
  endedAt: string | null;
  endedReason: string | null;
  createdAt: string;
}

export interface MentorshipCandidate {
  associateId: string;
  name: string;
  email: string;
  level: 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED' | 'EXPERT';
  yearsExperience: number | null;
  verified: boolean;
}

export const listMentorships = (params?: {
  status?: MentorshipStatus;
  associateId?: string;
}) => {
  const q = new URLSearchParams();
  if (params?.status) q.set('status', params.status);
  if (params?.associateId) q.set('associateId', params.associateId);
  const suffix = q.toString() ? `?${q.toString()}` : '';
  return apiFetch<{ mentorships: Mentorship[] }>(`/mentorships${suffix}`);
};

export const proposeMentorship = (input: {
  mentorAssociateId: string;
  menteeAssociateId: string;
  focusSkillId?: string | null;
  goals?: string | null;
}) =>
  apiFetch<{ id: string }>('/mentorships', { method: 'POST', body: input });

export const transitionMentorship = (
  id: string,
  input: {
    status: 'ACTIVE' | 'COMPLETED' | 'DECLINED' | 'CANCELLED';
    endedReason?: string;
  },
) =>
  apiFetch<{ ok: true }>(`/mentorships/${id}/transition`, {
    method: 'POST',
    body: input,
  });

export const suggestMentors = (input: {
  menteeAssociateId: string;
  skillId: string;
}) =>
  apiFetch<{ candidates: MentorshipCandidate[] }>('/mentorships/suggest', {
    method: 'POST',
    body: input,
  });
