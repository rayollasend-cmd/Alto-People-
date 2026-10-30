import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { HugoMemoryListResponse, HugoMemoryView as Fact } from '@alto-people/shared';
import { ApiError } from '@/lib/api';

/**
 * What Hugo knows, in the app: the view (grouped by kind; edit, remove, add,
 * the switch and its sentence, forget everything only after a confirm; the
 * guard said as the person types), and the chip under an answer that kept
 * something ("Saved to what Hugo knows · Undo"), which opens the view.
 */

const fact = (id: string, text: string, kind: Fact['kind'], source: Fact['source'] = 'TOLD'): Fact => ({
  id,
  text,
  kind,
  source,
  createdAt: '2026-10-20T15:00:00.000Z',
  updatedAt: '2026-10-20T15:00:00.000Z',
  lastUsedAt: null,
});

const api = vi.hoisted(() => ({
  getHugo: vi.fn(async () => ({ name: 'Hugo', audience: 'associate', intro: 'I’m your assistant.', can: [], model: true })),
  askHugo: vi.fn(),
  getHugoMemory: vi.fn(),
  addHugoMemory: vi.fn(),
  editHugoMemory: vi.fn(),
  removeHugoMemory: vi.fn(),
  forgetAllHugoMemory: vi.fn(),
  setHugoMemoryOn: vi.fn(),
}));
vi.mock('@/lib/hugoApi', () => ({
  getHugoSummary: vi.fn(async () => ({ working: 0, needsYou: 0, unseenDone: 0, newNotes: 0 })),
  listHugoTasks: vi.fn(async () => ({ tasks: [] })),
  listHugoNotes: vi.fn(async () => ({ notes: [] })),
  markHugoSeen: vi.fn(async () => ({ tasks: 0, notes: 0 })),
  handoffToPerson: vi.fn(),
  decideAssistantAction: vi.fn(),
  ...api,
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { id: 'u1', role: 'ASSOCIATE', email: 'a@example.com', firstName: 'Ana' }, can: () => true }),
}));

import { AssistantProvider, useAssistant } from '@/lib/assistantContext';
import { AssistantPane } from '@/components/assistant/AssistantPane';
import { HugoMemoryView } from '@/components/assistant/HugoMemoryView';

let data: HugoMemoryListResponse;
beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset();
  data = {
    memoryOn: true,
    max: 50,
    facts: [fact('f1', 'I prefer morning shifts', 'PREFERENCE'), fact('f2', 'I take the van from Main St', 'TRAVEL', 'ADDED'), fact('f3', 'I like short answers', 'PREFERENCE')],
  };
  api.getHugoMemory.mockImplementation(async () => data);
  window.sessionStorage.clear();
});

function mountView(onClose = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <HugoMemoryView name="Hugo" hugo={false} onClose={onClose} />
    </QueryClientProvider>,
  );
  return { onClose };
}

describe('<HugoMemoryView>', () => {
  it('lists every fact, grouped by what it is about, with who put it there', async () => {
    mountView();
    await screen.findByText('I prefer morning shifts');
    const prefs = screen.getByRole('region', { name: 'Preferences' });
    expect(within(prefs).getAllByTestId('hugo-memory-fact').map((li) => li.querySelector('p')!.textContent)).toEqual(['I prefer morning shifts', 'I like short answers']);
    const travel = screen.getByRole('region', { name: 'Getting to work' });
    expect(within(travel).getByText(/You added this/)).toBeInTheDocument();
    expect(within(prefs).getAllByText(/You told Hugo/)).toHaveLength(2);
    expect(screen.getByTestId('hugo-memory-count')).toHaveTextContent('3 of 50');
    expect(screen.getByRole('heading', { name: 'What Hugo knows' })).toBeInTheDocument();
  });

  it('edits one in place and removes another, by their labelled buttons', async () => {
    api.editHugoMemory.mockImplementation(async (id: string, patch: { text: string; kind: Fact['kind'] }) => ({ fact: fact(id, patch.text, patch.kind) }));
    api.removeHugoMemory.mockResolvedValue({ ok: true });
    mountView();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit: I prefer morning shifts' }));
    const box = screen.getByLabelText('Something about you');
    expect(box).toHaveValue('I prefer morning shifts');
    fireEvent.change(box, { target: { value: 'I prefer night shifts' } });
    fireEvent.click(screen.getByRole('radio', { name: 'When you can work' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.editHugoMemory).toHaveBeenCalledWith('f1', { text: 'I prefer night shifts', kind: 'AVAILABILITY' }));
    await screen.findByRole('region', { name: 'When you can work' });

    fireEvent.click(screen.getByRole('button', { name: 'Remove: I take the van from Main St' }));
    await waitFor(() => expect(api.removeHugoMemory).toHaveBeenCalledWith('f2'));
    await waitFor(() => expect(screen.queryByText('I take the van from Main St')).toBeNull());
  });

  it('adds one; the guard says no as they type, and the server’s refusal is worded too', async () => {
    api.addHugoMemory.mockImplementation(async (text: string, kind: Fact['kind']) => ({ fact: fact('f9', text, kind, 'ADDED'), existing: false }));
    mountView();
    fireEvent.click(await screen.findByTestId('hugo-memory-add'));
    const box = screen.getByLabelText('Something about you');
    fireEvent.change(box, { target: { value: 'Estoy embarazada' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Health details are never kept');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(box).toHaveAttribute('aria-invalid', 'true');

    fireEvent.change(box, { target: { value: 'I like the 6:10 van' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Getting to work' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.addHugoMemory).toHaveBeenCalledWith('I like the 6:10 van', 'TRAVEL'));
    await screen.findByText('I like the 6:10 van');

    api.addHugoMemory.mockRejectedValueOnce(new ApiError(422, 'memory_refused', 'no', { reason: 'FULL' }));
    fireEvent.click(screen.getByTestId('hugo-memory-add'));
    fireEvent.change(screen.getByLabelText('Something about you'), { target: { value: 'One more' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('50 things can be kept — remove one to add more.')).toBeInTheDocument();
  });

  it('the switch says what it means, and off hides Add', async () => {
    api.setHugoMemoryOn.mockImplementation(async (on: boolean) => ({ memoryOn: on }));
    mountView();
    const sw = await screen.findByRole('switch', { name: 'Remember what I tell Hugo' });
    expect(sw).toBeChecked();
    expect(screen.getByText(/On: Hugo keeps short facts/)).toBeInTheDocument();
    fireEvent.click(sw);
    await waitFor(() => expect(api.setHugoMemoryOn).toHaveBeenCalledWith(false));
    expect(await screen.findByText(/Off: Hugo won’t keep or use any of this/)).toBeInTheDocument();
    expect(screen.queryByTestId('hugo-memory-add')).toBeNull();
    // What is kept stays visible and removable.
    expect(screen.getByRole('button', { name: 'Remove: I like short answers' })).toBeInTheDocument();
  });

  it('forget everything only after the confirmation', async () => {
    api.forgetAllHugoMemory.mockResolvedValue({ forgot: 3 });
    mountView();
    fireEvent.click(await screen.findByTestId('hugo-memory-forget-all'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Forget everything Hugo knows?');
    expect(dialog).toHaveTextContent('(3)');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.forgetAllHugoMemory).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('hugo-memory-forget-all'));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Forget everything' }));
    await waitFor(() => expect(api.forgetAllHugoMemory).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Nothing yet\. Tell Hugo/)).toBeInTheDocument();
  });

  it('Back and Escape go back to the chat', async () => {
    const { onClose } = mountView();
    fireEvent.click(await screen.findByRole('button', { name: 'Back to chat' }));
    fireEvent.keyDown(screen.getByTestId('hugo-memory'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

function Opener() {
  const { toggle } = useAssistant();
  return <button onClick={toggle}>spark</button>;
}

function mountPane() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/me']}>
        <AssistantProvider>
          <Opener />
          <AssistantPane />
        </AssistantProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function ask(text: string) {
  const input = await screen.findByLabelText(/ask hugo/i);
  fireEvent.change(input, { target: { value: text } });
  fireEvent.submit(input.closest('form')!);
}

describe('in the panel', () => {
  it('an answer that kept something carries the chip; Undo removes it and says so', async () => {
    api.askHugo.mockResolvedValue({ intent: 'MODEL', reply: 'Got it — mornings it is.', linkUrl: null, handoff: null, source: 'model', remembered: [{ id: 'f7', text: 'I prefer mornings' }], memoryFirst: true });
    api.removeHugoMemory.mockResolvedValue({ ok: true });
    mountPane();
    fireEvent.click(await screen.findByText('spark'));
    await ask('I prefer mornings, remember that');
    const chip = await screen.findByTestId('hugo-memory-chip');
    expect(chip).toHaveTextContent('Saved to what Hugo knows');
    fireEvent.click(within(chip).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(api.removeHugoMemory).toHaveBeenCalledWith('f7', 'undo'));
    await waitFor(() => expect(screen.getByTestId('hugo-memory-chip')).toHaveTextContent('Removed'));
    expect(within(screen.getByTestId('hugo-memory-chip')).queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('no chip on an answer that kept nothing', async () => {
    api.askHugo.mockResolvedValue({ intent: 'MODEL', reply: 'Tomorrow 6–2.', linkUrl: null, handoff: null, source: 'model' });
    mountPane();
    fireEvent.click(await screen.findByText('spark'));
    await ask('when do I work?');
    await screen.findByText('Tomorrow 6–2.');
    expect(screen.queryByTestId('hugo-memory-chip')).toBeNull();
  });

  it('opens What Hugo knows from the chip, the line under the greeting and the ⋯ menu; Escape there leaves the panel open', async () => {
    api.askHugo.mockResolvedValue({ intent: 'MODEL', reply: 'Noted.', linkUrl: null, handoff: null, source: 'model', remembered: [{ id: 'f1', text: 'I prefer morning shifts' }] });
    mountPane();
    fireEvent.click(await screen.findByText('spark'));
    // The line under the greeting.
    fireEvent.click(await screen.findByTestId('hugo-memory-peek'));
    expect(await screen.findByRole('heading', { name: 'What Hugo knows' })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByTestId('hugo-memory'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('hugo-memory')).toBeNull());
    expect(screen.getByTestId('assistant-pane')).toBeInTheDocument();

    // The chip's words.
    await ask('mornings please, remember');
    fireEvent.click(within(await screen.findByTestId('hugo-memory-chip')).getByRole('button', { name: 'Saved to what Hugo knows' }));
    await screen.findByTestId('hugo-memory');
    fireEvent.click(screen.getByRole('button', { name: 'Back to chat' }));
    await waitFor(() => expect(screen.queryByTestId('hugo-memory')).toBeNull());

    // The ⋯ menu.
    await userEvent.click(screen.getByRole('button', { name: 'More options' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'What Hugo knows' }));
    expect(await screen.findByText('I prefer morning shifts')).toBeInTheDocument();
  });

  it('a Hugo that answers without the model (an associate’s) offers no What Hugo knows: no line, no menu item', async () => {
    api.getHugo.mockResolvedValueOnce({ name: 'Hugo', audience: 'associate', intro: 'I’m your assistant.', can: [], model: false });
    mountPane();
    fireEvent.click(await screen.findByText('spark'));
    await screen.findByText('I’m your assistant.');
    expect(screen.queryByTestId('hugo-memory-peek')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'More options' }));
    await screen.findByRole('menuitem', { name: /start over/i });
    expect(screen.queryByRole('menuitem', { name: 'What Hugo knows' })).toBeNull();
  });
});
