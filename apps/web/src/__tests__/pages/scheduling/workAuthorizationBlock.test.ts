import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import { WorkAuthDeclined, askWorkAuthOverride, bulkSkipReasonWords, isNotAuthorizedToWork, withWorkAuthOverride } from '@/pages/scheduling/workAuthorizationBlock';

/**
 * Cleared to work, the scheduling side (owner, 2026-11-03): a scheduler
 * without manage:compliance is shown the server's "Ask HR" message; HR gets
 * "Assign anyway" and must give a reason of 10+ characters.
 */

const refusal = (canOverride: boolean) =>
  new ApiError(409, 'not_authorized_to_work', "Maria Worker's work authorization ended on Nov 3, 2026. Record the re-verification on the I-9 first.", {
    associateId: 'a',
    blockers: [],
    canOverride,
  });

describe('askWorkAuthOverride', () => {
  it('is not offered to someone without manage:compliance', async () => {
    const prompt = vi.fn();
    expect(await askWorkAuthOverride(refusal(false), { prompt, canOverride: false }, 'Maria')).toBe('not_allowed');
    expect(await askWorkAuthOverride(refusal(true), undefined, 'Maria')).toBe('not_allowed');
    expect(prompt).not.toHaveBeenCalled();
  });

  it('asks HR for a reason, and asks again when it is too short', async () => {
    const prompt = vi.fn().mockResolvedValueOnce('ok').mockResolvedValueOnce('  EAD receipt notice on file  ');
    const answer = await askWorkAuthOverride(refusal(true), { prompt, canOverride: true }, 'Maria');
    expect(answer).toEqual({ reason: 'EAD receipt notice on file' });
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(prompt.mock.calls[0]![0]).toMatchObject({ confirmLabel: 'Assign anyway', destructive: true });
    expect(prompt.mock.calls[1]![0].description).toContain('at least 10 characters');
  });

  it('a declined prompt assigns nothing', async () => {
    const prompt = vi.fn().mockResolvedValue(null);
    expect(await askWorkAuthOverride(refusal(true), { prompt, canOverride: true }, 'Maria')).toBeNull();
  });
});

describe('withWorkAuthOverride: "Approve anyway" on a pickup or a swap', () => {
  it('runs the approval again with HR\'s reason', async () => {
    const run = vi.fn().mockRejectedValueOnce(refusal(true)).mockResolvedValueOnce('ok');
    const prompt = vi.fn().mockResolvedValue('Receipt notice on file');
    await expect(withWorkAuthOverride(run, { prompt, canOverride: true }, 'Maria')).resolves.toBe('ok');
    expect(run).toHaveBeenLastCalledWith({ reason: 'Receipt notice on file' });
    expect(prompt.mock.calls[0]![0]).toMatchObject({ confirmLabel: 'Approve anyway' });
  });

  it('a declined prompt throws WorkAuthDeclined; a scheduler without the capability gets the server error', async () => {
    const prompt = vi.fn().mockResolvedValue(null);
    await expect(withWorkAuthOverride(vi.fn().mockRejectedValue(refusal(true)), { prompt, canOverride: true })).rejects.toBeInstanceOf(WorkAuthDeclined);
    const err = refusal(false);
    await expect(withWorkAuthOverride(vi.fn().mockRejectedValue(err), { prompt, canOverride: false })).rejects.toBe(err);
  });
});

describe('the bulk create skips and the refusal code', () => {
  it('reads each reason in words', () => {
    expect(bulkSkipReasonWords('not_authorized_to_work')).toBe('not cleared to work that day');
    expect(bulkSkipReasonWords('already_scheduled')).toBe('already scheduled then');
    expect(bulkSkipReasonWords('something_new')).toBe('something new');
    expect(isNotAuthorizedToWork(refusal(true))).toBe(true);
    expect(isNotAuthorizedToWork(new ApiError(409, 'rest_gap', 'x'))).toBe(false);
  });
});
