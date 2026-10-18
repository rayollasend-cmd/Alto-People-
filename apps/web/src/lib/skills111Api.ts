import { apiFetch } from './api';

export type SkillLevel = 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED' | 'EXPERT';

export interface SkillCatalogEntry {
  id: string;
  name: string;
  category: string | null;
  associateCount: number;
}

export interface AssociateSkillEntry {
  id: string;
  skillId: string;
  skillName: string;
  category: string | null;
  level: SkillLevel;
  yearsExperience: number | null;
  notes: string | null;
  verifiedAt: string | null;
  verifiedByEmail: string | null;
}

export interface SkillSearchResult {
  skills: { id: string; name: string }[];
  associates: {
    associateId: string;
    name: string;
    email: string;
    skillName: string;
    level: SkillLevel;
    yearsExperience: number | null;
    verified: boolean;
    /** Where they work now. */
    place?: { locationId: string; siteName: string; clientName: string | null } | null;
    /** The next day in the coming two weeks with no shift and no approved leave. */
    nextFreeDay?: string | null;
    /** Current certifications and qualifications — one competency view. */
    certifications?: { name: string; isCert: boolean; expiresAt: string | null }[];
  }[];
}

export const listSkills = (q?: string) =>
  apiFetch<{ skills: SkillCatalogEntry[] }>(
    `/skills${q ? `?q=${encodeURIComponent(q)}` : ''}`,
  );

export const createSkill = (input: { name: string; category?: string | null }) =>
  apiFetch<{ id: string }>('/skills', { method: 'POST', body: input });

export const deleteSkill = (id: string) =>
  apiFetch<void>(`/skills/${id}`, { method: 'DELETE' });

export const claimAssociateSkill = (input: {
  associateId: string;
  skillId: string;
  level: SkillLevel;
  yearsExperience?: number | null;
  notes?: string | null;
}) =>
  apiFetch<{ id: string }>('/associate-skills', {
    method: 'POST',
    body: input,
  });

export const verifyAssociateSkill = (id: string) =>
  apiFetch<{ ok: true }>(`/associate-skills/${id}/verify`, {
    method: 'POST',
    body: {},
  });

export const deleteAssociateSkill = (id: string) =>
  apiFetch<void>(`/associate-skills/${id}`, { method: 'DELETE' });

export const listAssociateSkills = (associateId: string) =>
  apiFetch<{ skills: AssociateSkillEntry[] }>(
    `/associate-skills?associateId=${associateId}`,
  );

export const searchSkills = (q: string, minLevel?: SkillLevel, where: { clientId?: string; locationId?: string } = {}) => {
  const qs = new URLSearchParams({ q });
  if (minLevel) qs.set('minLevel', minLevel);
  if (where.clientId) qs.set('clientId', where.clientId);
  if (where.locationId) qs.set('locationId', where.locationId);
  return apiFetch<SkillSearchResult>(`/skills/search?${qs.toString()}`);
};
