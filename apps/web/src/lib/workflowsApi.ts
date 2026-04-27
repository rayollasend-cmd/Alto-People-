import { apiFetch } from './api';

export type WorkflowTrigger =
  | 'ASSOCIATE_HIRED'
  | 'ASSOCIATE_TERMINATED'
  | 'TIME_OFF_REQUESTED'
  | 'TIME_OFF_APPROVED'
  | 'TIME_OFF_DENIED'
  | 'POSITION_OPENED'
  | 'POSITION_FILLED'
  | 'PAYROLL_FINALIZED'
  | 'ONBOARDING_COMPLETED'
  | 'COMPLIANCE_EXPIRING';

export type WorkflowActionKind =
  | 'SEND_NOTIFICATION'
  | 'SET_FIELD'
  | 'ASSIGN_TASK'
  | 'CREATE_AUDIT_LOG'
  | 'WEBHOOK';

export interface WorkflowAction {
  kind: WorkflowActionKind;
  params: Record<string, unknown>;
}

export interface WorkflowDefinition {
  id: string;
  clientId: string | null;
  name: string;
  description: string | null;
  trigger: WorkflowTrigger;
  conditions: Record<string, unknown>;
  actions: WorkflowAction[];
  isActive: boolean;
  runCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowRunSummary {
  id: string;
  definitionId: string;
  definitionName: string;
  trigger: WorkflowTrigger;
  entityType: string;
  entityId: string;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  startedAt: string | null;
  completedAt: string | null;
  failureReason: string | null;
  stepCount: number;
  stepsCompleted: number;
  stepsFailed: number;
}

export interface WorkflowDefinitionInput {
  clientId?: string | null;
  name: string;
  description?: string | null;
  trigger: WorkflowTrigger;
  conditions?: Record<string, unknown>;
  actions: WorkflowAction[];
  isActive?: boolean;
}

export function listWorkflows(filters: {
  clientId?: string;
  trigger?: WorkflowTrigger;
} = {}): Promise<{ definitions: WorkflowDefinition[] }> {
  const sp = new URLSearchParams();
  if (filters.clientId) sp.set('clientId', filters.clientId);
  if (filters.trigger) sp.set('trigger', filters.trigger);
  const qs = sp.toString();
  return apiFetch(`/workflows${qs ? `?${qs}` : ''}`);
}

export function createWorkflow(input: WorkflowDefinitionInput): Promise<{
  id: string;
  name: string;
  trigger: WorkflowTrigger;
  isActive: boolean;
}> {
  return apiFetch('/workflows', { method: 'POST', body: input });
}

export function updateWorkflow(
  id: string,
  input: Partial<WorkflowDefinitionInput>,
): Promise<{ id: string; name: string; isActive: boolean }> {
  return apiFetch(`/workflows/${id}`, { method: 'PUT', body: input });
}

export function deleteWorkflow(id: string): Promise<void> {
  return apiFetch(`/workflows/${id}`, { method: 'DELETE' });
}

export function listRuns(filters: {
  definitionId?: string;
  status?: WorkflowRunSummary['status'];
} = {}): Promise<{ runs: WorkflowRunSummary[] }> {
  const sp = new URLSearchParams();
  if (filters.definitionId) sp.set('definitionId', filters.definitionId);
  if (filters.status) sp.set('status', filters.status);
  const qs = sp.toString();
  return apiFetch(`/workflows/runs${qs ? `?${qs}` : ''}`);
}

export function testWorkflow(
  id: string,
  context: Record<string, unknown>,
): Promise<{ runs: string[] }> {
  return apiFetch(`/workflows/${id}/test`, {
    method: 'POST',
    body: { context },
  });
}
