import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { DEFAULT_WORK_TASK_POLICY } from '@alto-people/shared';
import { PageTitleProvider, usePageTitle } from '@/lib/pageTitle';
import { renderAs } from '../hrPack/harness';

/**
 * F500 G4 — the small Settings pages and the catch-all: Task assignment in
 * plain words with its scope labelled and custom sites marked; the
 * not-found page names itself and offers a way back and a search.
 */

const getTaskPolicy = vi.fn();
vi.mock('@/lib/tasksApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/tasksApi')>()),
  getTaskPolicy: (...a: unknown[]) => getTaskPolicy(...a),
  updateTaskPolicy: vi.fn(),
}));
vi.mock('@/lib/useOrgSites', () => ({
  useOrgSites: () => [
    { id: 's1', name: 'Front Beach 218' },
    { id: 's2', name: 'Back Bay' },
  ],
}));

import { TaskPolicyPage } from '@/pages/tasks/TaskPolicyPage';
import { NotFound } from '@/pages/NotFound';

beforeEach(() => {
  vi.clearAllMocks();
  getTaskPolicy.mockResolvedValue({ ...DEFAULT_WORK_TASK_POLICY, overrideLocationIds: ['s2'] });
});

describe('Task assignment', () => {
  it('labels the scope "Applies to", marks the sites with their own policy, and never says "engine"', async () => {
    renderAs('HR_ADMINISTRATOR', <TaskPolicyPage />, '/admin/task-policy');
    const scope = await screen.findByLabelText('Applies to');
    await waitFor(() => expect(scope).toHaveTextContent('Back Bay (custom)'));
    expect(scope).toHaveTextContent('Front Beach 218');
    expect(scope).not.toHaveTextContent('Front Beach 218 (custom)');
    expect(document.body.textContent).not.toMatch(/engine/i);
  });
});

function TopbarTitle() {
  return <output data-testid="topbar-title">{usePageTitle() ?? ''}</output>;
}

describe('Not found', () => {
  it('names itself in the top bar and offers search and home', async () => {
    const onKey = vi.fn();
    window.addEventListener('keydown', onKey);
    render(
      <MemoryRouter initialEntries={['/nowhere']}>
        <PageTitleProvider>
          <TopbarTitle />
          <NotFound />
        </PageTitleProvider>
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { level: 1, name: /couldn’t find that page/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('topbar-title')).toHaveTextContent('Page not found'));
    expect(screen.getByRole('link', { name: 'Go home' })).toHaveAttribute('href', '/');
    // Search opens the command palette the way ⌘K does.
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(onKey).toHaveBeenCalledWith(expect.objectContaining({ key: 'k' }));
    window.removeEventListener('keydown', onKey);
  });
});
