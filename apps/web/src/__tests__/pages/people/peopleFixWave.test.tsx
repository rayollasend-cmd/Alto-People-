import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, screen, waitFor } from '@testing-library/react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { renderAs } from '../hrPack/harness';
import { useDirtyForm } from '@/lib/useDirtyForm';
import { personRecordTabs } from '@/lib/personTabs';
import { ROLE_CAPABILITIES, type Capability } from '@alto-people/shared';

/**
 * The deep audit's People fix wave (2026-10-29), web side:
 *   PEOPLE-9   Mass update offers pay schedules only to payroll.
 *   PEOPLE-8   the Documents tab only for a role the vault serves.
 *   PEOPLE-14  the dirty-form guard every form dialog uses.
 *   PEOPLE-19  the course catalog lives at /learning/catalog (People), "My learning" at /learning.
 *   CRAWL-3    Employers of record: a refused read never sits under "Add" and "No employers on file".
 */

vi.mock('@/lib/massUpdateApi', () => ({ previewMassUpdate: vi.fn(), applyMassUpdate: vi.fn(), listMassUpdateBatches: vi.fn(async () => ({ batches: [] })), undoMassUpdate: vi.fn() }));
vi.mock('@/lib/orgApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/orgApi')>()),
  listDepartments: vi.fn(async () => ({ departments: [] })),
  listCostCenters: vi.fn(async () => ({ costCenters: [] })),
  listJobProfiles: vi.fn(async () => ({ jobProfiles: [] })),
  listEmployers: vi.fn(async () => {
    throw new Error('refused');
  }),
}));
vi.mock('@/lib/payrollApi', async (orig) => ({ ...(await orig<typeof import('@/lib/payrollApi')>()), listPayrollSchedules: vi.fn(async () => ({ schedules: [{ id: 's1', name: 'Weekly' }] })) }));
vi.mock('@/lib/useOrgSites', () => ({ useOrgSites: () => [] }));
vi.mock('@/lib/useClients', () => ({ useClients: () => ({ clients: [], isError: false, refetch: vi.fn() }) }));
vi.mock('@/lib/lms94Api', async (orig) => ({
  ...(await orig<typeof import('@/lib/lms94Api')>()),
  getMyTraining: vi.fn(async () => ({ enrollments: [] })),
  getLmsSummary: vi.fn(async () => ({ lapsed: 0, expiring30: 0, expiring14: 0, open: 0, openStale: 0, assigned30: 0, completed30: 0, completionRate30: null })),
  listCourses: vi.fn(async () => ({ courses: [] })),
  listEnrollments: vi.fn(async () => ({ enrollments: [] })),
  listExpiring: vi.fn(async () => ({ enrollments: [] })),
}));

import { listPayrollSchedules } from '@/lib/payrollApi';
import { MassUpdate } from '@/pages/people/MassUpdate';
import { LearningHome } from '@/pages/learning/LearningHome';
import { EmployersAdmin } from '@/pages/admin/EmployersAdmin';

beforeEach(() => {
  vi.clearAllMocks();
});

function Where() {
  const l = useLocation();
  return <div data-testid="where">{`${l.pathname}${l.search}`}</div>;
}

describe('PEOPLE-9: pay schedules in Mass update are payroll’s', () => {
  it('the workforce manager (manage:org, no payroll) sees no pay-schedule field and never asks for schedules', async () => {
    renderAs('WORKFORCE_MANAGER', <MassUpdate />, '/people/mass-update');
    await screen.findByText('What changes');
    expect(screen.queryByLabelText('Pay schedule')).toBeNull();
    expect(listPayrollSchedules).not.toHaveBeenCalled();
  });

  it('payroll does, with "let the rules decide" instead of a bare Clear', async () => {
    renderAs('HR_ADMINISTRATOR', <MassUpdate />, '/people/mass-update');
    await waitFor(() => expect(screen.getAllByLabelText('Pay schedule').length).toBe(2));
    expect(screen.getByRole('option', { name: 'Let the schedule rules decide' })).toBeInTheDocument();
  });
});

describe('PEOPLE-8: the Documents tab follows the vault’s capability', () => {
  const tabsFor = (role: keyof typeof ROLE_CAPABILITIES) => personRecordTabs((c: Capability) => ROLE_CAPABILITIES[role].has(c), () => true);
  it('is shown to HR, hidden from the workforce manager (view:documents only)', () => {
    expect(tabsFor('HR_ADMINISTRATOR')).toContain('documents');
    expect(tabsFor('WORKFORCE_MANAGER')).not.toContain('documents');
  });
  it('the Cases tab follows the case desk’s rule (view:hr-admin + manage:onboarding, or payroll)', () => {
    expect(tabsFor('HR_ADMINISTRATOR')).toContain('cases');
    expect(tabsFor('FINANCE_ACCOUNTANT')).toContain('cases');
    expect(tabsFor('WORKFORCE_MANAGER')).not.toContain('cases');
    expect(tabsFor('INTERNAL_RECRUITER')).not.toContain('cases');
  });
});

describe('PEOPLE-14: useDirtyForm', () => {
  it('is clean on open (defaults included) and dirty once something changes', async () => {
    vi.useFakeTimers();
    try {
      const { result, rerender } = renderHook(({ open, v }) => useDirtyForm(open, v), { initialProps: { open: false, v: { name: '' } } });
      rerender({ open: true, v: { name: '' } });
      // A default the dialog fills in right after opening is the baseline, not an edit.
      rerender({ open: true, v: { name: 'Next Monday' } });
      await act(async () => {
        vi.runAllTimers();
      });
      expect(result.current()).toBe(false);
      rerender({ open: true, v: { name: 'Maria' } });
      expect(result.current()).toBe(true);
      rerender({ open: true, v: { name: 'Next Monday' } });
      expect(result.current()).toBe(false);
      rerender({ open: false, v: { name: 'Maria' } });
      expect(result.current()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('PEOPLE-19: the course catalog is People’s, My learning is mine', () => {
  const routes = (
    <Routes>
      <Route path="/learning" element={<><LearningHome /><Where /></>} />
      <Route path="/learning/catalog" element={<Where />} />
    </Routes>
  );
  it('HR with no training of their own lands on the catalog — and old ?tab= links follow it', async () => {
    renderAs('HR_ADMINISTRATOR', routes, '/learning?tab=expiring');
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/learning/catalog?tab=expiring'));
  });
  it('a person with a record of their own gets My learning at /learning', async () => {
    renderAs('HR_ADMINISTRATOR', routes, '/learning', { associateId: 'a1' });
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/learning$/));
  });
});

describe('CRAWL-3: Employers of record when the read fails', () => {
  it('shows the error alone — no "No employers on file", no "Add employer of record" above it', async () => {
    renderAs('WORKFORCE_MANAGER', <EmployersAdmin />, '/admin/employers');
    await screen.findByRole('alert');
    expect(screen.queryByText('No employers on file')).toBeNull();
    expect(screen.queryByRole('button', { name: /Add employer of record/ })).toBeNull();
  });
});
