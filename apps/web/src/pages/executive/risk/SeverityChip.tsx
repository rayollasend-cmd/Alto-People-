import type { ExecRiskSeverity } from '@alto-people/shared';
import type * as React from 'react';
import { Badge } from '@/components/ui/Badge';
import { SEVERITY_CHIP } from './riskMeta';

/** A severity as the kit's chip: high on the negative scale, medium caution, low the neutral family. */
export function SeverityChip({ severity, children, size }: { severity: ExecRiskSeverity; children: React.ReactNode; size?: 'sm' | 'default' }) {
  if (severity === 'high') return <Badge variant="destructive" size={size}>{children}</Badge>;
  if (severity === 'medium') return <Badge variant="pending" size={size}>{children}</Badge>;
  return (
    <Badge variant="default" size={size} className={SEVERITY_CHIP.low}>
      {children}
    </Badge>
  );
}
