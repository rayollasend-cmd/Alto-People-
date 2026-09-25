import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { secondsUntil, undoWindowToast } from '@/lib/undoToast';

type Action = { label: string; onClick: () => void };
const lastAction = () => (vi.mocked(toast.success).mock.calls.at(-1)![1] as { action: Action; duration: number });

/**
 * The server has already sent the invite or made the hire, but holds the
 * email until `dueAt`. The toast is the window to take it back in.
 */
describe('undoWindowToast', () => {
  beforeEach(() => {
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
  });

  it('stays up as long as the email is held', () => {
    const dueAt = new Date(Date.now() + 20_000).toISOString();
    undoWindowToast({ message: 'Invite goes out in 20 seconds.', dueAt, onUndo: async () => 'Undone.' });
    const opts = lastAction();
    expect(opts.duration).toBeGreaterThan(18_000);
    expect(opts.duration).toBeLessThanOrEqual(20_000);
    expect(opts.action.label).toBe('Undo');
    expect(secondsUntil(dueAt)).toBe(20);
  });

  it('Undo says what it undid', async () => {
    const onUndo = vi.fn(async () => 'Undone — nothing was sent to Dana.');
    undoWindowToast({ message: 'x', dueAt: new Date(Date.now() + 20_000).toISOString(), onUndo });
    lastAction().action.onClick();
    await vi.waitFor(() => expect(toast.success).toHaveBeenLastCalledWith('Undone — nothing was sent to Dana.'));
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it('too late, it says so in the server’s words', async () => {
    const onUndo = vi.fn(async (): Promise<string> => {
      throw new ApiError(409, 'already_started', 'Dana has already signed paperwork.');
    });
    undoWindowToast({ message: 'x', dueAt: new Date(Date.now() + 20_000).toISOString(), onUndo });
    lastAction().action.onClick();
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalledWith('Dana has already signed paperwork.'));
  });
});
