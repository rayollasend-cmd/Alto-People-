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
  /** The employee's own side, written under the notice (F500 G5). Absent from an older server. */
  employeeResponse?: string | null;
  employeeRespondedAt?: string | null;
}

export interface LadderRollup {
  associateId: string;
  ladder: Record<DisciplineKind, number>;
}

export const listDisciplinaryActions = (params: {
  associateId?: string;
  status?: DisciplineStatus;
  /** Every action not rescinded (awaiting acknowledgment or acknowledged). */
  state?: 'in-force';
  kind?: DisciplineKind;
}) => {
  const q = new URLSearchParams();
  if (params.associateId) q.set('associateId', params.associateId);
  if (params.status) q.set('status', params.status);
  if (params.state) q.set('state', params.state);
  if (params.kind) q.set('kind', params.kind);
  const qs = q.toString();
  return apiFetch<{ actions: DisciplinaryActionRow[]; total?: number }>(
    `/disciplinary-actions${qs ? `?${qs}` : ''}`,
  );
};

/** GET /disciplinary-actions/summary — the log's numbers, same reach as the list. */
export interface DisciplineSummary {
  /** Not rescinded: awaiting acknowledgment or acknowledged. */
  inForce: number;
  awaitingAck: number;
  /** People holding a final warning in force — one step from termination. */
  finalWarningPeople: number;
  issued90d: number;
}
export const getDisciplineSummary = () => apiFetch<DisciplineSummary>('/disciplinary-actions/summary');

export const getLadder = (associateId: string) =>
  apiFetch<LadderRollup>(`/disciplinary-actions/ladder/${associateId}`);

/** The subject's own actions — the self-scoped route that makes the
 *  acknowledgment flow reachable without view:hr-admin. */
export interface MyDisciplinaryAction {
  id: string;
  associateName: string;
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
  employeeResponse?: string | null;
  employeeRespondedAt?: string | null;
}

/** The employee's written response under a notice — acknowledging is not agreeing (F500 G5). */
export const respondToDisciplinaryAction = (id: string, text: string) =>
  apiFetch<{ ok: true; employeeRespondedAt: string }>(`/disciplinary-actions/${id}/response`, {
    method: 'POST',
    body: { text },
  });

export const listMyDisciplinaryActions = () =>
  apiFetch<{ actions: MyDisciplinaryAction[] }>('/disciplinary-actions/me');

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
