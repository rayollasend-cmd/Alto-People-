import type { IntegrationConnectionSummary, IntegrationSyncStatus, IntegrationVendor } from '@alto-people/shared';

const VENDOR_LABELS: Record<IntegrationVendor, string> = {
  FIELDGLASS: 'SAP Fieldglass',
  ADP: 'ADP Workforce Now',
  WORKDAY: 'Workday',
  UKG: 'UKG Pro WFM',
  BEELINE: 'Beeline',
};

export function vendorLabel(v: IntegrationVendor): string {
  return VENDOR_LABELS[v] ?? v;
}

type BadgeVariant = 'success' | 'pending' | 'destructive' | 'outline' | 'default' | 'accent';

/** One badge per connection: the mode when it is healthy, the trouble when it is not. */
/**
 * A connection's state in the one vocabulary Integrations uses for every
 * card and row (F500 G4): Working · Needs attention · Failing. Paused and
 * sandbox are said beside it (`modeLabel`), not as a fourth and fifth word.
 */
export function connectionStatus(c: Pick<IntegrationConnectionSummary, 'status' | 'sandbox'>): { label: string; variant: BadgeVariant } {
  if (c.status === 'ERROR') return { label: 'Failing', variant: 'destructive' };
  if (c.status === 'PAUSED') return { label: 'Needs attention', variant: 'pending' };
  return { label: 'Working', variant: 'success' };
}

/** "Sandbox", "Paused" or "Live" — how the connection runs, beside its state. */
export function modeLabel(c: Pick<IntegrationConnectionSummary, 'status' | 'sandbox'>): string {
  if (c.status === 'PAUSED') return 'Paused';
  return c.sandbox ? 'Sandbox' : 'Live';
}

export function runStatus(s: IntegrationSyncStatus): { label: string; variant: BadgeVariant } {
  switch (s) {
    case 'SUCCEEDED':
      return { label: 'Succeeded', variant: 'success' };
    case 'PARTIAL':
      return { label: 'Partial', variant: 'pending' };
    case 'FAILED':
      return { label: 'Failed', variant: 'destructive' };
    default:
      return { label: 'Running', variant: 'outline' };
  }
}

export const SCHEDULE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Manual and on events only' },
  { value: '15', label: 'Every 15 minutes' },
  { value: '60', label: 'Every hour' },
  { value: '360', label: 'Every 6 hours' },
  { value: '1440', label: 'Once a day' },
];
