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
export function connectionStatus(c: Pick<IntegrationConnectionSummary, 'status' | 'sandbox'>): { label: string; variant: BadgeVariant } {
  if (c.status === 'ERROR') return { label: 'Needs attention', variant: 'destructive' };
  if (c.status === 'PAUSED') return { label: 'Paused', variant: 'outline' };
  return c.sandbox ? { label: 'Sandbox', variant: 'default' } : { label: 'Connected', variant: 'success' };
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
