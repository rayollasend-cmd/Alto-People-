import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { FileCheck2, Mail, ShieldAlert, UserX } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  ErrorBanner,
  PageHeader,
  Skeleton,
} from '@/components/ui';
import { DataGrid } from '@/components/ui/DataGrid';
import { ApiError } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import { useSelection } from '@/lib/useSelection';
import {
  emailW4Recollection,
  getW4Recollection,
  type W4RecollectionRow,
} from '@/lib/w4RecollectionApi';

/**
 * Remediation roster for the 2026-06-11 key-rotation incident: every
 * associate the campaign still needs something from — an unreadable
 * stored W-4 SSN, a missing SSN-card photo (once contacted), or both —
 * with a bulk request-email action. Rows disappear on their own the
 * moment both the number decrypts and a card image is on file — the
 * list draining to zero is the campaign finishing.
 */
export function W4SsnRecollection() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['w4-recollection'],
    queryFn: getW4Recollection,
  });

  const rows = useMemo(() => query.data?.rows ?? [], [query.data]);
  const summary = query.data?.summary ?? null;
  // Only rows with an active account can actually receive a useful email.
  const emailableIds = useMemo(
    () => rows.filter((r) => r.hasAccount).map((r) => r.associateId),
    [rows],
  );
  const { selected, clear: clearSelection, replace: replaceSelection, allSelected, toggleAll } = useSelection(emailableIds);

  const emailMutation = useMutation({
    mutationFn: (ids: string[]) => emailW4Recollection(ids),
    onSuccess: (result) => {
      const skippedNote =
        result.skipped.length > 0 ? ` (${result.skipped.length} skipped)` : '';
      toast.success(
        `Re-entry request emailed to ${result.queued} associate${result.queued === 1 ? '' : 's'}${skippedNote}.`,
      );
      clearSelection();
      void queryClient.invalidateQueries({ queryKey: ['w4-recollection'] });
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : 'Send failed.');
    },
  });

  const sendSelected = () => {
    if (selected.size === 0 || emailMutation.isPending) return;
    emailMutation.mutate(Array.from(selected));
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="W-4 SSN re-collection"
        subtitle="Each affected associate must re-enter their SSN on the W-4 step and upload a photo of their Social Security card — email them the request from here."
      />

      {query.error && (
        <ErrorBanner
          action={
            <Button size="sm" variant="secondary" onClick={() => void query.refetch()}>
              Retry
            </Button>
          }
        >
          {query.error instanceof ApiError
            ? query.error.message
            : 'Failed to load the re-collection roster.'}
        </ErrorBanner>
      )}

      {summary && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <SummaryCard
            label="Still outstanding"
            value={summary.outstanding}
            tone={summary.outstanding > 0 ? 'alert' : 'success'}
          />
          <SummaryCard label="Emailed at least once" value={summary.notified} tone="neutral" />
          <SummaryCard label="Resolved since first email" value={summary.resolved} tone="success" />
        </div>
      )}

      {query.isLoading ? (
        <Card>
          <CardContent className="pt-5 space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </CardContent>
        </Card>
      ) : rows.length === 0 && !query.error ? (
        <Card className="border-success/30 bg-success/5">
          <CardContent className="py-5 flex items-center gap-3">
            <FileCheck2 className="h-5 w-5 text-success shrink-0" aria-hidden="true" />
            <div>
              <div className="text-white font-medium">All SSNs and card photos are in</div>
              <div className="text-sm text-silver">
                Every stored W-4 Social Security number decrypts under the current key and
                every contacted associate has a card image on file. The campaign is complete.
              </div>
            </div>
          </CardContent>
        </Card>
      ) : rows.length > 0 ? (
        <Card>
          <CardContent className="pt-4">
            <div className="flex flex-wrap items-center justify-between gap-3 pb-4">
              <div className="text-sm text-silver">
                {selected.size > 0
                  ? `${selected.size} selected`
                  : `${rows.length} associate${rows.length === 1 ? '' : 's'} outstanding`}
              </div>
              <div className="flex items-center gap-2">
                <Button variant="secondary" size="sm" onClick={toggleAll}>
                  {allSelected ? 'Clear selection' : 'Select all emailable'}
                </Button>
                <Button
                  size="sm"
                  onClick={sendSelected}
                  disabled={selected.size === 0 || emailMutation.isPending}
                >
                  <Mail className="h-4 w-4 mr-1.5" aria-hidden="true" />
                  {emailMutation.isPending
                    ? 'Sending…'
                    : `Email re-entry request${selected.size > 0 ? ` (${selected.size})` : ''}`}
                </Button>
              </div>
            </div>

            <DataGrid<W4RecollectionRow>
              id="w4-recollection"
              caption="Associates still owing an SSN re-entry, a card photo, or both"
              rows={rows}
              rowKey={(r) => r.associateId}
              search={{ placeholder: 'Name, email…' }}
              urlState={false}
              exportCsv={{ filename: 'w4-recollection' }}
              selectable={{ disabled: (r) => !r.hasAccount, selection: { selected, onChange: replaceSelection } }}
              columns={[
                {
                  key: 'associate',
                  header: 'Associate',
                  accessor: (r) => `${r.firstName} ${r.lastName}`.trim(),
                  sortable: true,
                  primary: true,
                  cell: (r) => {
                    const name = `${r.firstName} ${r.lastName}`.trim();
                    return (
                      <>
                        {r.applicationId ? (
                          // New tab — a same-tab hop wiped the bulk-email checkbox
                          // selection; the roster (and its picks) stays put behind it.
                          <Link
                            to={`/onboarding/applications/${r.applicationId}`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-white hover:text-gold-bright"
                            title="Open the onboarding application in a new tab"
                          >
                            {name}
                          </Link>
                        ) : (
                          name
                        )}
                        {r.ssnLast4 && <span className="ml-2 font-mono text-xs text-silver">•••-••-{r.ssnLast4}</span>}
                      </>
                    );
                  },
                },
                {
                  key: 'email',
                  header: 'Email',
                  accessor: (r) => (r.hasAccount ? r.email : 'No active account'),
                  sortable: true,
                  cardMeta: true,
                  cell: (r) =>
                    r.hasAccount ? (
                      <span className="text-silver">{r.email ?? '—'}</span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 text-warning text-xs">
                        <UserX className="h-3.5 w-3.5" aria-hidden="true" />
                        No active account — re-invite first
                      </span>
                    ),
                },
                {
                  key: 'needed',
                  header: 'Still needed',
                  accessor: (r) => [r.needsNumber && 'Number', r.needsCard && 'Card photo'].filter(Boolean).join(', '),
                  sortable: true,
                  cardMeta: true,
                  cell: (r) => (
                    <div className="flex flex-wrap gap-1">
                      {r.needsNumber && <Badge variant="pending">Number</Badge>}
                      {r.needsCard && <Badge variant="pending">Card photo</Badge>}
                    </div>
                  ),
                },
                { key: 'w4', header: 'W-4 submitted', accessor: (r) => r.w4SubmittedAt, sortable: true, searchable: false, className: 'text-silver', cell: (r) => fmtDate(r.w4SubmittedAt) },
                {
                  key: 'shortcut',
                  header: 'Shortcut',
                  accessor: (r) => (r.hasSsnDocument ? 'Card on file' : null),
                  sortable: true,
                  searchable: false,
                  stopRowClick: true,
                  cell: (r) =>
                    r.hasSsnDocument ? (
                      // The badge IS the shortcut — straight to the profile's
                      // Documents tab (new tab, so the bulk-email selection survives)
                      // where the card image lives.
                      <Link
                        to={`/people?associateId=${r.associateId}&tab=documents`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
                        title="An SSN card or I-9 document image is on file — opens this associate's Documents tab in a new tab so you can view it and re-key the number without waiting on the associate."
                      >
                        <Badge variant="accent">
                          <ShieldAlert className="h-3 w-3 mr-1" aria-hidden="true" />
                          Card on file
                        </Badge>
                      </Link>
                    ) : (
                      <span className="text-silver text-xs">—</span>
                    ),
                },
                {
                  key: 'lastEmailed',
                  header: 'Last emailed',
                  accessor: (r) => r.lastEmailedAt,
                  csv: (r) => (r.lastEmailedAt ? `${fmtDate(r.lastEmailedAt)}${r.emailCount > 1 ? ` (×${r.emailCount})` : ''}` : 'Never'),
                  sortable: true,
                  searchable: false,
                  className: 'text-silver text-xs',
                  cell: (r) =>
                    r.lastEmailedAt ? (
                      <>
                        {fmtDate(r.lastEmailedAt)}
                        {r.emailCount > 1 && ` (×${r.emailCount})`}
                      </>
                    ) : (
                      'Never'
                    ),
                },
              ]}
            />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function SummaryCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'alert' | 'success' | 'neutral';
}) {
  const color =
    tone === 'alert' ? 'text-alert' : tone === 'success' ? 'text-success' : 'text-gold';
  return (
    <Card>
      <CardContent className="pt-5">
        <div className="text-xs2 font-medium uppercase tracking-[0.14em] text-silver/70">
          {label}
        </div>
        <div className={`font-display text-3xl tabular-nums mt-1 ${color}`}>{value}</div>
      </CardContent>
    </Card>
  );
}

