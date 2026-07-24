import { apiFetch } from './api';

/** One associate whose stored W-4 SSN no longer decrypts. */
export interface W4RecollectionRow {
  associateId: string;
  firstName: string;
  lastName: string;
  email: string | null;
  /** False = no ACTIVE login, so an email can't lead anywhere — re-invite first. */
  hasAccount: boolean;
  applicationId: string | null;
  hireDate: string | null;
  w4SubmittedAt: string | null;
  ssnLast4: string | null;
  /** An SSN card / I-9 doc image is on file — an admin can re-key from it. */
  hasSsnDocument: boolean;
  emailCount: number;
  lastEmailedAt: string | null;
}

export interface W4RecollectionSummary {
  outstanding: number;
  notified: number;
  resolved: number;
}

export interface W4RecollectionStatus {
  rows: W4RecollectionRow[];
  summary: W4RecollectionSummary;
}

export const getW4Recollection = () =>
  apiFetch<W4RecollectionStatus>('/w4-recollection');

export const getW4RecollectionSummary = () =>
  apiFetch<W4RecollectionSummary>('/w4-recollection/summary');

export interface W4RecollectionEmailResult {
  queued: number;
  skipped: {
    associateId: string;
    reason: 'not_affected' | 'no_account' | 'no_application';
  }[];
}

export const emailW4Recollection = (associateIds: string[]) =>
  apiFetch<W4RecollectionEmailResult>('/w4-recollection/email', {
    method: 'POST',
    body: { associateIds },
  });
