import { describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { RouteAnnouncer } from '@/components/RouteAnnouncer';
import { PageTitleProvider, usePublishPageTitle } from '@/lib/pageTitle';

function Page({ title, linkTo }: { title: string; linkTo?: string }) {
  usePublishPageTitle(title);
  return (
    <div>
      <h1>{title}</h1>
      {linkTo && <Link to={linkTo}>go</Link>}
    </div>
  );
}

function App({ initialPath = '/' }: { initialPath?: string }) {
  return (
    <MemoryRouter initialEntries={[initialPath]}>
      <PageTitleProvider>
        <RouteAnnouncer />
        <Routes>
          <Route path="/" element={<Page title="Dashboard" linkTo="/time" />} />
          <Route path="/time" element={<Page title="Time & Attendance" />} />
        </Routes>
      </PageTitleProvider>
    </MemoryRouter>
  );
}

describe('<RouteAnnouncer>', () => {
  it('keeps document.title in sync with the published page title', () => {
    render(<App />);
    expect(document.title).toBe('Dashboard · Alto People');
  });

  it('announces the new page through the live region after navigation', async () => {
    const user = userEvent.setup();
    render(<App />);

    const region = screen.getByRole('status');
    // Initial load is NOT announced — screen readers already read the
    // document title on page load.
    expect(region).toHaveTextContent('');

    await user.click(screen.getByRole('link', { name: 'go' }));
    expect(document.title).toBe('Time & Attendance · Alto People');

    // The announcement waits ~250ms for the incoming page to publish
    // its title before speaking.
    await act(
      () => new Promise((resolve) => setTimeout(resolve, 350)),
    );
    expect(region).toHaveTextContent('Time & Attendance');
  });
});
