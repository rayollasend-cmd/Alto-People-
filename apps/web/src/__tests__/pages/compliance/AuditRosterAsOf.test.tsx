import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/useClients', () => ({ useClients: () => ({ clients: [] }) }));
vi.mock('@/lib/csv', () => ({ downloadCsv: vi.fn() }));
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), apiFetch: vi.fn() }));

import { apiFetch } from '@/lib/api';
import { downloadCsv } from '@/lib/csv';
import { AuditPacketTab } from '@/pages/compliance/AuditPacketTab';

/**
 * The Audit packet tab's "Who was on the books on a day" (owner,
 * 2026-11-03): pick the day an I-9 inspection notice names, see everyone
 * employed then (people who left since included), download it as a CSV
 * with an Employment column and the day in the file name.
 */

const ROSTER = {
  date: '2026-06-15',
  generatedAt: '2026-11-03T15:00:00.000Z',
  total: 2,
  stillEmployed: 1,
  leftSince: 1,
  noSection2: 1,
  rows: [
    {
      associateId: 'a1',
      firstName: 'Ann',
      lastName: 'Able',
      workStatus: 'ACTIVE',
      employment: 'Working',
      hiredOn: '2025-01-10',
      separatedOn: null,
      section1On: '2025-01-10',
      section2On: '2025-01-12',
      eVerifyCaseNumber: '2025011200001AB',
      eVerifyStatus: 'EMPLOYMENT_AUTHORIZED',
      eVerifyStatusWords: 'Employment authorized',
      workAuthEndsOn: null,
      retainUntil: null,
    },
    {
      associateId: 'a2',
      firstName: 'Sam',
      lastName: 'Baker',
      workStatus: 'SEPARATED',
      employment: 'Separated',
      hiredOn: '2024-03-01',
      separatedOn: '2026-08-31',
      section1On: '2024-03-01',
      section2On: null,
      eVerifyCaseNumber: null,
      eVerifyStatus: null,
      eVerifyStatusWords: null,
      workAuthEndsOn: null,
      retainUntil: '2027-08-31',
    },
  ],
};

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AuditPacketTab />
    </QueryClientProvider>,
  );
}

describe('Audit packet — who was on the books on a day', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.mocked(downloadCsv).mockReset();
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      if (path === '/audit-packets/roster-as-of?date=2026-06-15') return ROSTER as never;
      throw new Error(`unmocked ${path}`);
    });
  });

  it('loads nothing until asked, then shows the day, the people and who has left since', async () => {
    renderTab();
    expect(apiFetch).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('On the books on'), { target: { value: '2026-06-15' } });
    fireEvent.click(screen.getByRole('button', { name: /Show who was on the books/ }));

    const summary = await screen.findByTestId('audit-roster-summary');
    expect(summary.textContent).toContain('2 people were on the books on');
    expect(summary.textContent).toContain('1 still employed, 1 left since');
    expect(summary.textContent).toContain('1 has no I-9 Section 2 on file');
    const table = screen.getByRole('table');
    expect(within(table).getByText('Able, Ann')).toBeInTheDocument();
    expect(within(table).getByText('Baker, Sam')).toBeInTheDocument();
    expect(within(table).getByText('While employed')).toBeInTheDocument();
    expect(within(table).getByText('Not on file')).toBeInTheDocument();
    expect(within(table).getByText('Employment authorized')).toBeInTheDocument();
  });

  it('downloads the CSV with an Employment column and the day in the file name', async () => {
    renderTab();
    fireEvent.change(screen.getByLabelText('On the books on'), { target: { value: '2026-06-15' } });
    fireEvent.click(screen.getByRole('button', { name: /Show who was on the books/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Download CSV/ }));

    expect(downloadCsv).toHaveBeenCalledTimes(1);
    const [filename, rows] = vi.mocked(downloadCsv).mock.calls[0]!;
    expect(filename).toBe('i9-roster-as-of-2026-06-15.csv');
    expect(rows[0]).toContain('Employment (today)');
    expect(rows[0]).toContain('Keep I-9 until');
    expect(rows[1]).toEqual(['Able', 'Ann', 'Working', '2025-01-10', null, '2025-01-10', '2025-01-12', '2025011200001AB', 'Employment authorized', null, 'While employed']);
    expect(rows[2]).toEqual(['Baker', 'Sam', 'Separated', '2024-03-01', '2026-08-31', '2024-03-01', null, null, null, null, '2027-08-31']);
  });
});
