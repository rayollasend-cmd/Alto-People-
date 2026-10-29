import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ROLE_CAPABILITIES, type Capability, type Role } from '@alto-people/shared';
import { ApiError, NetworkError, TimeoutError } from '@/lib/api';
import { AuthContext } from '@/lib/auth';
import { NoAccess } from '@/components/ui/NoAccess';
import { QueryError, queryErrorKind } from '@/components/ui/QueryError';

/**
 * A failed fetch says what happened in the reader's words — never the
 * server's "Missing capability: view:org" or "Request failed (500)".
 */

function renderAs(role: Role, ui: React.ReactElement) {
  const caps = ROLE_CAPABILITIES[role];
  return render(
    <AuthContext.Provider
      value={{
        isInitializing: false,
        isOffline: false,
        user: { id: 'u', email: 'x@example.com', role, status: 'ACTIVE', clientId: null, associateId: null },
        role,
        capabilities: new Set<Capability>(caps),
        signIn: vi.fn(),
        signOut: vi.fn(),
        can: (c: Capability) => caps.has(c),
      }}
    >
      <MemoryRouter>{ui}</MemoryRouter>
    </AuthContext.Provider>,
  );
}

const query = (error: unknown) => ({ error, refetch: vi.fn(), isFetching: false });

describe('queryErrorKind', () => {
  it('sorts a failure by what it means for the reader', () => {
    expect(queryErrorKind(new ApiError(403, 'forbidden', 'Missing capability: view:org'))).toBe('access');
    expect(queryErrorKind(new ApiError(401, 'unauthorized', 'x'))).toBe('access');
    expect(queryErrorKind(new ApiError(404, 'not_found', 'x'))).toBe('notFound');
    expect(queryErrorKind(new ApiError(500, 'internal', 'Request failed (500)'))).toBe('server');
    expect(queryErrorKind(new ApiError(409, 'conflict', 'Pick a store in your region.'))).toBe('rule');
    expect(queryErrorKind(new NetworkError(new Error('x')))).toBe('offline');
    expect(queryErrorKind(new TimeoutError())).toBe('offline');
    expect(queryErrorKind(new Error('boom'))).toBe('server');
  });
});

describe('<QueryError>', () => {
  it('403: “You don’t have access”, who to ask, the way home — no Retry, no server text', () => {
    renderAs('ASSOCIATE', <QueryError what="the expirations" query={query(new ApiError(403, 'forbidden', 'Missing capability: view:org'))} />);
    expect(screen.getByText(/You don’t have access to the expirations\./)).toBeInTheDocument();
    expect(screen.getByText(/ask your supervisor or HR/)).toBeInTheDocument();
    expect(screen.queryByText(/Missing capability/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go home' })).toHaveAttribute('href', '/');
  });

  it('a staff account is told to ask an administrator', () => {
    renderAs('OPERATIONS_MANAGER', <QueryError what="the agents" query={query(new ApiError(403, 'forbidden', 'nope'))} />);
    expect(screen.getByText(/ask an administrator in your organization/)).toBeInTheDocument();
  });

  it('404: it may have gone — no Retry', () => {
    renderAs('HR_ADMINISTRATOR', <QueryError what="this case" query={query(new ApiError(404, 'not_found', 'Case not found'))} />);
    expect(screen.getByText(/Couldn’t find this case\. It may have been removed/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('5xx: “something went wrong on our side” with Retry, and the reference tucked away for support', async () => {
    const q = query(new ApiError(500, 'internal', 'Request failed (500)', undefined, 'req-123'));
    renderAs('HR_ADMINISTRATOR', <QueryError what="the trust center" query={q} />);
    expect(screen.getByText(/Couldn’t load the trust center\./)).toBeInTheDocument();
    expect(screen.getByText(/Something went wrong on our side/)).toBeInTheDocument();
    expect(screen.queryByText(/Request failed/)).not.toBeInTheDocument();
    expect(screen.getByText('Reference: req-123')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(q.refetch).toHaveBeenCalledTimes(1);
  });

  it('offline: says the server could not be reached, with Retry', () => {
    renderAs('HR_ADMINISTRATOR', <QueryError what="today's rides" query={query(new NetworkError(new Error('x')))} />);
    expect(screen.getByText(/couldn’t reach the server/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('a rule the request broke (4xx) keeps the API’s own sentence — it is written for people', () => {
    renderAs('CLIENT_PORTAL', <QueryError what="your store view" query={query(new ApiError(400, 'bad_request', 'Pick a store in your region.'))} />);
    expect(screen.getByText(/Couldn’t load your store view\. Pick a store in your region\./)).toBeInTheDocument();
  });
});

describe('a capability string never reaches the screen (deep audit 2026-10-29, CRAWL-11)', () => {
  it('ApiError turns the API’s “Missing capability: …” into plain words and keeps the capability for logic', () => {
    const one = new ApiError(403, 'forbidden', 'Missing capability: view:recruiting');
    expect(one.message).toBe('You don’t have access to this.');
    expect(one.capability).toBe('view:recruiting');
    const any = new ApiError(403, 'forbidden', 'Missing capability: one of manage:scheduling, view:executive, process:payroll');
    expect(any.message).not.toMatch(/capabilit|manage:|view:/);
    expect(any.capability).toBe('manage:scheduling, view:executive, process:payroll');
    // Any other sentence is the API's own, written for people: untouched.
    const rule = new ApiError(403, 'forbidden', 'Call-outs are for the people who lead the floor.');
    expect(rule.message).toBe('Call-outs are for the people who lead the floor.');
    expect(rule.capability).toBeUndefined();
  });

  it('no kind of failure renders “view:” / “manage:” or the words “Missing capability”', () => {
    const errors = [
      new ApiError(403, 'forbidden', 'Missing capability: view:org'),
      new ApiError(401, 'unauthorized', 'Missing capability: view:org'),
      new ApiError(404, 'not_found', 'Missing capability: view:org'),
      new ApiError(409, 'conflict', 'Missing capability: manage:scheduling'),
      new ApiError(500, 'internal', 'Missing capability: process:payroll'),
    ];
    for (const err of errors) {
      const { container, unmount } = renderAs('DRIVER', <QueryError what="the list" query={query(err)} />);
      expect(container.textContent, `status ${err.status}`).not.toMatch(/missing capabilit|\b(view|manage|process):[a-z-]+/i);
      unmount();
    }
  });

  it('access="hide": a refused part of a page renders nothing (no warning, no Retry)', () => {
    const { container } = renderAs('DRIVER', <QueryError access="hide" what="the payout rail" query={query(new ApiError(403, 'forbidden', 'Missing capability: process:payroll'))} />);
    expect(container).toBeEmptyDOMElement();
    // …and anything else still says what happened.
    renderAs('DRIVER', <QueryError access="hide" what="the payout rail" query={query(new ApiError(500, 'internal', 'x'))} />);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});

describe('<NoAccess>', () => {
  it('the access page: what happened, who can change it, the way home', () => {
    renderAs('CLIENT_PORTAL', <NoAccess />);
    expect(screen.getByRole('heading', { level: 1, name: 'You don’t have access to this page' })).toBeInTheDocument();
    expect(screen.getByText(/ask your staffing contact/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go home' })).toHaveAttribute('href', '/');
  });
});
