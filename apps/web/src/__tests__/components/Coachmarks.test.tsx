import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext } from '@/lib/auth';
import { I18nProvider } from '@/lib/i18n';
import { Coachmarks, setCoachmarksArmDelayForTests } from '@/components/Coachmarks';
import { TOURS } from '@/lib/tours';

function renderShell(path = '/') {
  const auth = {
    isInitializing: false,
    isOffline: false,
    user: { id: 'u1', email: 'x@y.z', role: 'HR_ADMINISTRATOR', status: 'ACTIVE', clientId: null, associateId: null },
    role: 'HR_ADMINISTRATOR',
    capabilities: new Set(),
    signIn: vi.fn(),
    signOut: vi.fn(),
    can: () => true,
  };
  return render(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    <AuthContext.Provider value={auth as any}>
      <I18nProvider>
        <MemoryRouter initialEntries={[path]}>
          <button data-tour="search">search</button>
          <nav data-tour="nav">nav</nav>
          <span data-tour="bell">bell</span>
          <button data-tour="help">help</button>
          <Coachmarks />
        </MemoryRouter>
      </I18nProvider>
    </AuthContext.Provider>,
  );
}

describe('coach marks', () => {
  beforeAll(() => {
    setCoachmarksArmDelayForTests(0);
    // jsdom gives every element a zero rect; the tour treats that as "not
    // on screen", so give the anchors a size.
    Element.prototype.getBoundingClientRect = function () {
      return { top: 10, left: 10, bottom: 40, right: 110, width: 100, height: 30, x: 10, y: 10, toJSON: () => ({}) } as DOMRect;
    };
  });
  beforeEach(() => window.localStorage.clear());

  it('every tour step has both languages', () => {
    for (const tour of TOURS) {
      for (const s of tour.steps) {
        expect(s.en.title).toBeTruthy();
        expect(s.es.title).toBeTruthy();
        expect(s.es.body).not.toBe(s.en.body);
      }
    }
  });

  it('walks the steps once and then stays quiet for that person', async () => {
    renderShell();
    expect(await screen.findByRole('dialog', { name: 'Jump anywhere' })).toBeInTheDocument();
    expect(screen.getByText('1 / 4')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('dialog', { name: 'Your modules' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('dialog', { name: 'Jump anywhere' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(window.localStorage.getItem('alto.tour.shell-v1.u1')).toBeTruthy();

    renderShell();
    await new Promise((r) => setTimeout(r, 30));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('does not run on a route without a tour', async () => {
    renderShell('/people');
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
