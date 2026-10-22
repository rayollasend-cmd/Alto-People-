import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { PageTitleProvider, usePublishPageTitle } from '@/lib/pageTitle';
import { renderAs } from '../pages/hrPack/harness';

/**
 * One breadcrumb. A page that names itself (RecordTemplate, PageHeader and
 * so ListTemplate) keeps the top bar quiet at rest; the bar's compact trail
 * arrives only once the page's heading has scrolled under it. The client
 * page used to show "Clients › Coastal Resort Holdings" twice, forty pixels
 * apart. A page with no header of its own keeps its name in the bar.
 */

vi.mock('@/lib/communicationsApi', () => ({
  listMyInbox: vi.fn(async () => ({ notifications: [], total: 0 })),
  markAllRead: vi.fn(),
  markAllSeen: vi.fn(),
  markRead: vi.fn(),
}));
vi.mock('@/lib/storeScope', async (orig) => ({
  ...(await orig<typeof import('@/lib/storeScope')>()),
  useStoreScope: () => ({ enabled: false, ready: true, clients: [], clientId: '', setClientId: vi.fn() }),
}));

import { Topbar } from '@/components/Topbar';
import { RecordTemplate } from '@/components/templates/RecordTemplate';
import { PageHeader } from '@/components/ui/PageHeader';

let observed: Array<{ el: Element; fire: (isIntersecting: boolean) => void }> = [];
class FakeIO {
  constructor(private cb: IntersectionObserverCallback) {}
  observe(el: Element) {
    observed.push({ el, fire: (isIntersecting) => this.cb([{ isIntersecting, target: el } as IntersectionObserverEntry], this as never) });
  }
  disconnect() {
    observed = [];
  }
  unobserve() {}
  takeRecords() {
    return [];
  }
}

beforeEach(() => {
  observed = [];
  vi.stubGlobal('IntersectionObserver', FakeIO);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const CLIENT_CRUMBS = [{ label: 'Clients', to: '/clients' }, { label: 'Coastal Resort Holdings' }];

function ClientPage({ nested = false }: { nested?: boolean }) {
  return (
    <RecordTemplate
      breadcrumbs={CLIENT_CRUMBS}
      title="Coastal Resort Holdings"
      tabs={[{ key: 'overview', label: 'Overview', content: nested ? <PageHeader title="Inner section" /> : <p>Numbers</p> }]}
    />
  );
}

function shell(page: React.ReactNode) {
  return renderAs(
    'HR_ADMINISTRATOR',
    <PageTitleProvider>
      <TooltipProvider>
        <Topbar onOpenCommandPalette={vi.fn()} onOpenHelp={vi.fn()} />
        <main>{page}</main>
      </TooltipProvider>
    </PageTitleProvider>,
    '/clients/c1',
  );
}

/** The top bar's title block (the trail lives inside it). */
const barTitle = () => screen.getByTestId('topbar-title');

describe('the top bar title on a page that names itself', () => {
  it('a client record: one breadcrumb at rest, the bar’s trail only after the heading scrolls away', () => {
    shell(<ClientPage />);
    // The record's heading is what the shell watches.
    expect(observed).toHaveLength(1);
    expect(observed[0]!.el.tagName).toBe('H1');
    expect(observed[0]!.el).toHaveTextContent('Coastal Resort Holdings');

    // At rest: the page's heading is on screen.
    act(() => observed[0]!.fire(true));
    expect(screen.getAllByRole('navigation', { name: 'Breadcrumb' })).toHaveLength(1);
    // The h1 and the bar's (hidden) copy — the page's trail stops at its parent ("Clients"),
    // since the record's own name is the heading right under it.
    expect(screen.getAllByText('Coastal Resort Holdings')).toHaveLength(2);
    expect(barTitle()).toHaveAttribute('aria-hidden', 'true');
    expect(barTitle()).toHaveAttribute('inert');
    expect(barTitle().className).toContain('opacity-0');

    // Scrolled: the heading slid under the bar, which now carries the trail.
    act(() => observed[0]!.fire(false));
    expect(screen.getAllByRole('navigation', { name: 'Breadcrumb' })).toHaveLength(2);
    expect(barTitle()).not.toHaveAttribute('aria-hidden', 'true');
    expect(barTitle().className).toContain('opacity-100');

    // And back up: quiet again.
    act(() => observed[0]!.fire(true));
    expect(screen.getAllByRole('navigation', { name: 'Breadcrumb' })).toHaveLength(1);
  });

  it('is quiet from the first paint: the heading is measured before the observer answers', () => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      return { top: 120, bottom: 170, left: 0, right: 600, width: 600, height: 50, x: 0, y: 120, toJSON() {} } as DOMRect;
    });
    shell(<ClientPage />);
    // No observer callback yet — and still only the page's own breadcrumb.
    expect(screen.getAllByRole('navigation', { name: 'Breadcrumb' })).toHaveLength(1);
    expect(barTitle()).toHaveAttribute('aria-hidden', 'true');
  });

  it('the page’s own heading wins over one nested inside it', () => {
    shell(<ClientPage nested />);
    expect(observed).toHaveLength(1);
    expect(observed[0]!.el).toHaveTextContent('Coastal Resort Holdings');
  });

  it('a list page (PageHeader) hands off the same way', () => {
    shell(<PageHeader title="Pipeline" breadcrumbs={[{ label: 'Clients', to: '/clients' }, { label: 'Pipeline' }]} />);
    act(() => observed[0]!.fire(true));
    expect(screen.getAllByRole('navigation', { name: 'Breadcrumb' })).toHaveLength(1);
    act(() => observed[0]!.fire(false));
    expect(screen.getAllByRole('navigation', { name: 'Breadcrumb' })).toHaveLength(2);
  });
});

describe('a page without a header of its own', () => {
  function TitleOnly() {
    usePublishPageTitle('My checklist');
    return <p>Tasks</p>;
  }

  it('keeps its name in the bar at rest', () => {
    shell(<TitleOnly />);
    expect(observed).toHaveLength(0);
    expect(screen.getByRole('heading', { name: 'My checklist' })).toBeInTheDocument();
    expect(barTitle()).not.toHaveAttribute('aria-hidden', 'true');
  });
});
