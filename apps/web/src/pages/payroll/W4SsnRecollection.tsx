import { useMemo, useState } from 'react';
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui';
import { ApiError } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import {
  emailW4Recollection,
  getW4Recollection,
  type W4RecollectionRow,
} from '@/lib/w4RecollectionApi';

/**
 * Remediation roster for the 2026-06-11 key-rotation incident: every
 * associate whose stored W-4 SSN no longer decrypts, with a bulk
 * "please re-enter it" email action. Rows disappear on their own the
 * moment an associate resubmits — the list draining to zero is the
 * campaign finishing.
 */
export function W4SsnRecollection() {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const query = useQuery({
    queryKey: ['w4-recollection'],
    queryFn: getW4Recollection,
  });

  const emailMutation = useMutation({
    mutationFn: (ids: string[]) => emailW4Recollection(ids),
    onSuccess: (result) => {
      const skippedNote =
        result.skipped.length > 0 ? ` (${result.skipped.length} skipped)` : '';
      toast.success(
        `Re-entry request emailed to ${result.queued} associate${result.queued === 1 ? '' : 's'}${skippedNote}.`,
      );
      setSelected(new Set());
      void queryClient.invalidateQueries({ queryKey: ['w4-recollection'] });
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : 'Send failed.');
    },
  });

  const rows = useMemo(() => query.data?.rows ?? [], [query.data]);
  const summary = query.data?.summary ?? null;
  // Only rows with an active account can actually receive a useful email.
  const emailableIds = useMemo(
    () => rows.filter((r) => r.hasAccount).map((r) => r.associateId),
    [rows],
  );
  const allSelected =
    emailableIds.length > 0 && emailableIds.every((id) => selected.has(id));

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(emailableIds));
  };
  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const sendSelected = () => {
    if (selected.size === 0 || emailMutation.isPending) return;
    emailMutation.mutate(Array.from(selected));
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="W-4 SSN re-collection"
        subtitle="Stored Social Security numbers that no longer decrypt after the June 11 encryption-key incident. Each associate must re-enter their SSN on the W-4 step — email them the request from here."
      />

      {query.error && (
        <ErrorBanner>
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
              <div className="text-white font-medium">All SSNs are readable again</div>
              <div className="text-sm text-silver">
                Every stored W-4 Social Security number decrypts under the current key. The
                campaign is complete.
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

            <Table caption="Associates whose stored W-4 SSN cannot be decrypted">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <input
                      type="checkbox"
                      aria-label="Select all emailable associates"
                      checked={allSelected}
                      onChange={toggleAll}
                    />
                  </TableHead>
                  <TableHead>Associate</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>W-4 submitted</TableHead>
                  <TableHead>Shortcut</TableHead>
                  <TableHead>Last emailed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <RosterRow
                    key={r.associateId}
                    row={r}
                    checked={selected.has(r.associateId)}
                    onToggle={() => toggleOne(r.associateId)}
                  />
                ))}
              </TableBody>
            </Table>
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
        <div className="text-[10px] uppercase tracking-widest text-silver">{label}</div>
        <div className={`font-display text-3xl tabular-nums mt-1 ${color}`}>{value}</div>
      </CardContent>
    </Card>
  );
}

function RosterRow({
  row,
  checked,
  onToggle,
}: {
  row: W4RecollectionRow;
  checked: boolean;
  onToggle: () => void;
}) {
  const name = `${row.firstName} ${row.lastName}`.trim();
  return (
    <TableRow data-state={checked ? 'selected' : undefined}>
      <TableCell>
        <input
          type="checkbox"
          aria-label={`Select ${name}`}
          checked={checked}
          disabled={!row.hasAccount}
          onChange={onToggle}
        />
      </TableCell>
      <TableCell>
        {row.applicationId ? (
          <Link
            to={`/onboarding/applications/${row.applicationId}`}
            className="text-white hover:text-gold-bright"
          >
            {name}
          </Link>
        ) : (
          name
        )}
        {row.ssnLast4 && (
          <span className="ml-2 font-mono text-xs text-silver">•••-••-{row.ssnLast4}</span>
        )}
      </TableCell>
      <TableCell>
        {row.hasAccount ? (
          <span className="text-silver">{row.email ?? '—'}</span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-warning text-xs">
            <UserX className="h-3.5 w-3.5" aria-hidden="true" />
            No active account — re-invite first
          </span>
        )}
      </TableCell>
      <TableCell className="text-silver">{fmtDate(row.w4SubmittedAt)}</TableCell>
      <TableCell>
        {row.hasSsnDocument ? (
          <Badge
            variant="accent"
            title="An SSN card or I-9 document image is on file — open Documents to view it and re-key the number without waiting on the associate."
          >
            <ShieldAlert className="h-3 w-3 mr-1" aria-hidden="true" />
            Card on file
          </Badge>
        ) : (
          <span className="text-silver text-xs">—</span>
        )}
      </TableCell>
      <TableCell className="text-silver text-xs">
        {row.lastEmailedAt ? (
          <>
            {fmtDate(row.lastEmailedAt)}
            {row.emailCount > 1 && ` (×${row.emailCount})`}
          </>
        ) : (
          'Never'
        )}
      </TableCell>
    </TableRow>
  );
}
