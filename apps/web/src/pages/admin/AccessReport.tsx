import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, RefreshCw, ShieldAlert, UserX } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
import { fmtDate } from '@/lib/format';
import { ROLE_LABELS } from '@/lib/roles';
import {
  ACCESS_FLAGS,
  ACCESS_FLAG_LABEL,
  EMPLOYMENT_LABEL,
  deactivateUsers,
  downloadAccessReportCsv,
  getAccessReport,
  reactivateUser,
  type AccessFlag,
  type AccessReportRow,
  type UserStatus,
} from '@/lib/usersAdminApi';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
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
import { Input } from '@/components/ui/Input';
import { MetricCard } from '@/components/ui/MetricCard';

const STATUS_LABEL: Record<UserStatus, string> = { ACTIVE: 'Active', INVITED: 'Invited', DISABLED: 'Disabled' };
const DAY_MS = 86_400_000;

function daysLeft(purgeAfter: string): number {
  return Math.max(0, Math.ceil((new Date(purgeAfter).getTime() - Date.now()) / DAY_MS));
}

/**
 * Brief 1A-4 — the access report. Every account with its role, scope, last
 * sign-in, the employment record behind it and the flags; the counts
 * first, because the owner approves the list before anyone is
 * deactivated. Deactivation is bulk with a reason, audited per account,
 * and reversible for 30 days.
 */
export function AccessReport() {
  const { user: me, can } = useAuth();
  const canManage = can('manage:org');
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [flag, setFlag] = useState<AccessFlag | ''>('');
  const [deactivating, setDeactivating] = useState<{ ids: string[]; clear: () => void } | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const query = useQuery({ queryKey: ['UsersAdmin', 'access-report'], queryFn: getAccessReport });
  const report = query.data ?? null;
  const error = query.error ? (query.error instanceof ApiError ? query.error.message : 'Could not load the access report.') : null;
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['UsersAdmin'] });

  const rows = useMemo(() => {
    if (!report) return null;
    const list = flag ? report.rows.filter((r) => r.flags.includes(flag)) : report.rows;
    // Flagged first, then by email — the ones to look at are on top.
    return [...list].sort((a, b) => (b.flags.length > 0 ? 1 : 0) - (a.flags.length > 0 ? 1 : 0) || a.email.localeCompare(b.email));
  }, [report, flag]);

  const onReactivate = async (r: AccessReportRow) => {
    if (
      !(await confirm({
        title: `Reactivate ${r.email}?`,
        description: 'The account comes back exactly as it was. The deletion is cancelled.',
      }))
    ) {
      return;
    }
    setPendingId(r.id);
    try {
      const res = await reactivateUser(r.id);
      toast.success(res.status === 'INVITED' ? 'Reactivated — they never set a password, so the invite stands.' : 'Reactivated.');
      await refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not reactivate.');
    } finally {
      setPendingId(null);
    }
  };

  const columns: GridColumn<AccessReportRow>[] = [
    {
      key: 'email',
      header: 'Account',
      accessor: (r) => r.email,
      sortable: true,
      primary: true,
      cell: (r) => (
        <>
          <div className="flex flex-wrap items-center gap-1.5 text-white">
            <span className="break-all">{r.email}</span>
            {me?.id === r.id && <span className="text-xs text-gold">(you)</span>}
            {r.personalEmail && (
              <Badge variant={r.role === 'CLIENT_PORTAL' ? 'destructive' : 'default'} size="sm" withDot={false} title="A free-mail address, not a company one">
                personal
              </Badge>
            )}
          </div>
          {r.personName && <div className="text-xs text-silver">{r.personName}</div>}
        </>
      ),
    },
    { key: 'role', header: 'Role', accessor: (r) => ROLE_LABELS[r.role], sortable: true, cardMeta: true, className: 'text-xs' },
    {
      key: 'status',
      header: 'Status',
      accessor: (r) => STATUS_LABEL[r.status],
      sortable: true,
      cell: (r) => (
        <div className="space-y-1">
          <Badge variant={r.status === 'ACTIVE' ? 'success' : r.status === 'INVITED' ? 'pending' : 'destructive'}>{STATUS_LABEL[r.status]}</Badge>
          {r.purgeAfter && r.deactivatedAt && (
            <div className="text-xs text-silver">
              Deactivated {fmtDate(r.deactivatedAt)}
              {r.deactivationReason ? ` — ${r.deactivationReason}` : ''}
              <div className="text-warning">deletes {fmtDate(r.purgeAfter)} ({daysLeft(r.purgeAfter)} days)</div>
            </div>
          )}
        </div>
      ),
    },
    { key: 'scope', header: 'Scope', accessor: (r) => r.scope, sortable: true, className: 'text-xs text-silver' },
    { key: 'employment', header: 'Employment', accessor: (r) => EMPLOYMENT_LABEL[r.employment], sortable: true, className: 'text-xs text-silver', cardMeta: true },
    {
      key: 'lastSignIn',
      header: 'Last sign-in',
      accessor: (r) => r.lastSignInAt ?? '',
      csv: (r) => (r.lastSignInAt ? r.lastSignInAt.slice(0, 10) : 'never'),
      sortable: true,
      searchable: false,
      className: 'text-xs whitespace-nowrap tabular-nums',
      cell: (r) =>
        r.lastSignInAt ? (
          <span className={r.daysSinceSignIn !== null && r.daysSinceSignIn >= 90 ? 'text-warning' : 'text-silver'}>
            {fmtDate(r.lastSignInAt)} · {r.daysSinceSignIn}d
          </span>
        ) : (
          <span className="text-warning">never</span>
        ),
    },
    {
      key: 'flags',
      header: 'Flags',
      accessor: (r) => r.flags.map((f) => ACCESS_FLAG_LABEL[f]).join('; '),
      sortable: true,
      cell: (r) =>
        r.flags.length === 0 ? (
          <span className="text-xs text-silver/50">—</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {r.flags.map((f) => (
              <Badge key={f} variant={f === 'PENDING_DELETION' ? 'default' : 'pending'} size="sm" withDot={false}>
                {ACCESS_FLAG_LABEL[f]}
              </Badge>
            ))}
          </div>
        ),
    },
    {
      key: 'actions',
      header: 'Actions',
      accessor: () => null,
      searchable: false,
      csv: () => '',
      align: 'right',
      cell: (r) =>
        canManage && r.purgeAfter && r.deactivatedAt ? (
          <Button variant="ghost" size="sm" onClick={() => void onReactivate(r)} disabled={pendingId === r.id} loading={pendingId === r.id}>
            Reactivate
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="space-y-5">
      {report && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <MetricCard label="Accounts" value={report.counts.totalAccounts} hint={`${report.counts.byStatus.ACTIVE} active · ${report.counts.byStatus.INVITED} invited · ${report.counts.byStatus.DISABLED} disabled`} />
          <MetricCard label="Active associates" value={report.counts.activeAssociates} hint="The one definition of active" />
          <MetricCard label="Flagged accounts" value={report.counts.flaggedAccounts} accent={report.counts.flaggedAccounts > 0} hint="Review before anyone is deactivated" />
        </div>
      )}

      {report && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setFlag('')}
            aria-pressed={flag === ''}
            className={`min-h-[44px] rounded-md border px-3 text-xs ${flag === '' ? 'border-gold text-white' : 'border-navy-secondary text-silver hover:border-silver/40'}`}
          >
            All {report.counts.totalAccounts}
          </button>
          {ACCESS_FLAGS.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFlag(flag === f ? '' : f)}
              aria-pressed={flag === f}
              className={`min-h-[44px] rounded-md border px-3 text-xs ${flag === f ? 'border-gold text-white' : 'border-navy-secondary text-silver hover:border-silver/40'}`}
            >
              {ACCESS_FLAG_LABEL[f]} <span className="tabular-nums text-white">{report.counts.byFlag[f]}</span>
            </button>
          ))}
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={query.isFetching}>
              <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${query.isFetching ? 'animate-spin' : ''}`} aria-hidden="true" />
              Refresh
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => downloadAccessReportCsv().catch((err: unknown) => toast.error(err instanceof Error ? err.message : 'Download failed.'))}
            >
              <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              Download CSV
            </Button>
          </div>
        </div>
      )}

      {error && (
        <div className="space-y-3">
          <ErrorBanner>{error}</ErrorBanner>
          <Button size="sm" variant="secondary" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          <DataGrid<AccessReportRow>
            id="access-report"
            caption="Access report"
            rows={rows}
            columns={columns}
            rowKey={(r) => r.id}
            loading={query.isPending}
            urlState={false}
            exportCsv={false}
            empty={{
              icon: ShieldAlert,
              title: flag ? 'No account carries that flag' : 'No accounts',
              description: flag ? 'Pick another flag or show all.' : 'Accounts appear here as people are invited.',
            }}
            selectable={
              canManage
                ? {
                    disabled: (r) => r.id === me?.id || r.role === 'LIVE_ASN' || !!r.deactivatedAt,
                    actions: (ids, clear) => (
                      <Button variant="destructive" size="sm" onClick={() => setDeactivating({ ids, clear })}>
                        <UserX className="mr-1 h-3 w-3" aria-hidden="true" />
                        Deactivate selected
                      </Button>
                    ),
                  }
                : undefined
            }
          />
        </CardContent>
      </Card>

      {deactivating && (
        <DeactivateDialog
          count={deactivating.ids.length}
          onClose={() => setDeactivating(null)}
          onConfirm={async (reason) => {
            const res = await deactivateUsers(deactivating.ids, reason);
            const n = res.deactivated.length;
            if (res.skipped.length === 0) {
              toast.success(`${n} account${n === 1 ? '' : 's'} deactivated — reversible for 30 days.`);
            } else {
              toast.error(`${n} deactivated, ${res.skipped.length} skipped: ${res.skipped.map((s) => s.reason).join(' ')}`);
            }
            deactivating.clear();
            setDeactivating(null);
            await refresh();
          }}
        />
      )}
    </div>
  );
}

export function DeactivateDialog({ count, onClose, onConfirm }: { count: number; onClose: () => void; onConfirm: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const valid = reason.trim().length >= 3;
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()} confirmDiscard={() => reason.trim().length > 0}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Deactivate {count} account{count === 1 ? '' : 's'}?
          </DialogTitle>
          <DialogDescription>
            They are signed out at once and cannot sign in. The reason goes on every account's audit row. Reactivate within 30 days and everything comes back; after that the
            account is deleted.
          </DialogDescription>
        </DialogHeader>
        <Field label="Reason" hint="At least three characters. Shown to whoever reviews the audit log.">
          {(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Left the company in September" maxLength={300} autoFocus />}
        </Field>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            loading={busy}
            disabled={!valid || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm(reason.trim());
              } catch (err) {
                toast.error(err instanceof ApiError ? err.message : 'Could not deactivate.');
              } finally {
                setBusy(false);
              }
            }}
          >
            Deactivate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
