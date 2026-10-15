import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import type { AgentScope } from '@alto-people/shared';
import { AgentCatalogPicker, type CatalogChoice } from '@/pages/admin/AgentCatalogPicker';

/**
 * Brief 2-6 step 1 — registering an agent: a family, then the catalog
 * capabilities offered here; picking one adds the scopes it needs. Custom
 * (no family) offers none.
 */

vi.mock('@/lib/auth', () => ({ useTenant: () => ({ modules: { scheduling: true, time: true, compliance: true, hrCases: true } }) }));

function Harness({ onScopes }: { onScopes: (s: AgentScope[]) => void }) {
  const [value, setValue] = useState<CatalogChoice>({ family: null, capabilities: [] });
  const [scopes, setScopes] = useState<AgentScope[]>([]);
  return (
    <AgentCatalogPicker
      value={value}
      onChange={setValue}
      scopes={scopes}
      onScopes={(s) => {
        setScopes(s);
        onScopes(s);
      }}
    />
  );
}

describe('AgentCatalogPicker', () => {
  it('custom offers nothing; a family lists its offered capabilities; picking one brings its scopes', () => {
    const onScopes = vi.fn();
    render(<Harness onScopes={onScopes} />);
    expect(screen.queryByText('Catalog capabilities')).toBeNull();
    fireEvent.change(screen.getByLabelText('Family'), { target: { value: 'workforce' } });
    const fill = screen.getByText('Fill open shifts');
    expect(screen.getByText('Repair coverage when it breaks')).toBeTruthy();
    fireEvent.click(fill);
    expect(onScopes).toHaveBeenLastCalledWith(['view:scheduling', 'view:org', 'manage:scheduling']);
  });
});
