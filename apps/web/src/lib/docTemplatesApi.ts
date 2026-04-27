import { apiFetch } from './api';

export type DocumentTemplateKind =
  | 'OFFER_LETTER'
  | 'POLICY'
  | 'NDA'
  | 'PROMOTION_LETTER'
  | 'TERMINATION_LETTER'
  | 'WARNING_LETTER'
  | 'GENERIC';

export interface DocumentTemplate {
  id: string;
  clientId: string | null;
  name: string;
  kind: DocumentTemplateKind;
  currentVersion: number | null;
  currentVersionId: string | null;
  versionCount: number;
  renderCount: number;
  updatedAt: string;
}

export interface DocumentTemplateVersion {
  id: string;
  version: number;
  subject: string | null;
  body: string;
  variables: unknown;
  publishedAt: string | null;
}

export const listTemplates = (clientId?: string) =>
  apiFetch<{ templates: DocumentTemplate[] }>(
    clientId ? `/document-templates?clientId=${clientId}` : '/document-templates',
  );

export const createTemplate = (input: {
  clientId?: string | null;
  name: string;
  kind?: DocumentTemplateKind;
}) => apiFetch<{ id: string }>('/document-templates', { method: 'POST', body: input });

export const deleteTemplate = (id: string) =>
  apiFetch<void>(`/document-templates/${id}`, { method: 'DELETE' });

export const listVersions = (templateId: string) =>
  apiFetch<{ versions: DocumentTemplateVersion[] }>(
    `/document-templates/${templateId}/versions`,
  );

export const saveVersion = (
  templateId: string,
  input: { subject?: string | null; body: string; variables?: Record<string, unknown> },
) =>
  apiFetch<{ id: string; version: number }>(
    `/document-templates/${templateId}/versions`,
    { method: 'POST', body: input },
  );

export const publishVersion = (templateId: string, versionId: string) =>
  apiFetch<{ ok: true }>(
    `/document-templates/${templateId}/versions/${versionId}/publish`,
    { method: 'POST', body: {} },
  );

export const renderTemplate = (
  templateId: string,
  input: {
    associateId?: string | null;
    versionId?: string;
    data?: Record<string, unknown>;
  },
) =>
  apiFetch<{ id: string; renderedSubject: string | null; renderedBody: string }>(
    `/document-templates/${templateId}/render`,
    { method: 'POST', body: input },
  );

export const listRenders = (templateId: string) =>
  apiFetch<{
    renders: Array<{
      id: string;
      version: number;
      associateName: string | null;
      renderedSubject: string | null;
      createdAt: string;
    }>;
  }>(`/document-templates/${templateId}/renders`);
