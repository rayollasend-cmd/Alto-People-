import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Hugo works for you, outside the panel: the badge on his button (and the
 * phone launcher that stays in reach while something needs the person),
 * the home seat's "Hugo noticed", and Settings' switch per kind of note.
 */

const getHugoSummary = vi.fn();
const listHugoNotes = vi.fn();
const acceptHugoNote = vi.fn();
const dismissHugoNote = vi.fn();
const getHugoNoteSettings = vi.fn();
const setHugoNoteKind = vi.fn();
vi.mock('@/lib/hugoApi', () => ({
  getHugo: vi.fn(async () => ({
    name: 'Hugo',
    audience: 'associate',
    intro: "I'm Hugo, the AI assistant. I'm not a person.",
    can: [{ key: 'TASK_TELL_ME_WHEN', label: 'Tell me when…', example: 'Tell me when I get paid' }],
    model: false,
  })),
  askHugo: vi.fn(),
  getHugoSummary: () => getHugoSummary(),
  listHugoNotes: () => listHugoNotes(),
  acceptHugoNote: (...a: unknown[]) => acceptHugoNote(...a),
  dismissHugoNote: (...a: unknown[]) => dismissHugoNote(...a),
  getHugoNoteSettings: () => getHugoNoteSettings(),
  setHugoNoteKind: (...a: unknown[]) => setHugoNoteKind(...a),
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { id: 'u1', role: 'ASSOCIATE', email: 'a@example.com', associateId: 'a1' }, can: () => false }),
}));
const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { error: (...a: unknown[]) => toastError(...a), success: vi.fn() } }));

import { AssistantProvider, useAssistant } from '@/lib/assistantContext';
import { HugoLauncher } from '@/components/assistant/HugoLauncher';
import { HugoSeat } from '@/components/home/HugoSeat';
import { HugoNotesCard } from '@/components/settings/HugoNotesCard';

const N1 = '22222222-2222-4222-8222-222222222222';
const note = {
  id: N1,
  kind: 'DIRECT_DEPOSIT_MISSING',
  status: 'NEW',
  data: { payday: '2026-10-30' },
  action: { kind: 'link', url: '/payroll#payout-method' },
  createdAt: new Date().toISOString(),
};

function TabProbe() {
  const { open, tab } = useAssistant();
  return <span data-testid="probe">{`${open}:${tab}`}</span>;
}

function mount(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/']}>
        <AssistantProvider>
          {ui}
          <TabProbe />
        </AssistantProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  for (const f of [getHugoSummary, listHugoNotes, acceptHugoNote, dismissHugoNote, getHugoNoteSettings, setHugoNoteKind, toastError]) f.mockReset();
  getHugoSummary.mockResolvedValue({ working: 0, needsYou: 0, unseenDone: 0, newNotes: 0 });
  listHugoNotes.mockResolvedValue({ notes: [] });
});

describe('the badge', () => {
  it('counts what needs the person, finished unseen and was noticed — and says so to a screen reader', async () => {
    getHugoSummary.mockResolvedValue({ working: 1, needsYou: 1, unseenDone: 1, newNotes: 1 });
    mount(<HugoLauncher />);
    const badge = await screen.findByTestId('hugo-badge');
    expect(badge).toHaveTextContent('3');
    expect(screen.getByTestId('hugo-launcher')).toHaveAccessibleName('Ask Hugo, 3 new from Hugo');
  });

  it('shows nothing when there is nothing', async () => {
    mount(<HugoLauncher />);
    await screen.findByTestId('hugo-launcher');
    await waitFor(() => expect(getHugoSummary).toHaveBeenCalled());
    expect(screen.queryByTestId('hugo-badge')).toBeNull();
  });
});

describe('the home seat', () => {
  it('shows what Hugo noticed, and the tasks waiting on the person one tap away', async () => {
    getHugoSummary.mockResolvedValue({ working: 0, needsYou: 2, unseenDone: 0, newNotes: 1 });
    listHugoNotes.mockResolvedValue({ notes: [note] });
    dismissHugoNote.mockResolvedValue({ note: { ...note, status: 'DISMISSED' } });
    mount(<HugoSeat />);
    expect(await screen.findByText('Hugo noticed')).toBeInTheDocument();
    const card = screen.getByRole('article', { name: /^Add direct deposit before/ });
    expect(card).toHaveTextContent('There’s no bank account on file for your first paycheck yet.');
    fireEvent.click(screen.getAllByRole('button', { name: /^Not now:/ })[0]!);
    await waitFor(() => expect(dismissHugoNote).toHaveBeenCalledWith(N1));

    fireEvent.click(screen.getByRole('button', { name: /2 tasks need you/ }));
    expect(screen.getByTestId('probe')).toHaveTextContent('true:tasks');
  });
});

describe('Settings › what Hugo notices', () => {
  it('turns a kind off at once, and puts it back when the save fails', async () => {
    getHugoNoteSettings.mockResolvedValue({
      kinds: [
        { kind: 'CREDENTIAL_EXPIRING', on: true },
        { kind: 'OPEN_SHIFT_MATCH', on: true },
        { kind: 'DIRECT_DEPOSIT_MISSING', on: true },
      ],
    });
    setHugoNoteKind.mockResolvedValueOnce({
      kinds: [
        { kind: 'CREDENTIAL_EXPIRING', on: true },
        { kind: 'OPEN_SHIFT_MATCH', on: false },
        { kind: 'DIRECT_DEPOSIT_MISSING', on: true },
      ],
    });
    mount(<HugoNotesCard />);
    expect(await screen.findByText('What Hugo notices for you')).toBeInTheDocument();
    const shifts = screen.getByRole('switch', { name: 'Open shifts that fit your availability' });
    expect(shifts).toBeChecked();
    fireEvent.click(shifts);
    await waitFor(() => expect(setHugoNoteKind).toHaveBeenCalledWith('OPEN_SHIFT_MATCH', false));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Open shifts that fit your availability' })).not.toBeChecked());

    setHugoNoteKind.mockRejectedValueOnce(new Error('down'));
    fireEvent.click(screen.getByRole('switch', { name: 'Documents and credentials running out' }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('That didn’t save. Try again.'));
    expect(screen.getByRole('switch', { name: 'Documents and credentials running out' })).toBeChecked();
  });
});
