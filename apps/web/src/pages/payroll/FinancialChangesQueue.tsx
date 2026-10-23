import { useEffect, useState } from 'react';
import { nextInQueue } from '@/lib/queueNext';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Landmark, PhoneCall, ShieldAlert } from 'lucide-react';
import type { FinancialChangeRow } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useAuth, useRoleLabel } from '@/lib/auth';
import type { Role } from '@alto-people/shared';
import { fmtDateTime } from '@/lib/format';
import {
  holdFinancialChange,
  listFinancialChanges,
  rejectFinancialChange,
  verifyFinancialChange,
  type FinancialChangeFilter,
} from '@/lib/financialChangesApi';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { DataGrid } from '@/components/ui/DataGrid';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { ListTemplate } from '@/components/templates';
import { QueryError } from '@/components/ui/QueryError';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { useUrlParam } from '@/lib/useUrlState';
import { toast } from '@/components/ui/Toaster';

/** How the actor was signed in when they made the change, in plain words. */
const AUTH_STRENGTH_LABEL: Record<string, string> = {
  MFA: 'Two-step sign-in',
  PASSKEY: 'Passkey sign-in',
  PASSWORD: 'Password only',
  NAME_ONLY: 'Name only',
};
const authStrengthLabel = (s: string): string => AUTH_STRENGTH_LABEL[s] ?? sentenceCase(s);

/** How the change was verified. */
const VERIFIED_VIA_LABEL: Record<string, string> = {
  PHONE_CALL: 'by phone call',
  IN_PERSON: 'in person',
  NAME_ONLY: 'by name only',
  OTHER: 'another way',
  REJECTED: 'rejected',
};
const verifiedViaLabel = (s: string): string => VERIFIED_VIA_LABEL[s] ?? sentenceCase(s).toLowerCase();

function sentenceCase(code: string): string {
  const words = code.toLowerCase().replace(/_/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The Finance queue. Every change to how or to whom an associate is paid
 * — bank account, pay card, W-4, legal name, SSN/TIN, home address —
 * lands here the moment it is made, with what changed (masked), who did
 * it, from where, and the risk flags. A bank change is not used for
 * payroll until someone here verifies it by calling the associate on the
 * phone number that was on file BEFORE the change.
 */

const FILTER_VALUES: readonly FinancialChangeFilter[] = ['OPEN', 'PENDING', 'HELD', 'VERIFIED', 'REJECTED', 'ALL'];

/** The filter chips, with the counts that matter on the ones that wait on Finance. */
export function financialChangeFilters(counts: { pending: number; held: number }): Array<{ value: FinancialChangeFilter; label: string; count?: number }> {
  return [
    { value: 'OPEN', label: 'Waiting on Finance', count: counts.pending + counts.held },
    { value: 'PENDING', label: 'Needs verification', count: counts.pending },
    { value: 'HELD', label: 'Held', count: counts.held },
    { value: 'VERIFIED', label: 'Verified' },
    { value: 'REJECTED', label: 'Rejected' },
    { value: 'ALL', label: 'Last 90 days' },
  ];
}

function statusBadge(row: FinancialChangeRow) {
  switch (row.status) {
    case 'VERIFIED':
      return <Badge variant="success">Verified</Badge>;
    case 'REJECTED':
      return <Badge variant="destructive">Rejected</Badge>;
    case 'HELD':
      return <Badge variant="destructive">Held</Badge>;
    default:
      return <Badge variant="pending">Pending</Badge>;
  }
}

export function FinancialChangesQueue() {
  const [params, setParams] = useSearchParams();
  // The filter is in the URL (?filter=HELD), so a link and Back keep it.
  const [filter, setFilter] = useUrlParam<FinancialChangeFilter>('filter', 'OPEN', FILTER_VALUES);
  const [openId, setOpenId] = useState<string | null>(params.get('id'));
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ['FinancialChangesQueue', 'list', filter],
    queryFn: () => listFinancialChanges(filter),
    refetchInterval: 60_000,
  });
  const rows = query.data?.rows ?? [];
  const counts = query.data?.counts ?? { pending: 0, held: 0 };

  // A deep link from an alert opens the change directly.
  useEffect(() => {
    const id = params.get('id');
    if (id) setOpenId(id);
  }, [params]);

  const selected = rows.find((r) => r.id === openId) ?? null;
  const close = () => {
    setOpenId(null);
    if (params.get('id')) {
      params.delete('id');
      setParams(params, { replace: true });
    }
  };
  const refresh = () => void qc.invalidateQueries({ queryKey: ['FinancialChangesQueue'] });

  return (
    // Design system §4.2: the List template; the trail comes from the nav (Payroll › Financial changes).
    <ListTemplate
        title="Financial changes"
        subtitle="Every bank, pay card, W-4, name, SSN and address change, the moment it is made. A new pay account is not paid until Finance verifies it by phone."
    >
      <p className="text-sm text-ink-muted">
        Verification means calling the person on the phone number that was on file before the change, never one that was just added. Full
        account numbers and SSNs never appear here or in email.
      </p>
      {query.isError ? (
        <QueryError what="the financial changes" query={query} />
      ) : (
            <DataGrid<FinancialChangeRow>
              id="financial-changes"
              caption="Financial changes"
              noun={{ one: 'change', many: 'changes' }}
              rows={query.isPending ? null : rows}
              loading={query.isPending}
              rowKey={(row) => row.id}
              search={{ placeholder: 'Person, change, who…' }}
              urlKey="changes"
              onRowClick={(row) => setOpenId(row.id)}
              filters={
                // Counts on the chips, not as badges in the header (F500 G3).
                <SegmentedControl<FinancialChangeFilter>
                  ariaLabel="Show"
                  value={filter}
                  onChange={setFilter}
                  options={financialChangeFilters(counts)}
                />
              }
              activeFilters={filter === 'OPEN' ? 0 : 1}
              onClearFilters={() => setFilter('OPEN')}
              empty={
                filter === 'OPEN'
                  ? {
                      icon: Landmark,
                      title: 'No changes waiting on Finance',
                      description: 'Bank, W-4, name, SSN and address changes land here the moment they’re made.',
                    }
                  : { icon: Landmark, title: 'No changes here', description: 'Nothing in this view in the last 90 days.' }
              }
              columns={[
                {
                  key: 'associate',
                  header: 'Associate',
                  accessor: (row) => row.associate.name,
                  sortable: true,
                  primary: true,
                  className: 'font-medium text-ink',
                  cell: (row) => (
                    <>
                      {row.highRisk && <ShieldAlert className="mr-1 inline h-3.5 w-3.5 text-alert" aria-label="High risk" />}
                      {row.associate.name}
                      <div className="text-xs text-ink-muted">{row.kindLabel}</div>
                    </>
                  ),
                },
                {
                  key: 'change',
                  header: 'Change',
                  accessor: (row) => `${row.oldSummary ?? 'none'} → ${row.newSummary ?? 'none'}`,
                  cell: (row) => (
                    <div className="text-xs">
                      <div className="text-ink-muted line-through">{row.oldSummary ?? 'none on file'}</div>
                      <div className="text-ink">{row.newSummary ?? 'none on file'}</div>
                    </div>
                  ),
                },
                {
                  key: 'by',
                  header: 'By',
                  accessor: (row) => `${row.actor?.name ?? 'System'}${row.onBehalf ? ' (on behalf)' : ''}`,
                  sortable: true,
                  cardMeta: true,
                  cell: (row) => (
                    <div className="text-xs">
                      <div>{row.actor?.name ?? 'System'}</div>
                      <div className="text-ink-muted">
                        {row.onBehalf ? 'On behalf · ' : ''}
                        {authStrengthLabel(row.authStrength)}
                      </div>
                    </div>
                  ),
                },
                {
                  key: 'when',
                  header: 'When',
                  accessor: (row) => row.createdAt,
                  sortable: true,
                  cardMeta: true,
                  cell: (row) => <span className="text-xs">{fmtDateTime(row.createdAt)}</span>,
                },
                {
                  key: 'risk',
                  header: 'Risk',
                  accessor: (row) => row.riskLabels.join('; '),
                  sortable: true,
                  cell: (row) =>
                    row.riskLabels.length === 0 ? (
                      <span className="text-xs text-ink-muted">none</span>
                    ) : (
                      <ul className="space-y-0.5 text-xs text-warning">
                        {row.riskLabels.map((l) => (
                          <li key={l}>{l}</li>
                        ))}
                      </ul>
                    ),
                },
                {
                  key: 'status',
                  header: 'Status',
                  accessor: (row) => row.status,
                  sortable: true,
                  cardMeta: true,
                  cell: statusBadge,
                },
              ]}
            />
      )}

      <ChangeDialog
        change={selected}
        onClose={close}
        onChanged={refresh}
        // Verifying bank and pay-method changes is a run of decisions:
        // after each one, the next change still open, in list order.
        onDecided={() =>
          setOpenId(selected ? (nextInQueue(rows, selected.id, (r) => r.status === 'PENDING' || r.status === 'HELD')?.id ?? null) : null)
        }
      />
    </ListTemplate>
  );
}

function ChangeDialog({
  change,
  onClose,
  onChanged,
  onDecided,
}: {
  change: FinancialChangeRow | null;
  onClose: () => void;
  onChanged: () => void;
  /** After a decision: move to the next open change instead of closing. */
  onDecided?: () => void;
}) {
  const roleLabel = useRoleLabel();
  const { user } = useAuth();
  const [mode, setMode] = useState<'view' | 'verify' | 'reject' | 'hold'>('view');
  const [via, setVia] = useState<'PHONE_CALL' | 'IN_PERSON' | 'OTHER'>('PHONE_CALL');
  const [note, setNote] = useState('');
  const [reached, setReached] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setMode('view');
    setNote('');
    setReached(false);
    setVia('PHONE_CALL');
  }, [change?.id]);

  if (!change) return null;
  const open = change.status === 'PENDING' || change.status === 'HELD';
  const ownChange = change.actor?.id === user?.id;
  const gatesPay = change.kind === 'BANK_ACCOUNT' || change.kind === 'PAY_CARD' || change.kind === 'PAY_METHOD';

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(done);
      onChanged();
      if (onDecided) onDecided();
      else onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'That did not go through.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Landmark className="h-4 w-4 text-gold" />
            {change.associate.name} — {change.kindLabel}
          </DialogTitle>
          <DialogDescription>
            {change.onBehalf ? 'Made by an administrator on the associate’s behalf' : 'Made by the associate'} on{' '}
            {fmtDateTime(change.createdAt)}.
          </DialogDescription>
        </DialogHeader>

        <dl className="grid grid-cols-[120px_1fr] gap-y-2 text-sm">
          <dt className="text-ink-muted">Before</dt>
          <dd className="text-ink">{change.oldSummary ?? 'none on file'}</dd>
          <dt className="text-ink-muted">After</dt>
          <dd className="text-ink">{change.newSummary ?? 'none on file'}</dd>
          <dt className="text-ink-muted">By</dt>
          <dd>
            {change.actor?.name ?? 'System'}
            {change.actor?.role ? <span className="text-ink-muted"> · {roleLabel(change.actor.role as Role)}</span> : null}
          </dd>
          <dt className="text-ink-muted">Sign-in</dt>
          <dd>
            {change.authStrength === 'MFA' || change.authStrength === 'PASSKEY' ? (
              <Badge variant="success">{authStrengthLabel(change.authStrength)}</Badge>
            ) : (
              <Badge variant="pending">{authStrengthLabel(change.authStrength)}</Badge>
            )}
          </dd>
          <dt className="text-ink-muted">Device</dt>
          <dd className="break-all text-xs text-ink-muted">
            {change.ip ?? 'unknown IP'}
            {change.userAgent ? ` · ${change.userAgent}` : ''}
          </dd>
          <dt className="text-ink-muted">Risk</dt>
          <dd>
            {change.riskLabels.length === 0 ? (
              <span className="text-ink-muted">none</span>
            ) : (
              <ul className="space-y-0.5 text-warning">
                {change.riskLabels.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            )}
          </dd>
          <dt className="text-ink-muted">Status</dt>
          <dd className="flex items-center gap-2">
            {statusBadge(change)}
            {change.verifiedBy && (
              <span className="text-xs text-ink-muted">
                by {change.verifiedBy.name} · {fmtDateTime(change.verifiedAt)}
                {change.verifiedVia ? ` · ${verifiedViaLabel(change.verifiedVia)}` : ''}
              </span>
            )}
          </dd>
          {change.verificationNote && (
            <>
              <dt className="text-ink-muted">Note</dt>
              <dd className="text-xs">{change.verificationNote}</dd>
            </>
          )}
          <dt className="text-ink-muted">Told</dt>
          <dd className="text-xs text-ink-muted">
            Finance {change.financeNotifiedAt ? fmtDateTime(change.financeNotifiedAt) : 'not yet'} · associate{' '}
            {change.associateNotifiedAt ? fmtDateTime(change.associateNotifiedAt) : 'not yet'}
            {change.priorContactNotifiedAt ? ` · previous email ${fmtDateTime(change.priorContactNotifiedAt)}` : ''}
          </dd>
        </dl>

        {open && (
          <div className="flex items-start gap-2 rounded-md border border-gold/40 bg-gold/[0.07] p-3 text-xs">
            <PhoneCall className="mt-0.5 h-4 w-4 shrink-0 text-gold" />
            <div>
              <div className="font-medium text-ink">
                Call the associate on the number that was on file before this change
                {change.verifyPhoneLast4 ? ` (ending ${change.verifyPhoneLast4})` : ''}.
              </div>
              <div className="mt-0.5 text-ink-muted">
                Never a number that was just added. Confirm the change in their own words before verifying.
                {gatesPay ? ' Until then payroll pays the previous verified account or holds the pay, per your setting.' : ''}
              </div>
            </div>
          </div>
        )}

        {mode === 'verify' && (
          <div className="space-y-3">
            <Field label="How you verified">
              {(p) => (
                <Select value={via} onChange={(e) => setVia(e.target.value as typeof via)} {...p}>
                  <option value="PHONE_CALL">Phone call to the number on file</option>
                  <option value="IN_PERSON">In person</option>
                  <option value="OTHER">Other (say how in the note)</option>
                </Select>
              )}
            </Field>
            <Field label="Note (optional)">
              {(p) => <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} {...p} />}
            </Field>
            <label className="flex cursor-pointer items-start gap-2 text-xs text-ink-muted">
              <input
                type="checkbox"
                checked={reached}
                onChange={(e) => setReached(e.target.checked)}
                className="mt-0.5 h-3.5 w-3.5 rounded border-navy-secondary bg-navy text-gold focus:ring-gold focus:ring-offset-0"
              />
              <span>I reached the associate on the number that was on file before the change, and they confirmed it.</span>
            </label>
          </div>
        )}
        {(mode === 'reject' || mode === 'hold') && (
          <Field label={mode === 'reject' ? 'Why it is rejected' : 'Why it is held'}>
            {(p) => <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} {...p} />}
          </Field>
        )}

        <DialogFooter>
          {mode === 'view' && (
            <>
              <Button variant="ghost" onClick={onClose}>
                Close
              </Button>
              {open && change.status === 'PENDING' && (
                <Button variant="outline" onClick={() => setMode('hold')}>
                  Hold
                </Button>
              )}
              {open && (
                <Button variant="outline" onClick={() => setMode('reject')}>
                  Reject
                </Button>
              )}
              {open && (
                <Button onClick={() => setMode('verify')} disabled={ownChange} title={ownChange ? 'You made this change' : undefined}>
                  Verify
                </Button>
              )}
            </>
          )}
          {mode === 'verify' && (
            <>
              <Button variant="ghost" onClick={() => setMode('view')} disabled={busy}>
                Back
              </Button>
              <Button
                loading={busy}
                disabled={!reached}
                onClick={() =>
                  void run(
                    () => verifyFinancialChange(change.id, { via, note: note.trim() || null, reachedOnNumberOnFile: true }),
                    'Verified. Payroll may use it now.',
                  )
                }
              >
                Mark verified
              </Button>
            </>
          )}
          {mode === 'reject' && (
            <>
              <Button variant="ghost" onClick={() => setMode('view')} disabled={busy}>
                Back
              </Button>
              <Button
                variant="destructive"
                loading={busy}
                disabled={note.trim().length < 3}
                onClick={() => void run(() => rejectFinancialChange(change.id, note.trim()), 'Rejected. The previous account is restored.')}
              >
                Reject change
              </Button>
            </>
          )}
          {mode === 'hold' && (
            <>
              <Button variant="ghost" onClick={() => setMode('view')} disabled={busy}>
                Back
              </Button>
              <Button
                loading={busy}
                disabled={note.trim().length < 3}
                onClick={() => void run(() => holdFinancialChange(change.id, note.trim()), 'Held. Payroll will not pay the new account.')}
              >
                Hold
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default FinancialChangesQueue;
