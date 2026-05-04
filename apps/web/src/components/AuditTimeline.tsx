import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import type { AuditLogEntry } from '@alto-people/shared';

interface AuditTimelineProps {
  entries: AuditLogEntry[];
  /**
   * Show only the first N entries by default, with a "Show all" toggle for
   * the rest. Defaults to 5 — set to 0 to disable collapsing.
   */
  previewLimit?: number;
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

export function AuditTimeline({ entries, previewLimit = 5 }: AuditTimelineProps) {
  const [expanded, setExpanded] = useState(false);

  if (entries.length === 0) {
    return (
      <div className="text-sm text-silver/70 italic">
        No activity recorded yet.
      </div>
    );
  }

  const collapsible = previewLimit > 0 && entries.length > previewLimit;
  const visible = collapsible && !expanded ? entries.slice(0, previewLimit) : entries;

  return (
    <>
      <ol className="space-y-3 border-l border-navy-secondary pl-4">
        {visible.map((e) => {
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
      {collapsible && (
        <div className="mt-3 flex justify-center">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="inline-flex items-center gap-1.5 text-xs text-silver hover:text-gold-bright transition-colors"
            aria-expanded={expanded}
          >
            {expanded ? (
              <>
                <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
                Show fewer
              </>
            ) : (
              <>
                <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                Show all {entries.length}
              </>
            )}
          </button>
        </div>
      )}
    </>
  );
}
