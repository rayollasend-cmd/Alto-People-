import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ACTION_LABELS, AuditTimeline, humanizeAction, labelForAction } from '@/components/AuditTimeline';

/**
 * HR walk 20: the application page showed "onboarding.nudge_sent" raw.
 * Every onboarding.* code the API writes (apps/api/src, grep
 * `'onboarding.` on recordOnboardingEvent calls) has a label here, and
 * any code we have not met yet still reads as words.
 */
const ONBOARDING_CODES = [
  'onboarding.application_cancelled',
  'onboarding.application_created',
  'onboarding.application_reopened',
  'onboarding.background_check_authorized',
  'onboarding.csv_imported',
  'onboarding.direct_deposit_set',
  'onboarding.documents_submitted',
  'onboarding.eeo_self_id_submitted',
  'onboarding.esign_agreement_created',
  'onboarding.esign_signed',
  'onboarding.first_day_updated',
  'onboarding.ghost_purged',
  'onboarding.i9_document_uploaded',
  'onboarding.i9_documents_submitted',
  'onboarding.i9_section1_submitted',
  'onboarding.i9_section2_verified',
  'onboarding.invite_resent',
  'onboarding.j1_docs_submitted',
  'onboarding.j1_profile_saved',
  'onboarding.nudge_sent',
  'onboarding.packet_downloaded',
  'onboarding.phone_changed',
  'onboarding.policy_acknowledged',
  'onboarding.profile_photo_submitted',
  'onboarding.profile_updated',
  'onboarding.task_reopened',
  'onboarding.task_skipped',
  'onboarding.w4_submitted',
];

describe('AuditTimeline labels', () => {
  it('has an explicit label for every onboarding.* event the API emits', () => {
    for (const code of ONBOARDING_CODES) {
      expect(ACTION_LABELS[code], code).toBeTruthy();
      expect(labelForAction(code), code).not.toMatch(/\./);
    }
  });

  it('turns an unknown code into words instead of showing it raw', () => {
    expect(humanizeAction('onboarding.nudge_sent')).toBe('Nudge sent');
    expect(labelForAction('something.never_seen_before')).toBe('Never seen before');
  });

  it('renders the label, not the code', () => {
    render(
      <AuditTimeline
        entries={[
          { id: '1', action: 'onboarding.nudge_sent', createdAt: new Date().toISOString(), actorEmail: 'hr@example.com' } as never,
          { id: '2', action: 'onboarding.brand_new_thing', createdAt: new Date().toISOString(), actorEmail: null } as never,
        ]}
      />,
    );
    expect(screen.getByText('Nudge sent')).toBeInTheDocument();
    expect(screen.getByText('Brand new thing')).toBeInTheDocument();
    expect(screen.queryByText('onboarding.nudge_sent')).toBeNull();
  });
});
