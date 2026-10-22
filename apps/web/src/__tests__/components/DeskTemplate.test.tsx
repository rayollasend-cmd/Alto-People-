import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { DeskTemplate, useDeskItem } from '@/components/templates';

/**
 * A desk never hides its own queue below lg (the control room hid its
 * exceptions on every tablet: it said an item was open as soon as data
 * loaded). The picked item lives in the URL, so refresh, a shared link and
 * the phone's Back keep it.
 */

const sectionOf = (name: 'Queue' | 'Open item') => screen.getByRole('region', { name });

describe('<DeskTemplate> below lg', () => {
  it('stack: the queue, then the companion panel — both shown, neither hidden', () => {
    render(
      <MemoryRouter>
        <DeskTemplate title="Control room" breadcrumbs={[]} queue={<p>Exceptions</p>} item={<p>Crew</p>} narrow="stack" itemOpen />
      </MemoryRouter>,
    );
    expect(sectionOf('Queue').className).not.toContain('hidden');
    expect(sectionOf('Open item').className).not.toContain('hidden');
  });

  it('pick: the queue is the screen until an item is open, then the item is', () => {
    const { rerender } = render(
      <MemoryRouter>
        <DeskTemplate title="Leave" breadcrumbs={[]} queue={<p>Cases</p>} item={<p>Pick a case</p>} />
      </MemoryRouter>,
    );
    expect(sectionOf('Queue').className).not.toContain('hidden lg:block');
    expect(sectionOf('Open item').className).toContain('hidden lg:block');
    rerender(
      <MemoryRouter>
        <DeskTemplate title="Leave" breadcrumbs={[]} queue={<p>Cases</p>} item={<p>Case 1</p>} itemOpen />
      </MemoryRouter>,
    );
    expect(sectionOf('Queue').className).toContain('hidden lg:block');
    expect(sectionOf('Open item').className).not.toContain('hidden lg:block');
  });

  it('with `itemParam`, the URL says whether an item is open — and the back control closes it', async () => {
    render(
      <MemoryRouter initialEntries={['/leave?case=c1']}>
        <DeskTemplate title="Leave" breadcrumbs={[]} queue={<p>Cases</p>} item={<p>Case 1</p>} itemParam="case" backLabel="All cases" />
      </MemoryRouter>,
    );
    expect(sectionOf('Queue').className).toContain('hidden lg:block');
    await userEvent.click(screen.getByRole('button', { name: 'All cases' }));
    expect(sectionOf('Queue').className).not.toContain('hidden lg:block');
  });

  it('a desk’s counts sit under its title, not among its actions', () => {
    render(
      <MemoryRouter>
        <DeskTemplate title="Approvals" breadcrumbs={[]} counts={<span>12 waiting</span>} queue={null} item={null} />
      </MemoryRouter>,
    );
    expect(screen.getByText('12 waiting').closest('[data-testid="page-actions"]')).toBeNull();
  });
});

function Probe() {
  const desk = useDeskItem('case');
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <div>
      <span data-testid="url">{location.pathname + location.search}</span>
      <button onClick={() => desk.open('a')}>open a</button>
      <button onClick={() => desk.open('b')}>open b</button>
      <button onClick={() => desk.close()}>close</button>
      <button onClick={() => navigate(-1)}>browser back</button>
    </div>
  );
}

describe('useDeskItem', () => {
  const url = () => screen.getByTestId('url').textContent;

  it('opening is a step (Back closes it); moving between items replaces; close steps back', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/desk']}>
        <Routes>
          <Route path="/desk" element={<Probe />} />
        </Routes>
      </MemoryRouter>,
    );
    await user.click(screen.getByText('open a'));
    expect(url()).toBe('/desk?case=a');
    await user.click(screen.getByText('open b'));
    expect(url()).toBe('/desk?case=b');
    // One Back leaves the item — not a replay of every item looked at.
    await user.click(screen.getByText('browser back'));
    expect(url()).toBe('/desk');

    await user.click(screen.getByText('open a'));
    await user.click(screen.getByText('close'));
    expect(url()).toBe('/desk');
  });

  it('a shared link straight to an item closes in place (no Back out of the app)', async () => {
    render(
      <MemoryRouter initialEntries={['/desk?case=z&tab=x']}>
        <Routes>
          <Route path="/desk" element={<Probe />} />
        </Routes>
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByText('close'));
    expect(url()).toBe('/desk?tab=x');
  });
});
