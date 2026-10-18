import type { LeaveReason, LeaveSchedule, LeaveStatus, LeaveType, LeaveDocumentKind } from '@/lib/leaveApi';

/** The leave desk's words — never a raw enum on screen. */

export const TYPE_LABEL: Record<LeaveType, string> = {
  FMLA: 'FMLA',
  STATE_PFML: 'State paid leave',
  MILITARY_USERRA: 'Military leave (USERRA)',
  ADA_ACCOMMODATION: 'Accommodation (ADA)',
  PERSONAL: 'Personal leave',
  COMPANY: 'Company leave',
};

export const REASON_LABEL: Record<LeaveReason, string> = {
  OWN_HEALTH: 'Their own health',
  FAMILY_CARE: 'Caring for family',
  BONDING: 'A new child',
  PREGNANCY: 'Pregnancy',
  MILITARY_EXIGENCY: 'Military family need',
  MILITARY_CAREGIVER: 'Military caregiver',
  MILITARY_SERVICE: 'Military service',
  ACCOMMODATION: 'Accommodation',
  OTHER: 'Other',
};

export const REASONS_BY_TYPE: Record<LeaveType, LeaveReason[]> = {
  FMLA: ['OWN_HEALTH', 'FAMILY_CARE', 'BONDING', 'PREGNANCY', 'MILITARY_EXIGENCY', 'MILITARY_CAREGIVER'],
  STATE_PFML: ['OWN_HEALTH', 'FAMILY_CARE', 'BONDING', 'PREGNANCY'],
  MILITARY_USERRA: ['MILITARY_SERVICE'],
  ADA_ACCOMMODATION: ['ACCOMMODATION'],
  PERSONAL: ['OTHER', 'FAMILY_CARE'],
  COMPANY: ['OTHER'],
};

export const SCHEDULE_LABEL: Record<LeaveSchedule, string> = {
  CONTINUOUS: 'Continuous',
  INTERMITTENT: 'Intermittent',
  REDUCED: 'Reduced schedule',
};

export const STATUS_META: Record<LeaveStatus, { label: string; variant: 'pending' | 'success' | 'destructive' | 'info' | 'outline' }> = {
  REQUESTED: { label: 'Requested', variant: 'pending' },
  PENDING_CERTIFICATION: { label: 'Waiting on certification', variant: 'pending' },
  APPROVED: { label: 'Approved', variant: 'success' },
  DENIED: { label: 'Denied', variant: 'destructive' },
  RETURNED: { label: 'Back at work', variant: 'info' },
  CLOSED: { label: 'Closed', variant: 'outline' },
  CANCELLED: { label: 'Cancelled', variant: 'outline' },
};

export const DOC_LABEL: Record<LeaveDocumentKind, string> = {
  MEDICAL_CERTIFICATION: 'Medical certification',
  FITNESS_FOR_DUTY: 'Fitness for duty',
  MILITARY_ORDERS: 'Military orders',
  OTHER: 'Other document',
};

export const YEAR_METHOD_LABEL = {
  ROLLING_BACKWARD: 'Rolling back 12 months from each leave',
  ROLLING_FORWARD: 'Rolling forward from the first leave',
  CALENDAR: 'Calendar year',
  FIXED: 'A fixed 12-month year',
} as const;
