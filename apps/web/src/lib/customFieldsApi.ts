import { apiFetch } from './api';

export type CustomFieldType =
  | 'TEXT'
  | 'NUMBER'
  | 'DATE'
  | 'BOOLEAN'
  | 'SELECT'
  | 'MULTISELECT';

export type CustomFieldEntity = 'ASSOCIATE' | 'POSITION' | 'CLIENT';

export interface CustomFieldDefinition {
  id: string;
  clientId: string | null;
  entityType: CustomFieldEntity;
  key: string;
  label: string;
  type: CustomFieldType;
  isRequired: boolean;
  isSensitive: boolean;
  helpText: string | null;
  options: string[] | null;
  displayOrder: number;
}

export interface CustomFieldValueRow {
  definitionId: string;
  key: string;
  label: string;
  type: CustomFieldType;
  value: { v: unknown } | null;
}

export interface CustomFieldDefinitionInput {
  clientId?: string | null;
  entityType: CustomFieldEntity;
  key: string;
  label: string;
  type: CustomFieldType;
  isRequired?: boolean;
  isSensitive?: boolean;
  helpText?: string | null;
  options?: string[] | null;
  displayOrder?: number;
}

export function listDefinitions(filters: {
  clientId?: string;
  entityType?: CustomFieldEntity;
} = {}): Promise<{ definitions: CustomFieldDefinition[] }> {
  const sp = new URLSearchParams();
  if (filters.clientId) sp.set('clientId', filters.clientId);
  if (filters.entityType) sp.set('entityType', filters.entityType);
  const qs = sp.toString();
  return apiFetch(`/custom-fields/definitions${qs ? `?${qs}` : ''}`);
}

export function createDefinition(
  input: CustomFieldDefinitionInput,
): Promise<{ id: string }> {
  return apiFetch('/custom-fields/definitions', {
    method: 'POST',
    body: input,
  });
}

export function updateDefinition(
  id: string,
  input: Partial<CustomFieldDefinitionInput>,
): Promise<{ id: string }> {
  return apiFetch(`/custom-fields/definitions/${id}`, {
    method: 'PUT',
    body: input,
  });
}

export function deleteDefinition(id: string): Promise<void> {
  return apiFetch(`/custom-fields/definitions/${id}`, { method: 'DELETE' });
}

export function listValues(
  entityType: CustomFieldEntity,
  entityId: string,
): Promise<{ values: CustomFieldValueRow[] }> {
  return apiFetch(`/custom-fields/values/${entityType}/${entityId}`);
}

export function setValues(
  entityType: CustomFieldEntity,
  entityId: string,
  values: { definitionId: string; value: unknown }[],
): Promise<{ ok: true }> {
  return apiFetch(`/custom-fields/values/${entityType}/${entityId}`, {
    method: 'PUT',
    body: { values },
  });
}
