import { apiFetch } from './api';

export type SkillLevel = 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED' | 'EXPERT';

export interface LadderRow {
  id: string;
  name: string;
  family: string | null;
  description: string | null;
  clientName: string | null;
  levelCount: number;
}

export interface LevelSkill {
  id: string;
  skillId: string;
  skillName: string;
  skillCategory: string | null;
  minLevel: SkillLevel;
}

export interface Level {
  id: string;
  rank: number;
  title: string;
  description: string | null;
  jobProfileId: string | null;
  jobProfileTitle: string | null;
  jobProfileCode: string | null;
  /** What the rung asks for beyond skills. */
  requiredQualificationCodes?: string[];
  minTenureMonths?: number | null;
  minReviewRating?: number | null;
  skills: LevelSkill[];
}

export interface LadderDetail {
  id: string;
  name: string;
  family: string | null;
  description: string | null;
  clientName: string | null;
  levels: Level[];
}

export const SKILL_LEVEL_LABELS: Record<SkillLevel, string> = {
  BEGINNER: 'Beginner',
  INTERMEDIATE: 'Intermediate',
  ADVANCED: 'Advanced',
  EXPERT: 'Expert',
};

export const listLadders = () =>
  apiFetch<{ ladders: LadderRow[] }>('/career-ladders');

export const getLadder = (id: string) =>
  apiFetch<LadderDetail>(`/career-ladders/${id}`);

export const createLadder = (input: {
  clientId?: string | null;
  name: string;
  family?: string | null;
  description?: string | null;
}) =>
  apiFetch<{ id: string }>('/career-ladders', { method: 'POST', body: input });

export const addLevel = (
  ladderId: string,
  input: {
    rank: number;
    title: string;
    description?: string | null;
    jobProfileId?: string | null;
    requiredQualificationCodes?: string[];
    minTenureMonths?: number | null;
    minReviewRating?: number | null;
  },
) =>
  apiFetch<{ id: string }>(`/career-ladders/${ladderId}/levels`, {
    method: 'POST',
    body: input,
  });

export const updateLevel = (
  id: string,
  input: Partial<{
    title: string;
    description: string | null;
    jobProfileId: string | null;
    requiredQualificationCodes: string[];
    minTenureMonths: number | null;
    minReviewRating: number | null;
  }>,
) =>
  apiFetch<{ ok: true }>(`/career-levels/${id}`, {
    method: 'PATCH',
    body: input,
  });

export const deleteLevel = (id: string) =>
  apiFetch<void>(`/career-levels/${id}`, { method: 'DELETE' });

export const addLevelSkill = (
  levelId: string,
  input: { skillId: string; minLevel: SkillLevel },
) =>
  apiFetch<{ id: string }>(`/career-levels/${levelId}/skills`, {
    method: 'POST',
    body: input,
  });

export const removeLevelSkill = (id: string) =>
  apiFetch<void>(`/career-level-skills/${id}`, { method: 'DELETE' });

export const archiveLadder = (id: string) =>
  apiFetch<{ ok: true }>(`/career-ladders/${id}/archive`, {
    method: 'POST',
    body: {},
  });

/* ----- Where someone stands ---------------------------------------------- */

export interface CareerRequirement {
  kind: 'skill' | 'certification' | 'tenure' | 'review';
  label: string;
  met: boolean;
  have: SkillLevel | number | null;
  need: SkillLevel | number | null;
}

export interface CareerPosition {
  ladder: { id: string; name: string; family: string | null; levels: Array<{ id: string; rank: number; title: string; description: string | null }> } | null;
  currentLevelId: string | null;
  placedBy: 'job_profile' | 'role' | 'field' | null;
  next: { id: string; rank: number; title: string; requirements: CareerRequirement[]; progressPct: number } | null;
  otherLadders: Array<{ id: string; name: string }>;
}

export const getMyCareerPosition = () => apiFetch<CareerPosition>('/career-ladders/me/position');
export const getCareerPosition = (associateId: string) => apiFetch<CareerPosition>(`/career-ladders/people/${associateId}/position`);
export const createFieldLeadershipLadder = () =>
  apiFetch<{ id: string }>('/career-ladders/templates/field-leadership', { method: 'POST' });
