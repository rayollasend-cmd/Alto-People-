/**
 * The scheduled-jobs registry.
 *
 * The audit of 2026-10-21 found four crons (shift reminders, the schedule
 * digest, the week-ahead digest, kiosk maintenance) defaulting to off and
 * set nowhere — and nothing that could show an admin whether a job had
 * ever run. A job armed through here records every tick: when it last ran,
 * whether it failed and why, how long it took, and when it runs next. The
 * admin "Scheduled jobs" panel (GET /admin/jobs, the Reliability page)
 * reads listJobs(); a job whose interval is 0 is listed as off, so a
 * silent default can be seen instead of guessed at.
 *
 * armJob is the one-line replacement for the setInterval + console.log
 * block each start*Cron used to carry; the stop* functions keep working
 * through stopJob. Timers are unref'd so they never hold a test process
 * open, and a tick that is still running when the next one fires is
 * skipped, not stacked.
 */

export interface JobDefinition {
  /** Stable key, e.g. 'shiftReminder'. */
  name: string;
  /** What an admin reads: "Shift reminders (day before)". */
  label: string;
  /** Seconds between ticks; 0 arms nothing and lists the job as off. */
  intervalSeconds: number;
  /** The tick. Its rejection is recorded as the job's last error. */
  run: () => Promise<unknown> | unknown;
  /** Run once right away as well (default true). */
  immediate?: boolean;
  /** One line on why it is off / what it does, for the panel. */
  note?: string;
}

export interface JobStatus {
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

interface JobRecord {
  def: JobDefinition;
  timer: NodeJS.Timeout | null;
  running: boolean;
  runs: number;
  failures: number;
  lastStartedAt: Date | null;
  lastFinishedAt: Date | null;
  lastOkAt: Date | null;
  lastDurationMs: number | null;
  lastError: string | null;
  nextRunAt: Date | null;
}

const jobs = new Map<string, JobRecord>();

async function tick(rec: JobRecord): Promise<void> {
  if (rec.running) return; // the previous tick is still going; do not stack
  rec.running = true;
  rec.lastStartedAt = new Date();
  const t0 = Date.now();
  try {
    await rec.def.run();
    rec.lastError = null;
    rec.lastOkAt = new Date();
  } catch (err) {
    rec.failures += 1;
    rec.lastError = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    console.error(`[alto-people/api] job ${rec.def.name} failed:`, err);
  } finally {
    rec.runs += 1;
    rec.running = false;
    rec.lastFinishedAt = new Date();
    rec.lastDurationMs = Date.now() - t0;
    if (rec.timer) rec.nextRunAt = new Date(Date.now() + rec.def.intervalSeconds * 1000);
  }
}

/**
 * Register and arm a job. Returns true when a timer was set, false when
 * the interval is 0 (the job is still listed, as off). Arming the same
 * name twice is a no-op, like the start*Cron guards it replaces.
 */
export function armJob(def: JobDefinition): boolean {
  const existing = jobs.get(def.name);
  if (existing?.timer) return true;
  const rec: JobRecord = existing ?? {
    def,
    timer: null,
    running: false,
    runs: 0,
    failures: 0,
    lastStartedAt: null,
    lastFinishedAt: null,
    lastOkAt: null,
    lastDurationMs: null,
    lastError: null,
    nextRunAt: null,
  };
  rec.def = def;
  jobs.set(def.name, rec);
  if (def.intervalSeconds <= 0) {
    rec.nextRunAt = null;
    return false;
  }
  rec.timer = setInterval(() => void tick(rec), def.intervalSeconds * 1000);
  rec.timer.unref();
  rec.nextRunAt = new Date(Date.now() + def.intervalSeconds * 1000);
  if (def.immediate !== false) void tick(rec);
  console.log(`[alto-people/api] ${def.label} armed (every ${def.intervalSeconds}s)`);
  return true;
}

/** Clear the timer; the job stays listed (as off) with its history. */
export function stopJob(name: string): void {
  const rec = jobs.get(name);
  if (!rec?.timer) return;
  clearInterval(rec.timer);
  rec.timer = null;
  rec.nextRunAt = null;
}

export function isJobArmed(name: string): boolean {
  return !!jobs.get(name)?.timer;
}

/** Run one job's tick now (the admin "Run now" button and tests). */
export async function runJobNow(name: string): Promise<JobStatus | null> {
  const rec = jobs.get(name);
  if (!rec) return null;
  await tick(rec);
  return statusOf(rec);
}

function statusOf(rec: JobRecord): JobStatus {
  return {
    name: rec.def.name,
    label: rec.def.label,
    intervalSeconds: rec.def.intervalSeconds,
    armed: !!rec.timer,
    running: rec.running,
    runs: rec.runs,
    failures: rec.failures,
    lastStartedAt: rec.lastStartedAt?.toISOString() ?? null,
    lastFinishedAt: rec.lastFinishedAt?.toISOString() ?? null,
    lastOkAt: rec.lastOkAt?.toISOString() ?? null,
    lastDurationMs: rec.lastDurationMs,
    lastError: rec.lastError,
    nextRunAt: rec.nextRunAt?.toISOString() ?? null,
    note: rec.def.note ?? null,
  };
}

/** Every registered job, armed or off, alphabetically by label. */
export function listJobs(): JobStatus[] {
  return [...jobs.values()].map(statusOf).sort((a, b) => a.label.localeCompare(b.label));
}

/** Tests: clear every timer and forget every job. */
export function __resetJobsForTests(): void {
  for (const rec of jobs.values()) if (rec.timer) clearInterval(rec.timer);
  jobs.clear();
}
