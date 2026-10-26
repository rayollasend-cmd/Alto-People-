import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Play, Timer } from '@/components/ui/icons';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { everyPhrase, listScheduledJobs, runScheduledJob, type ScheduledJob } from '@/lib/scheduledJobsApi';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { DataGrid } from '@/components/ui/DataGrid';
import { EmptyState } from '@/components/ui/EmptyState';
import { QueryError } from '@/components/ui/QueryError';
import { Skeleton } from '@/components/ui/Skeleton';

function stateOf(j: ScheduledJob): { label: string; variant: 'success' | 'destructive' | 'pending' | 'outline' | 'info' } {
  if (!j.armed) return { label: 'Off', variant: 'outline' };
  if (j.running) return { label: 'Running', variant: 'info' };
  if (j.lastError) return { label: 'Last run failed', variant: 'destructive' };
  if (j.runs === 0) return { label: 'Waiting for first run', variant: 'pending' };
  return { label: 'OK', variant: 'success' };
}

/** A job named for what it delivers ("Schedule digest to admins (daily)") checks more often than it sends. */
const DELIVERS = /\s*\((daily|nightly|weekly)\)\s*$/i;

/** The job's name without its delivery note, which the Runs column says instead. */
export function jobName(label: string): string {
  return label.replace(DELIVERS, '');
}

/**
 * How often a job runs, as a person says it — and, for one that checks
 * often but sends once a day, both: "Checks every 15 min, sends daily"
 * rather than an "Every 15 min" beside a name that says daily (F500
 * 2026-10-26).
 */
export function runsPhrase(j: Pick<ScheduledJob, 'label' | 'intervalSeconds'>): string {
  const every = everyPhrase(j.intervalSeconds);
  const m = DELIVERS.exec(j.label);
  if (!m || j.intervalSeconds <= 0) return every;
  const sends = m[1]!.toLowerCase();
  const period = sends === 'weekly' ? 7 * 86_400 : 86_400;
  if (j.intervalSeconds >= period) return sends.charAt(0).toUpperCase() + sends.slice(1);
  return `Checks ${every.charAt(0).toLowerCase()}${every.slice(1)}, sends ${sends}`;
}

/**
 * The scheduled jobs the API runs: when each last ran, whether it failed,
 * when it runs next. A job set to 0 shows as Off — the audit of 2026-10-21
 * found four crons quietly off for months with nothing to show it.
 */
export function ScheduledJobsCard({ canRun }: { canRun: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['reliability', 'jobs'], queryFn: listScheduledJobs, refetchInterval: 60_000 });
  const run = useMutation({
    mutationFn: (name: string) => runScheduledJob(name),
    onSuccess: async (r) => {
      if (r.job.lastError) toast.error(`${jobName(r.job.label)} failed: ${r.job.lastError}`);
      else toast.success(`${jobName(r.job.label)} ran.`);
      await qc.invalidateQueries({ queryKey: ['reliability', 'jobs'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not run the job.'),
  });
  const jobs = q.data?.jobs ?? [];
  const off = jobs.filter((j) => !j.armed).length;
  const failing = jobs.filter((j) => j.armed && j.lastError).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Timer className="h-4 w-4 text-gold" aria-hidden="true" />
          Scheduled jobs
        </CardTitle>
        <CardDescription>
          Reminders, digests, maintenance and checks the API runs on a timer — when each last ran and when it runs next.
          {jobs.length > 0 && (failing > 0 || off > 0) && ` ${failing > 0 ? `${failing} failing. ` : ''}${off > 0 ? `${off} off.` : ''}`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {q.isError ? (
          <QueryError what="scheduled jobs" query={q} />
        ) : q.isLoading ? (
          <Skeleton className="h-24" />
        ) : jobs.length === 0 ? (
          <EmptyState icon={Timer} title="No scheduled jobs registered" description="The API registers its jobs when it starts; none have reported yet." />
        ) : (
          <DataGrid<ScheduledJob>
            id="reliability-scheduled-jobs"
            caption="Scheduled jobs with last and next run"
            rows={jobs}
            rowKey={(j) => j.name}
            search={false}
            urlState={false}
            columnChooser={false}
            columns={[
              {
                key: 'label',
                header: 'Job',
                accessor: (j) => jobName(j.label),
                sortable: true,
                primary: true,
                cell: (j) => (
                  <span className="block min-w-0">
                    <span className="font-medium text-ink">{jobName(j.label)}</span>
                    {j.lastError && <span className="block text-2xs text-alert">{j.lastError}</span>}
                  </span>
                ),
              },
              { key: 'state', header: 'State', accessor: (j) => stateOf(j).label, sortable: true, cardMeta: true, cell: (j) => <Badge variant={stateOf(j).variant}>{stateOf(j).label}</Badge> },
              { key: 'every', header: 'Runs', accessor: (j) => j.intervalSeconds, sortable: true, searchable: false, cell: (j) => runsPhrase(j) },
              { key: 'last', header: 'Last run', accessor: (j) => j.lastFinishedAt ?? '', sortable: true, searchable: false, cardMeta: true, cell: (j) => (j.lastFinishedAt ? fmtDateTime(j.lastFinishedAt) : '—') },
              { key: 'next', header: 'Next run', accessor: (j) => j.nextRunAt ?? '', sortable: true, searchable: false, cell: (j) => (j.nextRunAt ? fmtDateTime(j.nextRunAt) : '—') },
              {
                key: 'run',
                header: 'Action',
                accessor: () => null,
                searchable: false,
                align: 'right',
                stopRowClick: true,
                cell: (j) =>
                  canRun ? (
                    <Button size="sm" variant="ghost" loading={run.isPending && run.variables === j.name} disabled={run.isPending || j.running} onClick={() => run.mutate(j.name)} aria-label={`Run ${jobName(j.label)} now`}>
                      <Play className="mr-1 h-3 w-3" aria-hidden="true" /> Run now
                    </Button>
                  ) : null,
              },
            ]}
          />
        )}
      </CardContent>
    </Card>
  );
}
