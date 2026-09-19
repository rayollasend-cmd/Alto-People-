import { apiFetch } from '@/lib/api';
import type { DeskPerson } from './relayTypes';

/**
 * The workstation: what one desk sends another, and the work documents
 * they keep. Four desks here — Recruiting joins the board's three, because
 * "send this to IR" is half the traffic between buildings.
 */

export type WorkDesk = 'HR' | 'RECRUITING' | 'WORKFORCE' | 'FINANCE';
export const WORK_DESKS: WorkDesk[] = ['HR', 'RECRUITING', 'WORKFORCE', 'FINANCE'];

export const WORK_DESK_LABELS: Record<WorkDesk, string> = {
  HR: 'HR',
  RECRUITING: 'Recruiting',
  WORKFORCE: 'Workforce',
  FINANCE: 'Finance',
};

export const WORK_DESK_CHIP: Record<WorkDesk, string> = {
  HR: 'bg-steel/20 text-sky',
  RECRUITING: 'bg-teal/15 text-teal',
  WORKFORCE: 'bg-success/15 text-success',
  FINANCE: 'bg-gold/15 text-gold',
};

/** What the request is: a question, something handed over, work to do. */
export type RequestKind = 'ASK' | 'SEND' | 'TASK';
export type RequestStatus = 'OPEN' | 'IN_PROGRESS' | 'ANSWERED' | 'CLOSED';

export const KIND_LABELS: Record<RequestKind, string> = {
  ASK: 'Question',
  SEND: 'Sent over',
  TASK: 'Task',
};

export const STATUS_LABELS: Record<RequestStatus, string> = {
  OPEN: 'Open',
  IN_PROGRESS: 'Being worked',
  ANSWERED: 'Answered',
  CLOSED: 'Closed',
};

export interface WorkPerson {
  userId: string;
  name: string;
  photoUrl: string | null;
  desk?: WorkDesk | null;
}

export interface WorkFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  createdAt: string;
  uploadedBy: WorkPerson | null;
  /** The shelf it sits on: one desk's, or everyone's when null. */
  desk: WorkDesk | null;
  tags: string[];
  about: { associateId: string; name: string } | null;
  requestId: string | null;
  /** Where to read it. */
  url: string;
}

export interface WorkMessage {
  id: string;
  body: string;
  createdAt: string;
  author: WorkPerson | null;
  files: WorkFile[];
}

export interface WorkRequest {
  id: string;
  kind: RequestKind;
  status: RequestStatus;
  subject: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  dueAt: string | null;
  answeredAt: string | null;
  from: WorkPerson | null;
  toDesk: WorkDesk;
  toUser: WorkPerson | null;
  claimedBy: WorkPerson | null;
  about: { associateId: string; name: string } | null;
  files: WorkFile[];
  messages?: WorkMessage[];
  replies: number;
  /** Waiting on the viewer — their desk, or handed to them. */
  mine: boolean;
}

export interface RequestCounts {
  inbox: number;
  sent: number;
  unanswered: number;
}

export const workApi = {
  requests: (box: 'inbox' | 'sent' | 'all', status: 'open' | 'all' = 'open') =>
    apiFetch<{ requests: WorkRequest[]; counts: RequestCounts }>(`/relay/requests?box=${box}&status=${status}`),
  request: (id: string) => apiFetch<{ request: WorkRequest }>(`/relay/requests/${id}`),
  create: (body: {
    kind: RequestKind;
    toDesk: WorkDesk;
    toUserId?: string;
    subject: string;
    body: string;
    dueAt?: string;
    aboutAssociateId?: string;
    fileIds?: string[];
  }) => apiFetch<{ request: WorkRequest }>('/relay/requests', { method: 'POST', body }),
  reply: (id: string, body: { body: string; fileIds?: string[] }) =>
    apiFetch<{ message: WorkMessage }>(`/relay/requests/${id}/messages`, { method: 'POST', body }),
  update: (id: string, body: { status?: RequestStatus; claim?: boolean }) =>
    apiFetch<{ request: WorkRequest }>(`/relay/requests/${id}`, { method: 'PATCH', body }),
  files: (q: { scope?: 'mine' | 'desk' | 'all'; q?: string; tag?: string } = {}) => {
    const p = new URLSearchParams();
    if (q.scope) p.set('scope', q.scope);
    if (q.q) p.set('q', q.q);
    if (q.tag) p.set('tag', q.tag);
    return apiFetch<{ files: WorkFile[]; tags: string[] }>(`/relay/files${p.size ? `?${p.toString()}` : ''}`);
  },
  remove: (id: string) => apiFetch<{ ok: true }>(`/relay/files/${id}`, { method: 'DELETE' }),
};

/** Upload a work document — multipart, so it goes around apiFetch. */
export async function uploadWorkFile(
  file: File,
  opts: { desk?: WorkDesk | null; tags?: string[]; aboutAssociateId?: string } = {},
): Promise<WorkFile> {
  const form = new FormData();
  form.append('file', file);
  if (opts.desk) form.append('desk', opts.desk);
  if (opts.tags?.length) form.append('tags', opts.tags.join(','));
  if (opts.aboutAssociateId) form.append('aboutAssociateId', opts.aboutAssociateId);
  const res = await fetch('/api/relay/files', { method: 'POST', credentials: 'include', body: form });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? `Upload failed (${res.status})`);
  }
  return ((await res.json()) as { file: WorkFile }).file;
}

/** "3.4 MB" */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/** Which desk a role answers for in the workstation. */
export function workDeskOf(role: string | undefined | null): WorkDesk | null {
  if (role === 'FINANCE_ACCOUNTANT') return 'FINANCE';
  if (role === 'WORKFORCE_MANAGER') return 'WORKFORCE';
  if (role === 'INTERNAL_RECRUITER') return 'RECRUITING';
  if (role === 'HR_ADMINISTRATOR' || role === 'OPERATIONS_MANAGER') return 'HR';
  return null;
}

export type { DeskPerson };
