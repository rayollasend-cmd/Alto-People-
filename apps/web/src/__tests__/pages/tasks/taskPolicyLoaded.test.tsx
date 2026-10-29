import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { DEFAULT_WORK_TASK_POLICY } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { renderAs } from '../hrPack/harness';

/**
 * Deep audit 2026-10-29 (CRAWL-7): while the policy loaded, and after the
 * read failed, Task assignment showed the hard-coded defaults (30 s, $4.00,
 * 70 %) as if they were the policy — with a live Save that would overwrite
 * the real one. The form now exists only once the read landed.
 */

const getTaskPolicy = vi.fn();
const updateTaskPolicy = vi.fn();
vi.mock('@/lib/tasksApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/tasksApi')>()),
  getTaskPolicy: (...a: unknown[]) => getTaskPolicy(...a),
  updateTaskPolicy: (...a: unknown[]) => updateTaskPolicy(...a),
}));
vi.mock('@/lib/useOrgSites', () => ({ useOrgSites: () => [] }));

import { TaskPolicyPage } from '@/pages/tasks/TaskPolicyPage';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Task assignment shows only the policy the server sent', () => {
  it('while the read is in flight: no form, no Save, no default numbers', () => {
    getTaskPolicy.mockReturnValue(new Promise(() => {}));
    renderAs('HR_ADMINISTRATOR', <TaskPolicyPage />, '/admin/task-policy');
    expect(screen.queryByRole('button', { name: 'Save policy' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Seconds before a person takes over')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/4\.00/);
  });

  it('a failed read says so — and offers no form to save over the real policy', async () => {
    getTaskPolicy.mockRejectedValue(new ApiError(500, 'internal', 'Request failed (500)'));
    renderAs('HR_ADMINISTRATOR', <TaskPolicyPage />, '/admin/task-policy');
    expect(await screen.findByText(/Couldn’t load the task assignment policy/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save policy' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Seconds before a person takes over')).not.toBeInTheDocument();
  });

  it('a refused read explains in words — no capability string, no Retry, no form', async () => {
    getTaskPolicy.mockRejectedValue(new ApiError(403, 'forbidden', 'Missing capability: view:time-live'));
    renderAs('HR_ADMINISTRATOR', <TaskPolicyPage />, '/admin/task-policy');
    expect(await screen.findByText(/You don’t have access to the task assignment policy/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/view:time-live|Missing capability/);
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save policy' })).not.toBeInTheDocument();
  });

  it('once the policy lands, the form holds its numbers and Save is live', async () => {
    getTaskPolicy.mockResolvedValue({ ...DEFAULT_WORK_TASK_POLICY, handoffSeconds: 45, overrideLocationIds: [] });
    renderAs('HR_ADMINISTRATOR', <TaskPolicyPage />, '/admin/task-policy');
    const handoff = await screen.findByLabelText('Seconds before a person takes over');
    await waitFor(() => expect(handoff).toHaveValue(45));
    expect(screen.getByRole('button', { name: 'Save policy' })).toBeEnabled();
  });
});
