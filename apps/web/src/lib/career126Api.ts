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
