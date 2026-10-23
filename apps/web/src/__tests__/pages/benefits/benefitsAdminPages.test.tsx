import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router-dom';
import { renderAs } from '../hrPack/harness';
import type { Carrier } from '@/lib/deductionsApi';

const ded = vi.hoisted(() => ({ listCarriers: vi.fn(), list834: vi.fn(), saveCarrierConnection: vi.fn(), updateCarrier: vi.fn() }));
vi.mock('@/lib/deductionsApi', async (orig) => ({ ...(await orig<typeof import('@/lib/deductionsApi')>()), ...ded }));
const tax = vi.hoisted(() => ({ getAcaSummary: vi.fn(), listAcaWorkers: vi.fn(), syncAca1095c: vi.fn() }));
vi.mock('@/lib/taxcompApi', async (orig) => ({ ...(await orig<typeof import('@/lib/taxcompApi')>()), ...tax }));
const life = vi.hoisted(() => ({ listOpenEnrollment: vi.fn(), listQles: vi.fn(), listCobra: vi.fn(), get1095c: vi.fn(), generate1095cForms: vi.fn() }));
vi.mock('@/lib/benefitsLifecycle92Api', async (orig) => ({ ...(await orig<typeof import('@/lib/benefitsLifecycle92Api')>()), ...life }));

import { CarrierFeeds, deliveryResult, deliveryWords } from '@/pages/deductions/CarrierFeeds';
import { AcaHours } from '@/pages/benefits/AcaHours';
import { BenefitsLifecycle, firstPendingTab, lifecyclePending } from '@/pages/benefits/BenefitsLifecycle';

/**
 * The benefits back office (F500 G6): carrier feeds lead with how each feed
 * is doing and keep the setup in the edit dialog; ACA hours holds the whole
 * 1095-C filing; Lifecycle counts what waits on each tab and opens on it.
 */

const carrier = (o: Partial<Carrier> = {}): Carrier => ({
  id: 'k1',
  name: 'Blue Cross Blue Shield of Texas',
  receiverId: 'BCBSTX834',
  receiverQualifier: 'ZZ',
  senderId: 'ALTOHR',
  senderQualifier: 'ZZ',
  sponsorTaxId: null,
  policyNumber: 'GRP-118204',
  usageIndicator: 'T',
  transport: 'SFTP',
  connection: { host: null, username: null, remoteDir: null, baseUrl: null, hasSecret: false },
  active: true,
  plans: [{ id: 'p1', name: 'PPO 500', kind: 'HEALTH_MEDICAL', insuranceLineCode: 'HLT', carrierPlanCode: null }],
  lastFile: { createdAt: '2026-10-15T12:00:00.000Z', mode: 'CHANGE', status: 'FAILED' },
  health: { people: 2, changesWaiting: 1, lastFile: { createdAt: '2026-10-15T12:00:00.000Z', mode: 'CHANGE', status: 'FAILED', controlNumber: 12, memberCount: 2, sentAt: null, error: 'SFTP login refused' } },
  ...o,
});

/** A tile's settled value (its title), not the count-up frame on screen. */
const tileValue = (label: HTMLElement) => label.parentElement!.querySelector('[data-metric-value]')?.getAttribute('title');

function Where() {
  const l = useLocation();
  return <p data-testid="where">{l.pathname + l.search}</p>;
}

beforeEach(() => {
  for (const f of [...Object.values(ded), ...Object.values(tax), ...Object.values(life)]) f.mockReset();
  ded.list834.mockResolvedValue({ files: [] });
});

describe('<CarrierFeeds>', () => {
  it('leads with how the feed is doing — exact — and says acknowledgments aren’t tracked', async () => {
    ded.listCarriers.mockResolvedValue({ carriers: [carrier()], plans: [] });
    ded.list834.mockResolvedValue({ files: [{ id: 'f1', mode: 'CHANGE', controlNumber: 12, memberCount: 2, status: 'FAILED', error: 'SFTP login refused', sentAt: null, createdAt: '2026-10-15T12:00:00.000Z' }] });
    renderAs('FINANCE_ACCOUNTANT', <CarrierFeeds />, '/benefits/carriers');
    const strip = await screen.findByRole('group', { name: 'Feed health' });
    expect(tileValue(within(strip).getByText('People in the feed'))).toBe('2');
    expect(tileValue(within(strip).getByText('Waiting for the next file'))).toBe('1');
    expect(within(strip).getByText('Waiting for the next file').parentElement).toHaveTextContent('person changed since the last file');
    expect(within(strip).getByText('Last file').parentElement).toHaveTextContent('Oct 15, 2026');
    expect(within(strip).getByText('Last file').parentElement).toHaveTextContent('Changes · control 12 · 2 members');
    expect(within(strip).getByText('Delivery').parentElement).toHaveTextContent('Failed');
    expect(within(strip).getByText('Delivery').parentElement).toHaveTextContent('SFTP login refused');
    expect(screen.getByText(/acknowledgment \(999 or TA1\) isn’t received here/)).toBeInTheDocument();
    // "Enrollment file", not "834"; the receiver ID isn't in prime space.
    expect(await screen.findByRole('table', { name: 'Enrollment files' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download the enrollment file' })).toBeInTheDocument();
    expect(screen.queryByText(/834/)).toBeNull();
    expect(screen.queryByText(/BCBSTX834/)).toBeNull();
  });

  it('the SFTP form lives in the edit dialog; the page says “Delivery: SFTP, not connected · Set up”', async () => {
    ded.listCarriers.mockResolvedValue({ carriers: [carrier()], plans: [] });
    ded.updateCarrier.mockResolvedValue({ carrier: carrier() });
    ded.saveCarrierConnection.mockResolvedValue({ connection: { host: 'sftp.bcbstx.com', username: 'alto', remoteDir: null, baseUrl: null, hasSecret: true } });
    const user = userEvent.setup();
    renderAs('FINANCE_ACCOUNTANT', <CarrierFeeds />, '/benefits/carriers');
    expect(await screen.findByText(/Delivery: SFTP, not connected/)).toBeInTheDocument();
    expect(screen.queryByLabelText('SFTP host')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Set up' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('SFTP host'), 'sftp.bcbstx.com');
    await user.type(within(dialog).getByLabelText('Password'), 's3cret');
    await user.click(within(dialog).getByRole('button', { name: 'Save carrier' }));
    await waitFor(() => expect(ded.saveCarrierConnection).toHaveBeenCalledWith('k1', expect.objectContaining({ host: 'sftp.bcbstx.com', password: 's3cret', port: 22 })));
  });

  it('delivery words and results', () => {
    expect(deliveryWords({ transport: 'DOWNLOAD', connection: carrier().connection })).toEqual({ text: 'Delivery: download and upload by hand', needsSetup: false });
    expect(deliveryWords({ transport: 'SFTP', connection: { ...carrier().connection, host: 'sftp.x.com', hasSecret: true } })).toEqual({ text: 'Delivery: SFTP to sftp.x.com', needsSetup: false });
    expect(deliveryResult({ ...carrier().health!.lastFile!, status: 'GENERATED' })).toEqual({ label: 'Made, not sent', tone: 'warning' });
    expect(deliveryResult({ ...carrier().health!.lastFile!, status: 'SENT' }).label).toBe('Sent');
  });
});

describe('<AcaHours>', () => {
  const summary = {
    truncated: false,
    year: 2026,
    threshold: 130,
    counts: { measured: 4, fullTime: 2, approaching: 1, onTrack: 1, newHires: 0, crossingThreshold: 0, offersDue: 1, offersOverdue: 1 },
    exposure: { offeredShare: 50, a: 0, b: 5_010, failsNinetyFive: true, amounts: { a: 3_340, b: 5_010 }, fullTime: 2, offered: 1 },
    likelyAle: true,
    byClient: [],
  };
  beforeEach(() => {
    tax.getAcaSummary.mockResolvedValue(summary);
    tax.listAcaWorkers.mockResolvedValue({ truncated: false, fullTimeHoursPerMonth: 130, workers: [] });
  });

  it('“Penalty exposure”, not “Most at risk”', async () => {
    renderAs('FINANCE_ACCOUNTANT', <AcaHours />, '/benefits/aca');
    const strip = await screen.findByRole('group', { name: 'ACA at a glance' });
    await waitFor(() => expect(within(strip).getByText('Penalty exposure').parentElement).toHaveTextContent('$5,010.00'));
    expect(screen.queryByText('Most at risk')).toBeNull();
    expect(tileValue(within(strip).getByText('Offers owed'))).toBe('2');
    expect(within(strip).getByRole('button', { name: /Offers owed/ })).toHaveTextContent('1 past the stability start');
  });

  it('the Annual filing tab loads the year’s 1095-C months by itself — no “Load grid”, no trip to Lifecycle', async () => {
    const lastYear = new Date().getFullYear() - 1;
    life.get1095c.mockResolvedValue({ year: lastYear, employees: [{ associateId: 'a1', associateName: 'Fay Fulltime', months: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, offerOfCoverage: 'CODE_1E', lowestPremiumCents: null, safeHarbor: '2H', isFullTime: true })) }] });
    tax.syncAca1095c.mockResolvedValue({ year: lastYear, people: 1 });
    const user = userEvent.setup();
    renderAs('FINANCE_ACCOUNTANT', <AcaHours />, '/benefits/aca?tab=filing');
    expect(await screen.findByText(`1 person with months on file.`)).toBeInTheDocument();
    expect(life.get1095c).toHaveBeenCalledWith(lastYear);
    expect(screen.queryByRole('button', { name: /Load grid/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: `Write ${lastYear} months` }));
    await waitFor(() => expect(tax.syncAca1095c).toHaveBeenCalledWith(lastYear));
    expect(screen.queryByText(/Lifecycle/)).toBeNull();
  });
});

describe('<BenefitsLifecycle>', () => {
  it('counts what waits on each tab and opens on the first tab with work', async () => {
    life.listOpenEnrollment.mockResolvedValue({ windows: [{ id: 'w1', clientId: 'c1', clientName: 'Coastal', name: '2027 plan year', startsOn: '2026-11-01', endsOn: '2026-11-15', effectiveOn: '2027-01-01', status: 'OPEN', createdAt: '2026-10-01T00:00:00Z' }] });
    life.listQles.mockResolvedValue({ qles: [{ id: 'q1', associateId: 'a1', associateName: 'Ana Lee', kind: 'BIRTH', eventDate: '2026-10-01', allowedUntil: '2099-10-31', evidenceUrl: null, notes: null, status: 'PENDING', decidedAt: null, createdAt: '2026-10-02T00:00:00Z' }] });
    life.listCobra.mockResolvedValue({ offers: [] });
    renderAs('HR_ADMINISTRATOR', <BenefitsLifecycle />, '/benefits/lifecycle');
    const lifeTab = await screen.findByRole('tab', { name: /Life events/ });
    expect(lifeTab).toHaveAttribute('aria-selected', 'true');
    expect(lifeTab).toHaveTextContent('(1)');
    // An open window that hasn't ended yet isn't waiting on anyone.
    expect(screen.getByRole('tab', { name: /Open enrollment/ })).not.toHaveTextContent('(');
    expect(screen.getByRole('button', { name: /Record a life event/ })).toBeInTheDocument();
    expect(screen.queryByText(/QLE/)).toBeNull();
    expect(screen.queryByRole('tab', { name: /ACA/ })).toBeNull();
  });

  it('an old ?tab=aca link lands on ACA hours’ Annual filing', async () => {
    life.listOpenEnrollment.mockResolvedValue({ windows: [] });
    life.listQles.mockResolvedValue({ qles: [] });
    life.listCobra.mockResolvedValue({ offers: [] });
    renderAs(
      'HR_ADMINISTRATOR',
      <Routes>
        <Route path="/benefits/lifecycle" element={<BenefitsLifecycle />} />
        <Route path="*" element={<Where />} />
      </Routes>,
      '/benefits/lifecycle?tab=aca',
    );
    expect(await screen.findByTestId('where')).toHaveTextContent('/benefits/aca?tab=filing');
  });

  it('pending rules: drafts and windows past their end wait on HR; first tab in order wins', () => {
    const w = (status: 'DRAFT' | 'OPEN' | 'CLOSED', endsOn: string) => ({ id: endsOn + status, clientId: 'c', clientName: 'C', name: 'n', startsOn: '2026-01-01', endsOn, effectiveOn: '2026-02-01', status, createdAt: '' });
    const p = lifecyclePending({ windows: [w('DRAFT', '2026-12-01'), w('OPEN', '2026-10-01'), w('OPEN', '2026-12-31'), w('CLOSED', '2026-01-01')], qles: [], offers: [] }, '2026-10-22');
    expect(p).toEqual({ oe: 2, qle: 0, cobra: 0 });
    expect(firstPendingTab(p)).toBe('oe');
    expect(firstPendingTab({ oe: 0, qle: 0, cobra: 3 })).toBe('cobra');
    expect(firstPendingTab({})).toBe('oe');
  });
});
