import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Download, FileSpreadsheet } from '@/components/ui/icons';
import { ApiError } from '@/lib/api';
import { useAuth, useTerm } from '@/lib/auth';
import { downloadCsv } from '@/lib/csv';
import { acaAirUrl, generate1095cForms, get1095c, type AcaEmployeeMonths } from '@/lib/benefitsLifecycle92Api';
import { syncAca1095c } from '@/lib/taxcompApi';
import { useUrlState, urlNumber } from '@/lib/useUrlState';
import { AssociateLink } from '@/components/ui/AssociateLink';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Input } from '@/components/ui/Input';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { TaxYearSelect } from '@/components/ui/TaxYearSelect';

/**
 * The 1095-C year-end filing, in one place (it used to be split: "Prepare
 * months" here ended with "go to Lifecycle", and Lifecycle's ACA tab had a
 * "Load grid" button of its own). For the chosen year, in order:
 *
 *   1. write each person's twelve months from the measurement;
 *   2. check the grid — it loads as soon as the year is picked;
 *   3. draft the 1095-C forms and the 1094-C transmittal;
 *   4. download the AIR file the filing partner transmits.
 */

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export function formatAcaCell(m: AcaEmployeeMonths['months'][number]): string {
  if (!m) return '—';
  const offer = m.offerOfCoverage?.replace('CODE_', '') ?? '—';
  const safe = m.safeHarbor ?? '—';
  return `${offer}/${safe}`;
}

/** An employee is "missing codes" when any month has no row or no offer code. */
export function hasMissingCodes(e: AcaEmployeeMonths): boolean {
  return e.months.some((m) => !m || !m.offerOfCoverage);
}

export function AcaFiling() {
  const term = useTerm();
  const qc = useQueryClient();
  const { can } = useAuth();
  const canFile = can('process:payroll');
  // The 1095-C reports the year just ended; the year is in the URL.
  const lastYear = new Date().getFullYear() - 1;
  const [year, setYear] = useUrlState<number>('year', lastYear, urlNumber({ min: 2015, max: lastYear + 1, integer: true }));
  const [nameFilter, setNameFilter] = useState('');
  const [missingOnly, setMissingOnly] = useState(false);
  const grid = useQuery({ queryKey: ['aca', '1095c', year], queryFn: () => get1095c(year) });
  const employees = grid.data?.employees ?? null;

  const prepare = useMutation({
    mutationFn: () => syncAca1095c(year),
    onSuccess: (r) => {
      toast.success(`${r.year} months written for ${r.people} ${r.people === 1 ? 'person' : 'people'}. Check the grid, then draft the forms.`);
      void qc.invalidateQueries({ queryKey: ['aca'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not write the months.'),
  });
  const generate = useMutation({
    mutationFn: () => generate1095cForms(year),
    onSuccess: (r) => toast.success(`${r.created} 1095-C form${r.created === 1 ? '' : 's'} drafted${r.skipped ? `, ${r.skipped} already on file` : ''}. Review and mark them filed in Payroll → Tax forms.`),
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not draft the forms.'),
  });

  const filtered = (employees ?? []).filter((e) => e.associateName.toLowerCase().includes(nameFilter.trim().toLowerCase()) && (!missingOnly || hasMissingCodes(e)));
  const missing = (employees ?? []).filter(hasMissingCodes).length;
  const exportCsv = () =>
    downloadCsv(`1095c-${year}.csv`, [[term('worker'), ...MONTHS_SHORT], ...filtered.map((e) => [e.associateName, ...e.months.map((m) => (m ? formatAcaCell(m) : ''))])]);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-ink-muted">
              Filing year
              <TaxYearSelect value={year} onChange={setYear} label="Filing year" span={5} />
            </label>
            <p className="text-sm text-ink-muted">
              {employees === null
                ? 'Loading the year…'
                : employees.length === 0
                  ? `No months written for ${year} yet.`
                  : `${employees.length} ${employees.length === 1 ? 'person' : 'people'} with months on file${missing ? ` · ${missing} missing a code` : ''}.`}
            </p>
          </div>
          <ol className="grid gap-2 text-sm sm:grid-cols-3">
            <li className="flex flex-col gap-2 rounded-lg border border-line p-3">
              <span className="font-medium text-ink">1. Write the months</span>
              <span className="text-xs text-ink-muted">Each person’s twelve months for {year}, from the measurement and the offers recorded.</span>
              {canFile && (
                <Button size="sm" variant="outline" className="mt-auto self-start" onClick={() => prepare.mutate()} loading={prepare.isPending}>
                  Write {year} months
                </Button>
              )}
            </li>
            <li className="flex flex-col gap-2 rounded-lg border border-line p-3">
              <span className="font-medium text-ink">2. Draft the forms</span>
              <span className="text-xs text-ink-muted">One 1095-C per person with months on file, plus the 1094-C. Anyone already on file is skipped.</span>
              {canFile && (
                <Button size="sm" variant="outline" className="mt-auto self-start" onClick={() => generate.mutate()} loading={generate.isPending} disabled={!employees?.length}>
                  Draft 1095-C forms
                </Button>
              )}
            </li>
            <li className="flex flex-col gap-2 rounded-lg border border-line p-3">
              <span className="font-medium text-ink">3. Download the AIR file</span>
              <span className="text-xs text-ink-muted">Your filing partner (or your own TCC) sends it to the IRS through AIR.</span>
              {canFile &&
                (employees?.length ? (
                  <Button size="sm" variant="outline" className="mt-auto self-start" asChild>
                    <a href={acaAirUrl(year)} download>
                      <Download className="h-4 w-4" aria-hidden="true" /> AIR file
                    </a>
                  </Button>
                ) : (
                  // Nothing to transmit until the year has months.
                  <Button size="sm" variant="outline" className="mt-auto self-start" disabled>
                    <Download className="h-4 w-4" aria-hidden="true" /> AIR file
                  </Button>
                ))}
            </li>
          </ol>
        </CardContent>
      </Card>

      {employees !== null && employees.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <Input className="w-64 max-w-full" aria-label={`Filter by ${term('worker').toLowerCase()} name`} placeholder="Filter by name…" value={nameFilter} onChange={(e) => setNameFilter(e.target.value)} />
          <label className="flex items-center gap-2 whitespace-nowrap text-sm text-ink-muted coarse:min-h-11">
            <input type="checkbox" className="h-4 w-4" checked={missingOnly} onChange={(e) => setMissingOnly(e.target.checked)} />
            Missing codes only
          </label>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={exportCsv}>
            <Download className="h-4 w-4" aria-hidden="true" /> Export CSV
          </Button>
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          {grid.isError ? (
            <div className="p-4">
              <ErrorBanner
                action={
                  <Button size="sm" variant="secondary" onClick={() => void grid.refetch()}>
                    Retry
                  </Button>
                }
              >
                {grid.error instanceof ApiError ? grid.error.message : 'Could not load the 1095-C months.'}
              </ErrorBanner>
            </div>
          ) : employees === null ? (
            <div className="p-6">
              <SkeletonRows count={3} />
            </div>
          ) : employees.length === 0 ? (
            <EmptyState
              icon={FileSpreadsheet}
              title={`No 1095-C months for ${year}`}
              description={canFile ? `Write the ${year} months above — they come from each person’s measurement and the offers recorded.` : 'Nothing is written for this year yet.'}
            />
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={FileSpreadsheet}
              title="No one matches"
              description={missingOnly ? 'Everyone matching your filter has a full set of codes.' : 'No names match your filter.'}
              action={
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setNameFilter('');
                    setMissingOnly(false);
                  }}
                >
                  Clear filters
                </Button>
              }
            />
          ) : (
            <>
              {/* Desktop: month-across, person-per-row — the 1095-C's own shape, so a year scans across. */}
              <div className="hidden overflow-x-auto md:block">
                <table className="min-w-max text-xs">
                  <caption className="sr-only">{`1095-C months, ${year}`}</caption>
                  <thead className="text-silver">
                    <tr>
                      <th scope="col" className="px-3 py-2 text-left">
                        {term('worker')}
                      </th>
                      {MONTHS_SHORT.map((mo) => (
                        <th key={mo} scope="col" className="px-2 py-2 text-left">
                          {mo}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="text-ink">
                    {filtered.map((e) => (
                      <tr key={e.associateId} className="border-t border-navy-secondary">
                        <td className="px-3 py-2 font-medium">
                          <AssociateLink associateId={e.associateId}>{e.associateName}</AssociateLink>
                        </td>
                        {e.months.map((m, i) => (
                          <td key={i} className="px-2 py-2 font-mono">
                            {formatAcaCell(m)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {/* Phone: a card per person, the twelve months as a grid — no sideways scroll. */}
              <ul className="divide-y divide-navy-secondary md:hidden">
                {filtered.map((e) => (
                  <li key={e.associateId} className="p-4">
                    <div className="mb-3 text-sm font-medium text-ink">{e.associateName}</div>
                    <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                      {e.months.map((m, i) => (
                        <div key={i} className="rounded border border-navy-secondary bg-navy-secondary/30 px-2 py-1.5">
                          <div className="text-2xs uppercase tracking-wider text-silver">{MONTHS_SHORT[i]}</div>
                          <div className="truncate font-mono text-xs text-ink">{formatAcaCell(m)}</div>
                        </div>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
