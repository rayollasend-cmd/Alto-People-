import { apiFetch } from './api';

export type KbStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';

export interface KbArticleSummary {
  id: string;
  slug: string;
  title: string;
  category: string;
  tags: string[];
  views: number;
  helpful: number;
  notHelpful: number;
  publishedAt: string | null;
}

export interface KbArticleDetail extends KbArticleSummary {
  body: string;
  myVote: { helpful: boolean } | null;
}

export interface KbAdminRow extends KbArticleSummary {
  status: KbStatus;
  clientName: string | null;
  authorEmail: string | null;
  updatedAt: string;
}

export interface KbCategoryRow {
  category: string;
  count: number;
}

export const searchKb = (params: {
  q?: string;
  category?: string;
  tag?: string;
}) => {
  const qs = new URLSearchParams();
  if (params.q) qs.set('q', params.q);
  if (params.category) qs.set('category', params.category);
  if (params.tag) qs.set('tag', params.tag);
  const s = qs.toString();
  return apiFetch<{ articles: KbArticleSummary[] }>(
    `/kb/articles${s ? `?${s}` : ''}`,
  );
};

export const getKbCategories = () =>
  apiFetch<{ categories: KbCategoryRow[] }>('/kb/categories');

export const getKbArticle = (slug: string) =>
  apiFetch<KbArticleDetail>(`/kb/articles/${slug}`);

export const voteKbArticle = (
  id: string,
  helpful: boolean,
  comment?: string | null,
) =>
  apiFetch<{ ok: true }>(`/kb/articles/${id}/feedback`, {
    method: 'POST',
    body: { helpful, comment: comment ?? null },
  });

export const adminListKb = (status?: KbStatus) =>
  apiFetch<{ articles: KbAdminRow[] }>(
    `/kb/admin/articles${status ? `?status=${status}` : ''}`,
  );

export const createKbArticle = (input: {
  clientId?: string | null;
  title: string;
  slug: string;
  body: string;
  category: string;
  tags: string[];
}) => apiFetch<{ id: string }>('/kb/articles', { method: 'POST', body: input });

export const updateKbArticle = (
  id: string,
  input: Partial<{
    title: string;
    body: string;
    category: string;
    tags: string[];
  }>,
) =>
  apiFetch<{ ok: true }>(`/kb/articles/${id}`, { method: 'PATCH', body: input });

export const publishKbArticle = (id: string) =>
  apiFetch<{ ok: true }>(`/kb/articles/${id}/publish`, {
    method: 'POST',
    body: {},
  });

export const archiveKbArticle = (id: string) =>
  apiFetch<{ ok: true }>(`/kb/articles/${id}/archive`, {
    method: 'POST',
    body: {},
  });

export const deleteKbArticle = (id: string) =>
  apiFetch<void>(`/kb/articles/${id}`, { method: 'DELETE' });
