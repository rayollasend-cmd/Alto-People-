import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { FileCheck2, Mail, ShieldAlert, UserX } from '@/components/ui/icons';
import {
  Badge,
  Button,
  Card,
  CardContent,
  Skeleton,
} from '@/components/ui';
import { MetricCard } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { QueryError } from '@/components/ui/QueryError';
import { DataGrid } from '@/components/ui/DataGrid';
import { ApiError } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import { useSelection } from '@/lib/useSelection';
import { ListTemplate } from '@/components/templates';
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
        `Re-entry request emailed to ${result.queued} ${result.queued === 1 ? 'person' : 'people'}${skippedNote}.`,
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
    // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
    // The trail comes from the nav (Payroll › …); the page is reached from the admin home while the campaign runs.
    <ListTemplate
        title="W-4 SSN re-collection"
        subtitle="Each person affected re-enters their Social Security number on the W-4 step and uploads a photo of their card. Email them the request from here."
    >

      {query.error && <QueryError what="the re-collection list" query={query} />}

      {summary && (
        // One tone rule for every tile: colour only for something to act on, never for a zero (F500 G3).
        <MetricStrip label="Re-collection">
          <MetricCard
            label="Still outstanding"
            value={summary.outstanding}
            nothing={summary.outstanding === 0 ? 'Nobody outstanding' : undefined}
            tone={summary.outstanding > 0 ? 'alert' : 'default'}
          />
          <MetricCard label="Emailed at least once" value={summary.notified} />
          <MetricCard label="Resolved since first email" value={summary.resolved} />
        </MetricStrip>
      )}

      {query.isLoading ? (
        <Card>
          <CardContent className="space-y-3">
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
              <div className="text-ink font-medium">All Social Security numbers and card photos are in</div>
              <div className="text-sm text-ink-muted">
                Everyone affected has re-entered their number, and everyone contacted has a card photo on file. The campaign is complete.
              </div>
            </div>
          </CardContent>
        </Card>
      ) : rows.length > 0 ? (
        <Card>
          <CardContent>
            <div className="flex flex-wrap items-center justify-between gap-3 pb-4">
              <div className="text-sm text-ink-muted">
                {selected.size > 0
                  ? `${selected.size} selected`
                  : `${rows.length} ${rows.length === 1 ? 'person' : 'people'} outstanding`}
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
              caption="People still owing an SSN re-entry, a card photo, or both"
              rows={rows}
              rowKey={(r) => r.associateId}
              search={{ placeholder: 'Name, email…' }}
              urlState={false}
              exportCsv={{ filename: 'w4-recollection' }}
              selectable={{ disabled: (r) => !r.hasAccount, selection: { selected, onChange: replaceSelection } }}
              columns={[
                {
                  key: 'associate',
                  header: 'Name',
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
                            className="text-ink hover:text-gold-bright"
                            title="Open the onboarding application in a new tab"
                          >
                            {name}
                          </Link>
                        ) : (
                          name
                        )}
                        {r.ssnLast4 && <span className="ml-2 font-mono text-xs text-ink-muted">•••-••-{r.ssnLast4}</span>}
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
                      <span className="text-ink-muted">{r.email ?? '—'}</span>
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
                { key: 'w4', header: 'W-4 submitted', accessor: (r) => r.w4SubmittedAt, sortable: true, searchable: false, className: 'text-ink-muted', cell: (r) => fmtDate(r.w4SubmittedAt) },
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
                        title="An SSN card or I-9 image is on file. Opens their Documents tab in a new tab, so you can read the number from it without waiting on them."
                      >
                        <Badge variant="accent">
                          <ShieldAlert className="h-3 w-3 mr-1" aria-hidden="true" />
                          Card on file
                        </Badge>
                      </Link>
                    ) : (
                      <span className="text-ink-muted text-xs">—</span>
                    ),
                },
                {
                  key: 'lastEmailed',
                  header: 'Last emailed',
                  accessor: (r) => r.lastEmailedAt,
                  csv: (r) => (r.lastEmailedAt ? `${fmtDate(r.lastEmailedAt)}${r.emailCount > 1 ? ` (×${r.emailCount})` : ''}` : 'Never'),
                  sortable: true,
                  searchable: false,
                  className: 'text-ink-muted text-xs',
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
    </ListTemplate>
  );
}
