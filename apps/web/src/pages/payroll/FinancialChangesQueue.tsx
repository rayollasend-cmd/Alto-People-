import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Landmark, PhoneCall, ShieldAlert } from 'lucide-react';
import type { FinancialChangeRow } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
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
import { Card, CardContent } from '@/components/ui/Card';
import { DataGrid } from '@/components/ui/DataGrid';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Field } from '@/components/ui/Field';
import { Textarea } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { toast } from '@/components/ui/Toaster';

/**
 * The Finance queue. Every change to how or to whom an associate is paid
 * — bank account, pay card, W-4, legal name, SSN/TIN, home address —
 * lands here the moment it is made, with what changed (masked), who did
 * it, from where, and the risk flags. A bank change is not used for
 * payroll until someone here verifies it by calling the associate on the
 * phone number that was on file BEFORE the change.
 */

const FILTERS: Array<{ value: FinancialChangeFilter; label: string }> = [
  { value: 'OPEN', label: 'Needs Finance (pending + held)' },
  { value: 'HELD', label: 'Held' },
  { value: 'PENDING', label: 'Pending verification' },
  { value: 'VERIFIED', label: 'Verified' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'ALL', label: 'Everything (90 days)' },
];

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
  const [filter, setFilter] = useState<FinancialChangeFilter>('OPEN');
  const [openId, setOpenId] = useState<string | null>(params.get('id'));
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ['FinancialChangesQueue', 'list', filter],
    queryFn: () => listFinancialChanges(filter),
    refetchInterval: 60_000,
  });
  const rows = query.data?.rows ?? [];
  const counts = query.data?.counts ?? { pending: 0, held: 0 };
  const error = query.error ? (query.error instanceof ApiError ? query.error.message : 'Failed to load.') : null;

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
    <div className="space-y-5">
      <PageHeader
        title="Financial changes"
        subtitle="Every bank, pay card, W-4, name, SSN and address change, the moment it is made. A new pay account is not paid until Finance verifies it by phone."
        breadcrumbs={[{ label: 'Payroll' }, { label: 'Financial changes' }]}
        secondaryActions={
          <div className="flex items-center gap-2">
            <Badge variant={counts.held > 0 ? 'destructive' : 'default'}>{counts.held} held</Badge>
            <Badge variant={counts.pending > 0 ? 'pending' : 'default'}>{counts.pending} pending</Badge>
          </div>
        }
      />

      {error && (
        <Card>
          <CardContent className="py-4">
            <ErrorBanner>{error}</ErrorBanner>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="space-y-4 py-4">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Show" className="min-w-[260px]">
              {(p) => (
                <Select value={filter} onChange={(e) => setFilter(e.target.value as FinancialChangeFilter)} {...p}>
                  {FILTERS.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <p className="text-xs text-silver">
              Verification means calling the associate on the phone number that was on file before the change,
              never one that was just added. Full account numbers and SSNs never appear here or in email.
            </p>
          </div>

          {query.isPending ? (
            <Skeleton className="h-40" />
          ) : rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-silver">Nothing here. New changes appear the moment they are made.</p>
          ) : (
            <DataGrid<FinancialChangeRow>
              id="financial-changes"
              caption="Financial changes"
              rows={rows}
              rowKey={(row) => row.id}
              search={{ placeholder: 'Associate, change, who…' }}
              urlState={false}
              onRowClick={(row) => setOpenId(row.id)}
              columns={[
                {
                  key: 'associate',
                  header: 'Associate',
                  accessor: (row) => row.associate.name,
                  sortable: true,
                  primary: true,
                  className: 'font-medium text-white',
                  cell: (row) => (
                    <>
                      {row.highRisk && <ShieldAlert className="mr-1 inline h-3.5 w-3.5 text-alert" aria-label="High risk" />}
                      {row.associate.name}
                      <div className="text-xs text-silver">{row.kindLabel}</div>
                    </>
                  ),
                },
                {
                  key: 'change',
                  header: 'Change',
                  accessor: (row) => `${row.oldSummary ?? 'none'} → ${row.newSummary ?? 'none'}`,
                  cell: (row) => (
                    <div className="text-xs">
                      <div className="text-silver line-through">{row.oldSummary ?? 'none on file'}</div>
                      <div className="text-white">{row.newSummary ?? 'none on file'}</div>
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
                      <div className="text-silver">
                        {row.onBehalf ? 'On behalf · ' : ''}
                        {row.authStrength === 'MFA' || row.authStrength === 'PASSKEY' ? `${row.authStrength} sign-in` : row.authStrength.toLowerCase()}
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
                      <span className="text-xs text-silver">none</span>
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
        </CardContent>
      </Card>

      <ChangeDialog change={selected} onClose={close} onChanged={refresh} />
    </div>
  );
}

function ChangeDialog({
  change,
  onClose,
  onChanged,
}: {
  change: FinancialChangeRow | null;
  onClose: () => void;
  onChanged: () => void;
}) {
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
      onClose();
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
          <dt className="text-silver">Before</dt>
          <dd className="text-white">{change.oldSummary ?? 'none on file'}</dd>
          <dt className="text-silver">After</dt>
          <dd className="text-white">{change.newSummary ?? 'none on file'}</dd>
          <dt className="text-silver">By</dt>
          <dd>
            {change.actor?.name ?? 'System'}
            {change.actor?.role ? <span className="text-silver"> · {change.actor.role.replace(/_/g, ' ').toLowerCase()}</span> : null}
          </dd>
          <dt className="text-silver">Sign-in</dt>
          <dd>
            {change.authStrength === 'MFA' || change.authStrength === 'PASSKEY' ? (
              <Badge variant="success">{change.authStrength}</Badge>
            ) : (
              <Badge variant="pending">{change.authStrength.toLowerCase()}</Badge>
            )}
          </dd>
          <dt className="text-silver">Device</dt>
          <dd className="break-all text-xs text-silver">
            {change.ip ?? 'unknown IP'}
            {change.userAgent ? ` · ${change.userAgent}` : ''}
          </dd>
          <dt className="text-silver">Risk</dt>
          <dd>
            {change.riskLabels.length === 0 ? (
              <span className="text-silver">none</span>
            ) : (
              <ul className="space-y-0.5 text-warning">
                {change.riskLabels.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            )}
          </dd>
          <dt className="text-silver">Status</dt>
          <dd className="flex items-center gap-2">
            {statusBadge(change)}
            {change.verifiedBy && (
              <span className="text-xs text-silver">
                by {change.verifiedBy.name} · {fmtDateTime(change.verifiedAt)}
                {change.verifiedVia ? ` · ${change.verifiedVia.replace(/_/g, ' ').toLowerCase()}` : ''}
              </span>
            )}
          </dd>
          {change.verificationNote && (
            <>
              <dt className="text-silver">Note</dt>
              <dd className="text-xs">{change.verificationNote}</dd>
            </>
          )}
          <dt className="text-silver">Told</dt>
          <dd className="text-xs text-silver">
            Finance {change.financeNotifiedAt ? fmtDateTime(change.financeNotifiedAt) : 'not yet'} · associate{' '}
            {change.associateNotifiedAt ? fmtDateTime(change.associateNotifiedAt) : 'not yet'}
            {change.priorContactNotifiedAt ? ` · previous email ${fmtDateTime(change.priorContactNotifiedAt)}` : ''}
          </dd>
        </dl>

        {open && (
          <div className="flex items-start gap-2 rounded-md border border-gold/40 bg-gold/[0.07] p-3 text-xs">
            <PhoneCall className="mt-0.5 h-4 w-4 shrink-0 text-gold" />
            <div>
              <div className="font-medium text-white">
                Call the associate on the number that was on file before this change
                {change.verifyPhoneLast4 ? ` (ending ${change.verifyPhoneLast4})` : ''}.
              </div>
              <div className="mt-0.5 text-silver">
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
            <label className="flex cursor-pointer items-start gap-2 text-xs text-silver">
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
