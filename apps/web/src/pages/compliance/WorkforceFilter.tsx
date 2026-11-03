import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  COMPLIANCE_WORKFORCES,
  COMPLIANCE_WORKFORCE_DEFINITIONS,
  COMPLIANCE_WORKFORCE_LABELS,
  DEFAULT_COMPLIANCE_WORKFORCE,
  isComplianceWorkforce,
  type ComplianceWorkforce,
  type WorkforceCounts,
} from '@alto-people/shared';
import { FilterChip } from '@/components/ui/FilterBar';
import { usePersistentState } from '@/lib/usePersistentState';

/**
 * Who a compliance list is about (owner, 2026-11-03): Current · Starting
 * soon · Paused · Former · All. Every compliance tab opens on the current
 * workforce; the choice is shared by the tabs (one saved key), so someone
 * reviewing the paused people stays on them from E-Verify to I-9.
 *
 * `?workforce=` on a link picks the group for that visit only, like the
 * tabs' own `?status=`; the tab removes it from the URL with its other
 * deep-link params (WORKFORCE_PARAM). A link to one person (`wide`) opens
 * on All, so that person is on the list whatever their group.
 */
export const WORKFORCE_PARAM = 'workforce';
const STORAGE_KEY = 'alto:list.compliance.workforce.v1';

export function useComplianceWorkforce(opts: { wide?: boolean } = {}): {
  workforce: ComplianceWorkforce;
  setWorkforce: (w: ComplianceWorkforce) => void;
} {
  const [params] = useSearchParams();
  const [stored, setStored] = usePersistentState<ComplianceWorkforce>(STORAGE_KEY, DEFAULT_COMPLIANCE_WORKFORCE, isComplianceWorkforce);
  const [override, setOverride] = useState<ComplianceWorkforce | null>(() => {
    const linked = params.get(WORKFORCE_PARAM);
    if (isComplianceWorkforce(linked)) return linked;
    return opts.wide ? 'all' : null;
  });
  return {
    workforce: override ?? stored,
    setWorkforce: (w) => {
      setOverride(null);
      setStored(w);
    },
  };
}

export function WorkforceFilter({
  value,
  onChange,
  counts,
  className,
}: {
  value: ComplianceWorkforce;
  onChange: (w: ComplianceWorkforce) => void;
  /** The list's own people per group; absent while loading or from an older server. */
  counts?: WorkforceCounts | null;
  className?: string;
}) {
  return (
    <div role="group" aria-label="Who to show" className={className ?? 'flex flex-wrap gap-2'} data-testid="compliance-workforce">
      {COMPLIANCE_WORKFORCES.map((w) => (
        <FilterChip
          key={w}
          active={value === w}
          onClick={() => onChange(w)}
          title={COMPLIANCE_WORKFORCE_DEFINITIONS[w]}
          count={counts?.[w]}
          className="shrink-0"
        >
          {COMPLIANCE_WORKFORCE_LABELS[w]}
        </FilterChip>
      ))}
    </div>
  );
}
