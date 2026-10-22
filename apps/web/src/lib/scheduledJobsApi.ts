import { apiFetch } from './api';

/** One scheduled job as the API's registry sees it (apps/api/src/lib/jobs.ts). */
export interface ScheduledJob {
  name: string;
  label: string;
  intervalSeconds: number;
  armed: boolean;
  running: boolean;
  runs: number;
  failures: number;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastOkAt: string | null;
  lastDurationMs: number | null;
  lastError: string | null;
  nextRunAt: string | null;
  note: string | null;
}

export const listScheduledJobs = () => apiFetch<{ jobs: ScheduledJob[]; now: string }>('/admin/jobs');

export const runScheduledJob = (name: string) =>
  apiFetch<{ job: ScheduledJob }>(`/admin/jobs/${encodeURIComponent(name)}/run`, { method: 'POST' });

/** "every 30 min", "hourly", "daily" — the interval as a person says it. */
export function everyPhrase(seconds: number): string {
  if (seconds <= 0) return 'Off';
  if (seconds % 86_400 === 0) return seconds === 86_400 ? 'Daily' : `Every ${seconds / 86_400} days`;
  if (seconds % 3600 === 0) return seconds === 3600 ? 'Hourly' : `Every ${seconds / 3600} h`;
  if (seconds % 60 === 0) return `Every ${seconds / 60} min`;
  return `Every ${seconds} s`;
}
