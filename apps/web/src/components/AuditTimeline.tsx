import { useState } from 'react';
import { ChevronDown, ChevronUp } from '@/components/ui/icons';
import type { AuditLogEntry } from '@alto-people/shared';
import { fmtDateTime } from '@/lib/format';
import { EmptyState } from '@/components/ui/EmptyState';
import '@/lib/i18n/en/people';

interface AuditTimelineProps {
  entries: AuditLogEntry[];
  /**
   * Show only the first N entries by default, with a "Show all" toggle for
   * the rest. Defaults to 5 — set to 0 to disable collapsing.
   */
  previewLimit?: number;
}

/**
 * Human labels for every event code the API writes to an application's
 * activity history (HR walk 20). A code with no entry here still reads as
 * words through `humanizeAction`, so the timeline never shows
 * "onboarding.nudge_sent" raw again — but an explicit label is the rule,
 * and the test holds this map to the API's list.
 */
export const ACTION_LABELS: Record<string, string> = {
  'auth.login': 'Logged in',
  'auth.logout': 'Logged out',
  'auth.login_failed': 'Login failed',
  // Onboarding
  'onboarding.application_cancelled': 'Invite cancelled',
  'onboarding.application_created': 'Application created',
  'onboarding.application_reopened': 'Invite reopened',
  'onboarding.background_check_authorized': 'Background check authorized',
  'onboarding.csv_imported': 'Imported from CSV',
  'onboarding.direct_deposit_set': 'Direct deposit set',
  'onboarding.documents_submitted': 'Documents submitted',
  'onboarding.eeo_self_id_submitted': 'Voluntary self-identification submitted',
  'onboarding.esign_agreement_created': 'Agreement sent for signature',
  'onboarding.esign_signed': 'Agreement signed',
  'onboarding.first_day_updated': 'First-day details updated',
  'onboarding.ghost_purged': 'Abandoned application purged',
  'onboarding.i9_document_uploaded': 'I-9 document uploaded',
  'onboarding.i9_documents_submitted': 'I-9 documents submitted for review',
  'onboarding.i9_section1_submitted': 'I-9 Section 1 signed',
  'onboarding.i9_section2_verified': 'I-9 Section 2 verified',
  'onboarding.invite_resent': 'Invite resent',
  'onboarding.j1_docs_submitted': 'J-1 documents submitted',
  'onboarding.j1_profile_saved': 'J-1 program details saved',
  'onboarding.nudge_sent': 'Nudge sent',
  'onboarding.packet_downloaded': 'Audit packet downloaded',
  'onboarding.phone_changed': 'Phone number changed',
  'onboarding.policy_acknowledged': 'Policy acknowledged',
  'onboarding.profile_photo_submitted': 'Profile photo taken',
  'onboarding.profile_updated': 'Profile updated',
  'onboarding.task_reopened': 'Task reopened',
  'onboarding.task_skipped': 'Task skipped',
  'onboarding.w4_submitted': 'W-4 submitted',
  // Compliance
  'compliance.audit_packet_generated': 'Audit packet generated',
  'compliance.audit_packet_generated_workforce': 'Workforce audit packet generated',
  'compliance.background_adverse': 'Final adverse action notice sent',
  'compliance.background_adverse_withdrawn': 'Adverse action withdrawn',
  'compliance.background_bulk_initiated': 'Background checks ordered in bulk',
  'compliance.background_initiated': 'Background check recorded',
  'compliance.background_ordered': 'Background check ordered',
  'compliance.background_pending_exported': 'Pending background checks exported',
  'compliance.background_pre_adverse': 'Pre-adverse action notice sent',
  'compliance.background_report_viewed': 'Background report viewed',
  'compliance.background_updated': 'Background check updated',
  'compliance.drug_test_bulk_initiated': 'Drug tests ordered in bulk',
  'compliance.drug_test_initiated': 'Drug test recorded',
  'compliance.drug_test_ordered': 'Drug test ordered',
  'compliance.drug_test_pending_exported': 'Pending drug tests exported',
  'compliance.drug_test_report_viewed': 'Drug test report viewed',
  'compliance.drug_test_updated': 'Drug test updated',
  'compliance.eeo_report_viewed': 'EEO applicant report viewed',
  'compliance.everify_case_closed': 'E-Verify case closed',
  'compliance.everify_case_recorded': 'E-Verify case recorded',
  'compliance.everify_case_submitted': 'E-Verify case submitted',
  'compliance.everify_case_viewed': 'E-Verify case viewed',
  'compliance.everify_identity_updated': 'E-Verify identity details updated',
  'compliance.everify_tnc_decision': 'E-Verify mismatch decision recorded',
  'compliance.evidence_signed_off': 'Compliance evidence signed off',
  'compliance.i9_updated': 'I-9 updated',
  'compliance.j1_upserted': 'J-1 record updated',
  // Recruiting
  'recruiting.calendar_feed_rotated': 'Calendar feed link rotated',
  'recruiting.candidate_auto_closed': 'Candidate closed automatically',
  'recruiting.candidate_created': 'Candidate added',
  'recruiting.candidate_hired': 'Candidate hired',
  'recruiting.note_added': 'Note added',
  'recruiting.stage_changed': 'Stage changed',
  // Separation and people
  'separation.assets_waived': 'Asset return waived',
  'separation.completed': 'Separation completed',
  'people.mass_update': 'Mass update applied',
  'people.mass_update_undone': 'Mass update undone',
  'privacy.associate_erased': 'Record erased',
  'org.associate.ssn_revealed': 'SSN revealed',
  'org.associate.payout_method_revealed': 'Bank details revealed',
  'org.associate.phone_changed': 'Phone number changed',
  'org.associate.w4_updated_by_hr': 'W-4 updated by HR',
  'org.associate.payroll_census_exported': 'Payroll census exported',
};

/** "onboarding.nudge_sent" → "Nudge sent": the last segment, in words. */
export function humanizeAction(code: string): string {
  const last = code.split('.').filter(Boolean).pop() ?? code;
  const words = last.replace(/[_-]+/g, ' ').trim();
  if (!words) return code;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The label for an event code: explicit when we have one, words otherwise. */
export function labelForAction(code: string): string {
  return ACTION_LABELS[code] ?? humanizeAction(code);
}

export function AuditTimeline({ entries, previewLimit = 5 }: AuditTimelineProps) {
  const [expanded, setExpanded] = useState(false);

  if (entries.length === 0) {
    return (
      <EmptyState size="sm" title="No activity recorded yet." />
    );
  }

  const collapsible = previewLimit > 0 && entries.length > previewLimit;
  const visible = collapsible && !expanded ? entries.slice(0, previewLimit) : entries;

  return (
    <>
      <ol className="space-y-3 border-l border-navy-secondary pl-4">
        {visible.map((e) => {
          const label = labelForAction(e.action);
          return (
            <li key={e.id} className="relative">
              <span
                className="absolute -left-[21px] top-1.5 w-2 h-2 rounded-full bg-gold"
                aria-hidden="true"
              />
              <div className="text-sm text-ink">{label}</div>
              <div className="text-xs text-silver mt-0.5">
                {fmtDateTime(e.createdAt)}{' '}
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
