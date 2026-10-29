import type { TimesheetRow } from '@alto-people/shared';

export type TimesheetStageKey =
  | 'PENDING_APPROVAL'
  | 'READY'
  | 'ENTERED'
  | 'DRAFT'
  | 'SUBMITTED'
  | 'RESUBMITTED'
  | 'APPROVED'
  | 'INVOICED'
  | 'REJECTED';

export interface TimesheetStage {
  key: TimesheetStageKey;
  label: string;
  variant: 'pending' | 'success' | 'info' | 'accent' | 'default' | 'destructive';
}

/**
 * Where a worker's week stands, end to end — ONE status per Client hours
 * row. It used to be Alto's half only (PENDING vs everything else), so every
 * row said "Ready to submit" while its Fieldglass column said "Submitted"
 * (deep audit FLOOR-21). The order is the week's path:
 *
 *   Pending approval   some of the week still waits for review in Alto —
 *                      the reviewer's next step, whatever Fieldglass holds
 *   Ready to submit    all approved, not in Fieldglass yet
 *   Entered            ticked as entered, the Fieldglass list not imported yet
 *   Draft / Submitted / Resubmitted / Approved / Invoiced / Rejected
 *                      what the imported Fieldglass list says
 */
export function timesheetStage(row: Pick<TimesheetRow, 'status' | 'fieldglass'>): TimesheetStage {
  if (row.status === 'PENDING') return { key: 'PENDING_APPROVAL', label: 'Pending approval', variant: 'pending' };
  const fg = row.fieldglass ?? null;
  switch (fg?.status ?? null) {
    case 'SUBMITTED':
      return fg?.resubmittedAt
        ? { key: 'RESUBMITTED', label: 'Resubmitted', variant: 'info' }
        : { key: 'SUBMITTED', label: 'Submitted', variant: 'info' };
    case 'APPROVED':
      return { key: 'APPROVED', label: 'Approved', variant: 'success' };
    case 'INVOICED':
      return { key: 'INVOICED', label: 'Invoiced', variant: 'success' };
    case 'REJECTED':
      return { key: 'REJECTED', label: 'Rejected', variant: 'destructive' };
    case 'DRAFT':
      return { key: 'DRAFT', label: 'Draft in Fieldglass', variant: 'default' };
    default:
      break;
  }
  if (fg?.enteredAt) return { key: 'ENTERED', label: 'Entered', variant: 'accent' };
  return { key: 'READY', label: 'Ready to submit', variant: 'success' };
}
