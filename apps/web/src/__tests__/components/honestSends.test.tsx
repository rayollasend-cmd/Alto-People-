import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock('@/lib/floorApi', async (orig) => ({ ...(await orig<typeof import('@/lib/floorApi')>()), textCrew: vi.fn() }));

import { toast } from 'sonner';
import { textCrew } from '@/lib/floorApi';
import { CrewTextDialog } from '@/components/floor/CrewTextDialog';
import { deliveryLines } from '@/lib/dirCommsApi';

/**
 * Audit 2026-10-21 item 1: the product said "sent" for texts that never
 * left. The crew-text dialog and the broadcast log now say what happened.
 */

beforeEach(() => {
  vi.mocked(toast.error).mockReset();
  vi.mocked(toast.success).mockReset();
  vi.mocked(textCrew).mockReset();
});

function openDialog() {
  render(<CrewTextDialog open onOpenChange={() => undefined} shiftIds={['s1']} label="Morning" count={2} />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Side door today.' } });
  fireEvent.click(screen.getByRole('button', { name: /Send to 2/ }));
}

describe('CrewTextDialog', () => {
  it('says nothing was sent when texting is not connected — never "Sent to"', async () => {
    vi.mocked(textCrew).mockResolvedValue({ sent: 0, failed: 0, optedOut: 0, noPhone: [], notConfigured: 'Texting isn’t connected — set TWILIO_ACCOUNT_SID on the API to send texts.' });
    openDialog();
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(vi.mocked(toast.error).mock.calls[0]![0]).toMatch(/^Nothing was sent — Texting isn’t connected/);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('counts the sent, the opted out and the undeliverable', async () => {
    vi.mocked(textCrew).mockResolvedValue({ sent: 3, failed: 1, optedOut: 1, noPhone: ['Ben Ray'], notConfigured: null });
    openDialog();
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(vi.mocked(toast.success).mock.calls[0]![0]).toBe('Sent to 3. No phone on file: Ben Ray. 1 opted out of texts. 1 could not be delivered — see the communications log.');
  });
});

describe('deliveryLines (the broadcast sent log)', () => {
  it('names a channel with no provider as not connected, and counts the rest', () => {
    const lines = deliveryLines({
      channels: ['IN_APP', 'EMAIL', 'SMS'],
      counts: { IN_APP: { sent: 210, muted: 2 }, EMAIL: { sent: 200, failed: 3, held: 4 }, SMS: { not_configured: 150, no_phone: 60 } },
      notConfigured: { SMS: 'Texting isn’t connected.' },
      recipients: 212,
      finishedAt: '2026-10-21T10:00:00.000Z',
    });
    expect(lines).toEqual([
      { channel: 'IN_APP', text: 'In-app: 210 sent · 2 muted', problem: false },
      { channel: 'EMAIL', text: 'Email: 200 sent · 3 failed · 4 held for quiet hours', problem: false },
      { channel: 'SMS', text: 'Texts: not connected — nothing sent', problem: true },
    ]);
    expect(deliveryLines(null)).toEqual([]);
  });
});
