import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { axe } from 'vitest-axe';
import type { Capability } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import { Login } from '@/pages/Login';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table';

/**
 * Phase F500-4 — automated accessibility floor. These are SMOKE tests:
 * they catch structural regressions (missing labels, broken roles, bad
 * aria wiring) in the primitives and the one page every user hits.
 * They are NOT a full audit — color-contrast can't run in jsdom (no
 * layout/paint), and `region` is disabled because component renders
 * aren't full documents with landmarks.
 *
 * If a test here fails, the fix belongs in the component, not in this
 * file's config. Widening the disabled-rules list to make a failure go
 * away defeats the entire check.
 */

const AXE_OPTIONS = {
  rules: {
    // Needs real rendering to compute contrast; jsdom has none. The
    // silver/70 floor is enforced by review + reference_contrast_thresholds.
    'color-contrast': { enabled: false },
    // Component subtrees aren't whole pages; landmark coverage is the
    // Layout shell's job (skip link + <main> already exist there).
    region: { enabled: false },
  },
} as const;

function formatViolations(violations: Awaited<ReturnType<typeof axe>>['violations']) {
  return violations
    .map(
      (v) =>
        `[${v.impact}] ${v.id}: ${v.help}\n` +
        v.nodes.map((n) => `    ${n.html}`).join('\n'),
    )
    .join('\n');
}

async function expectNoViolations(container: HTMLElement) {
  const results = await axe(container, AXE_OPTIONS);
  expect(
    results.violations,
    formatViolations(results.violations),
  ).toHaveLength(0);
}

describe('axe smoke tests', () => {
  it('<Login> has no axe violations', async () => {
    const value = {
      isInitializing: false,
      isOffline: false,
      user: null,
      role: null,
      capabilities: new Set<Capability>(),
      signIn: vi.fn(async () => {}),
      signOut: vi.fn(),
      can: () => false,
    };
    const { container } = render(
      <AuthContext.Provider value={value}>
        <MemoryRouter>
          <Login />
        </MemoryRouter>
      </AuthContext.Provider>,
    );
    await expectNoViolations(container);
  });

  it('form primitives (Button, Input, Select, Badge) have no axe violations', async () => {
    const { container } = render(
      <main>
        <h1>Sampler</h1>
        <form aria-label="Sample form">
          <label htmlFor="sample-input">Name</label>
          <Input id="sample-input" defaultValue="Jane" />
          <label htmlFor="sample-select">Status</label>
          <Select id="sample-select" defaultValue="active">
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </Select>
          <Button type="submit">Save</Button>
          <Button variant="secondary" loading>
            Saving
          </Button>
          <Badge variant="success">Active</Badge>
        </form>
      </main>,
    );
    await expectNoViolations(container);
  });

  it('<Table> with sr-only caption and interactive rows has no axe violations', async () => {
    const { container } = render(
      <main>
        <h1>People</h1>
        <Table caption="Associate directory">
          <TableHeader>
            <TableRow>
              <TableHead>Associate</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow className="cursor-pointer" onClick={() => {}}>
              <TableCell>Jane Doe</TableCell>
              <TableCell>
                <Badge variant="success">Active</Badge>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </main>,
    );
    await expectNoViolations(container);
  });
});
