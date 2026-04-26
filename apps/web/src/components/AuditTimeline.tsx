import type { AuditLogEntry } from '@alto-people/shared';

interface AuditTimelineProps {
  entries: AuditLogEntry[];
}

const ACTION_LABELS: Record<string, string> = {
  'auth.login': 'Logged in',
  'auth.logout': 'Logged out',
  'auth.login_failed': 'Login failed',
  'onboarding.application_created': 'Application created',
  'onboarding.profile_updated': 'Profile updated',
  'onboarding.w4_submitted': 'W-4 submitted',
  'onboarding.direct_deposit_set': 'Direct deposit set',
  'onboarding.policy_acknowledged': 'Policy acknowledged',
  'onboarding.task_skipped': 'Task skipped (demo)',
};

export function AuditTimeline({ entries }: AuditTimelineProps) {
  if (entries.length === 0) {
    return (
      <div className="text-sm text-silver/70 italic">
        No activity recorded yet.
      </div>
    );
  }

  return (
    <ol className="space-y-3 border-l border-navy-secondary pl-4">
      {entries.map((e) => {
        const ts = new Date(e.createdAt);
        const label = ACTION_LABELS[e.action] ?? e.action;
        return (
          <li key={e.id} className="relative">
            <span
              className="absolute -left-[21px] top-1.5 w-2 h-2 rounded-full bg-gold"
              aria-hidden="true"
            />
            <div className="text-sm text-white">{label}</div>
            <div className="text-xs text-silver mt-0.5">
              {ts.toLocaleString()}{' '}
              {e.actorEmail && (
                <span className="text-silver/70"> · {e.actorEmail}</span>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
