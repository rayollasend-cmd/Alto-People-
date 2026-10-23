import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderAs } from './hrPack/harness';
import type { MarketRow } from '@/lib/marketRatesApi';

const getMarketRates = vi.fn();
const getMarketMapping = vi.fn();
const setSiteArea = vi.fn();
const setPositionSoc = vi.fn();
const getMarketData = vi.fn();
const refreshMarketData = vi.fn();
const upsertRateDefault = vi.fn();
vi.mock('@/lib/marketRatesApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/marketRatesApi')>()),
  getMarketRates: (...a: unknown[]) => getMarketRates(...a),
  getMarketMapping: (...a: unknown[]) => getMarketMapping(...a),
  setSiteArea: (...a: unknown[]) => setSiteArea(...a),
  setPositionSoc: (...a: unknown[]) => setPositionSoc(...a),
  getMarketData: (...a: unknown[]) => getMarketData(...a),
  refreshMarketData: (...a: unknown[]) => refreshMarketData(...a),
  setClientMargin: vi.fn(),
  importOews: vi.fn(),
}));
vi.mock('@/lib/schedulingApi', () => ({ upsertRateDefault: (...a: unknown[]) => upsertRateDefault(...a) }));
vi.mock('@/lib/useClients', () => ({ useClients: () => ({ clients: [{ id: 'c1', name: 'Coastal Resorts' }] }) }));

import { MarketRatesHome } from '@/pages/market/MarketRatesHome';

const ROW: MarketRow = {
  key: 's1|stocker',
  clientId: 'c1',
  clientName: 'Coastal Resorts',
  siteId: 's1',
  siteName: 'Front Beach',
  position: 'Stocker',
  payRate: 14.5,
  billRate: 21,
  markupPct: 44.8,
  area: { code: '18880', name: 'Crestview-Fort Walton Beach-Destin, FL' },
  soc: { code: '53-7065', title: 'Stockers and Order Fillers' },
  market: { areaCode: '18880', areaName: 'Crestview-Fort Walton Beach-Destin, FL', socCode: '53-7065', socTitle: 'Stockers and Order Fillers', year: 2025, p10: 12.5, p25: 14, median: 16, p75: 18.5, p90: 21, source: 'BLS_OEWS', fetchedAt: '' },
  percentile: 31,
  gapToMedian: 1.5,
  fill: { shifts: 50, filled: 39, noShows: 2, fillRate: 0.78, noShowRate: 0.05 },
  recommendation: { payRate: 16, billRate: 23.89, reason: 'Pay $1.50 below the Crestview-Fort Walton Beach-Destin, FL median for stocker. Fill here is 78% against 93% where you pay at the median.', confidence: 'solid', marginPct: 25, marginSource: 'target' },
};

beforeEach(() => {
  vi.clearAllMocks();
  getMarketRates.mockResolvedValue({
    rows: [ROW],
    bands: { '53-7065': [{ band: 'below', shifts: 50, filled: 39, fillRate: 0.78, noShowRate: 0.05 }, { band: 'at', shifts: 120, filled: 112, fillRate: 0.93, noShowRate: 0.02 }, { band: 'above', shifts: 0, filled: 0, fillRate: null, noShowRate: null }] },
    truncated: false,
    summary: { rows: 1, priced: 1, unmapped: 0, belowMedian: 1, avgRatioToMedian: 0.906, lowestFill: 's1|stocker' },
  });
});

describe('<MarketRatesHome>', () => {
  it('shows where pay sits, the gap, fill, and proposes the suggested rate through the rate card', async () => {
    upsertRateDefault.mockResolvedValue({ pending: true, approvalId: 'a1', title: 't' });
    renderAs('HR_ADMINISTRATOR', <MarketRatesHome />, '/market-rates');
    expect((await screen.findAllByText('Front Beach')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('31st percentile').length).toBeGreaterThan(0);
    expect(screen.getAllByText('$1.50 under').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('img', { name: /median \$16\.00.*You pay \$14\.50, about the 31st percentile/ }).length).toBeGreaterThan(0);
    expect(screen.getByText('−9%')).toBeInTheDocument();
    // The fill chart says what it shows in words.
    expect(screen.getByRole('img', { name: /Stockers and Order Fillers: 78% filled below the median, 93% at it/ })).toBeInTheDocument();

    await userEvent.click(screen.getAllByRole('button', { name: /details for stocker at front beach/i })[0]!);
    expect(await screen.findByText(/Fill here is 78% against 93%/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /propose \$16\.00 pay · \$23\.89 bill/i }));
    await waitFor(() => expect(upsertRateDefault).toHaveBeenCalledWith({ clientId: 'c1', position: 'Stocker', payRate: 16, billRate: 23.89 }));
  });

  it('an executive reads it but proposes nothing and can’t change the mapping', async () => {
    getMarketMapping.mockResolvedValue({
      sites: [{ id: 's1', name: 'Front Beach', clientName: 'Coastal Resorts', place: null, zip: null, area: null, suggestion: { code: '18880', name: 'Crestview-Fort Walton Beach-Destin, FL', reason: 'zip 32541' } }],
      positions: [],
      catalog: { areas: [{ code: '18880', name: 'Crestview-Fort Walton Beach-Destin, FL', state: 'FL' }], occupations: [] },
    });
    renderAs('EXECUTIVE_CHAIRMAN', <MarketRatesHome />, '/market-rates');
    await userEvent.click((await screen.findAllByRole('button', { name: /details for stocker/i }))[0]!);
    expect(screen.queryByRole('button', { name: /propose/i })).toBeNull();
    await userEvent.click(screen.getByRole('radio', { name: 'Mapping' }));
    expect(await screen.findByLabelText('Metro for Front Beach')).toBeDisabled();
    expect(screen.queryByRole('button', { name: /use it/i })).toBeNull();
  });

  it('nothing benchmarked yet points to the mapping', async () => {
    getMarketRates.mockResolvedValue({ rows: [{ ...ROW, market: null, soc: null, percentile: null, gapToMedian: null, recommendation: null }], bands: {}, truncated: false, summary: { rows: 1, priced: 0, unmapped: 1, belowMedian: 0, avgRatioToMedian: null, lowestFill: null } });
    getMarketMapping.mockResolvedValue({ sites: [], positions: [], catalog: { areas: [], occupations: [] } });
    renderAs('HR_ADMINISTRATOR', <MarketRatesHome />, '/market-rates');
    expect(await screen.findByText(/Nothing is benchmarked yet/)).toBeInTheDocument();
    expect(screen.getAllByText('Role not mapped').length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: /map them/i }));
    expect(await screen.findByText('Roles and their occupation')).toBeInTheDocument();
  });

  it('mapping: one tap takes a suggestion, or all of them', async () => {
    getMarketMapping.mockResolvedValue({
      sites: [{ id: 's1', name: 'Front Beach', clientName: 'Coastal Resorts', place: 'Destin, FL', zip: '32541', area: null, suggestion: { code: '18880', name: 'Crestview-Fort Walton Beach-Destin, FL', reason: 'zip 32541' } }],
      positions: [{ key: 'stocker', name: 'Stocker', soc: null, suggestion: { code: '53-7065', title: 'Stockers and Order Fillers', reason: '“stocker” in the name' } }],
      catalog: { areas: [{ code: '18880', name: 'Crestview-Fort Walton Beach-Destin, FL', state: 'FL' }], occupations: [{ code: '53-7065', title: 'Stockers and Order Fillers' }] },
    });
    setSiteArea.mockResolvedValue({ ok: true });
    setPositionSoc.mockResolvedValue({ ok: true });
    renderAs('HR_ADMINISTRATOR', <MarketRatesHome />, '/market-rates?tab=mapping');
    expect(await screen.findByText(/from zip 32541/)).toBeInTheDocument();
    const stores = screen.getByText(/and their metro/).closest('div.space-y-4') as HTMLElement;
    await userEvent.click(within(stores).getByRole('button', { name: /use it/i }));
    await waitFor(() => expect(setSiteArea).toHaveBeenCalledWith('s1', '18880'));
    const roles = screen.getByText('Roles and their occupation').closest('div.space-y-4') as HTMLElement;
    await userEvent.click(within(roles).getByRole('button', { name: /use 1 suggestion/i }));
    await waitFor(() => expect(setPositionSoc).toHaveBeenCalledWith('Stocker', '53-7065'));
  });

  it('wage data: freshness, and refresh now', async () => {
    getMarketData.mockResolvedValue({ pairs: 2, covered: 1, missing: [{ areaCode: '18880', areaName: 'Crestview-Fort Walton Beach-Destin, FL', socCode: '35-9021', socTitle: 'Dishwashers' }], latestYear: 2025, lastFetchedAt: '2026-10-01T12:00:00Z', sources: ['BLS_OEWS'], apiKeyConfigured: false, refreshEveryHours: 168 });
    refreshMarketData.mockResolvedValue({ pairs: 2, fetched: 1, saved: 1, messages: [] });
    renderAs('HR_ADMINISTRATOR', <MarketRatesHome />, '/market-rates?tab=data');
    expect(await screen.findByText('1 of 2')).toBeInTheDocument();
    expect(screen.getByText('Dishwashers')).toBeInTheDocument();
    expect(screen.getByText(/without a BLS registration key/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /refresh now/i }));
    await waitFor(() => expect(refreshMarketData).toHaveBeenCalled());
  });

  it('one “Negotiation brief…” button opens a dialog with the client to pick (F500)', async () => {
    renderAs('HR_ADMINISTRATOR', <MarketRatesHome />, '/market-rates');
    await screen.findAllByText('Front Beach');
    // No select-plus-disabled-button pair in the header any more.
    expect(screen.queryByRole('combobox', { name: /negotiation brief/i })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /Negotiation brief/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Negotiation brief' });
    expect(within(dialog).getByRole('button', { name: 'Download the brief' })).toBeDisabled();
    await userEvent.selectOptions(within(dialog).getByLabelText('Client'), 'c1');
    expect(within(dialog).getByRole('link', { name: /Download Coastal Resorts’s brief/ })).toHaveAttribute('href', expect.stringContaining('c1'));
  });

  it('the client, store and role filters live in the URL', async () => {
    renderAs('HR_ADMINISTRATOR', <MarketRatesHome />, '/market-rates?client=c1&role=Stocker');
    await screen.findAllByText('Front Beach');
    await waitFor(() => expect(getMarketRates).toHaveBeenCalledWith({ clientId: 'c1' }));
    expect((screen.getByLabelText('Role') as HTMLSelectElement).value).toBe('Stocker');
  });
});

