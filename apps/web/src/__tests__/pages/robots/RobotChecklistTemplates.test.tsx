import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RobotChecklistTemplateSummary } from '@alto-people/shared';

vi.mock('@/lib/auth', async () => {
  const React = await import('react');
  const auth = { user: { id: 'u1', role: 'HR_ADMINISTRATOR', email: 'hr@altohr.com' }, can: () => true };
  return { AuthContext: React.createContext(auth), useAuth: () => auth, useTenant: () => ({ modules: { robotics: true }, moduleOn: () => true }), useTerm: () => (k: string) => k };
});
vi.mock('@/lib/useOrgSites', () => ({ useOrgSites: () => [{ id: 's1', name: 'Front Beach 218' }] }));
vi.mock('@/lib/robotsApi', () => ({
  listAllChecklistTemplates: vi.fn(),
  createChecklistTemplate: vi.fn(async (input: unknown) => ({ id: 't-new', active: true, ...(input as object) })),
  updateChecklistTemplate: vi.fn(async (id: string, input: unknown) => ({ id, ...(input as object) })),
}));

import { createChecklistTemplate, listAllChecklistTemplates, updateChecklistTemplate } from '@/lib/robotsApi';
import { RobotChecklistTemplates, keyFromLabel } from '@/pages/robots/RobotChecklistTemplates';

/**
 * Audit 2026-10-21: the checklist templates had an API and no screen. The
 * editor lists them with their scope, creates one with its items, and
 * archives one without deleting it.
 */

const templates: RobotChecklistTemplateSummary[] = [
  { id: 't1', locationId: null, name: 'Pre-shift: Servi', items: [{ key: 'brakes', label: 'Brakes respond', required: true }, { key: 'tray', label: 'Tray clean', required: false }], active: true },
  { id: 't2', locationId: 's1', name: 'Pool deck extras', items: [{ key: 'wet', label: 'Deck dry', required: true }], active: false },
];

function renderPage() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/robots/checklists']}>
        <RobotChecklistTemplates />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('robot checklist templates', () => {
  it('derives a stable key from the label', () => {
    expect(keyFromLabel('Brakes respond!')).toBe('brakes-respond');
    expect(keyFromLabel('  Charging dock — clear ')).toBe('charging-dock-clear');
  });

  it('lists every template with its scope and status, and archives one', async () => {
    vi.mocked(listAllChecklistTemplates).mockResolvedValue({ templates });
    renderPage();
    expect(await screen.findByText('Pre-shift: Servi')).toBeInTheDocument();
    expect(screen.getByText('Pool deck extras')).toBeInTheDocument();
    expect(screen.getByText('Every site')).toBeInTheDocument();
    expect(screen.getByText('Front Beach 218')).toBeInTheDocument();
    expect(screen.getByText('2 · 1 required')).toBeInTheDocument();
    expect(screen.getByText('1 in use · 1 archived')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Archive Pre-shift: Servi' }));
    expect(updateChecklistTemplate).toHaveBeenCalledWith('t1', expect.objectContaining({ name: 'Pre-shift: Servi', active: false, items: templates[0]!.items }));
  });

  it('creates a template from the form with its items and scope', async () => {
    vi.mocked(listAllChecklistTemplates).mockResolvedValue({ templates: [] });
    renderPage();
    expect(await screen.findByText('No checklist yet')).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('button', { name: 'New checklist' })[0]!);
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/Name/), 'Pre-shift: Pudu');
    await userEvent.selectOptions(within(dialog).getByLabelText(/Applies to/), 's1');
    await userEvent.type(within(dialog).getByLabelText('Item 1'), 'Brakes respond');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add item' }));
    await userEvent.type(within(dialog).getByLabelText('Item 2'), 'Tray clean');
    await userEvent.click(within(dialog).getAllByLabelText('Required')[1]!);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(createChecklistTemplate).toHaveBeenCalledWith({
      name: 'Pre-shift: Pudu',
      locationId: 's1',
      active: true,
      items: [
        { key: 'brakes-respond', label: 'Brakes respond', required: true },
        { key: 'tray-clean', label: 'Tray clean', required: false },
      ],
    });
  });
});
