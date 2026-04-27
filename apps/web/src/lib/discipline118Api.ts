import { apiFetch } from './api';

export type DisciplineKind =
  | 'VERBAL_WARNING'
  | 'WRITTEN_WARNING'
  | 'FINAL_WARNING'
  | 'SUSPENSION'
  | 'TERMINATION';

export type DisciplineStatus = 'ACTIVE' | 'ACKNOWLEDGED' | 'RESCINDED';

export interface DisciplinaryActionRow {
  id: string;
  associateId: string;
  associateName: string;
  associateEmail: string;
  kind: DisciplineKind;
  status: DisciplineStatus;
  incidentDate: string;
  effectiveDate: string;
  suspensionDays: number | null;
  description: string;
  expectedAction: string | null;
  issuedByEmail: string | null;
  acknowledgedAt: string | null;
  acknowledgedSig: string | null;
  rescindedAt: string | null;
  rescindedReason: string | null;
  rescindedByEmail: string | null;
}

export interface LadderRollup {
  associateId: string;
  ladder: Record<DisciplineKind, number>;
}

export const listDisciplinaryActions = (params: {
  associateId?: string;
  status?: DisciplineStatus;
  kind?: DisciplineKind;
}) => {
  const q = new URLSearchParams();
  if (params.associateId) q.set('associateId', params.associateId);
  if (params.status) q.set('status', params.status);
  if (params.kind) q.set('kind', params.kind);
  const qs = q.toString();
  return apiFetch<{ actions: DisciplinaryActionRow[] }>(
    `/disciplinary-actions${qs ? `?${qs}` : ''}`,
  );
};

export const getLadder = (associateId: string) =>
  apiFetch<LadderRollup>(`/disciplinary-actions/ladder/${associateId}`);

export const issueDisciplinaryAction = (input: {
  associateId: string;
  kind: DisciplineKind;
  incidentDate: string;
  effectiveDate: string;
  suspensionDays?: number | null;
  description: string;
  expectedAction?: string | null;
}) =>
  apiFetch<{ id: string }>('/disciplinary-actions', {
    method: 'POST',
    body: input,
  });

export const acknowledgeDisciplinaryAction = (
  id: string,
  signature: string,
) =>
  apiFetch<{ ok: true }>(`/disciplinary-actions/${id}/acknowledge`, {
    method: 'POST',
    body: { signature },
  });

export const rescindDisciplinaryAction = (id: string, reason: string) =>
  apiFetch<{ ok: true }>(`/disciplinary-actions/${id}/rescind`, {
    method: 'POST',
    body: { reason },
  });

export const KIND_LABELS: Record<DisciplineKind, string> = {
  VERBAL_WARNING: 'Verbal warning',
  WRITTEN_WARNING: 'Written warning',
  FINAL_WARNING: 'Final warning',
  SUSPENSION: 'Suspension',
  TERMINATION: 'Termination',
};
